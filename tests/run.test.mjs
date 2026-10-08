import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 端到端：真起一个 run.mjs（§9、§3）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'examples');
const TEMPLATES = path.join(ROOT, 'templates');

const TMP = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-run-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const tmpDir = () => {
  const d = path.join(TMP, `p${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// 默认不带 AGENTFLOW_HOME：HOME 靠往上找 .workflow/
function cli(argv, { cwd = ROOT, env = {} } = {}) {
  const base = { ...process.env };
  for (const k of ['AGENTFLOW_HOME', 'AGENTFLOW_AGENT_CMD', 'AGENTFLOW_AGENT', 'AGENTFLOW_DRY_RUN', 'AGENTFLOW_TASK', 'AGENTFLOW_RUN_ID', 'AGENTFLOW_YES']) {
    delete base[k];
  }
  // 测试目录在 os.tmpdir() 下；若跑测试的机器上 $HOME 恰好是 Git 仓库（dotfiles），
  // `git rev-parse --show-toplevel` 会往上串到 $HOME，测的就不是当前目录了。
  // 用 GIT_CEILING_DIRECTORIES 把 Git 的向上查找卡在临时目录边界。
  base.GIT_CEILING_DIRECTORIES = TMP;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'run.mjs'), ...argv], {
    cwd, env: { ...base, ...env }, encoding: 'utf8'
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// 把收到的 args 和原语类型写到 HOME/out.json
const ECHO_TASK = [
  "import { writeFileSync } from 'node:fs';",
  "export const title = '回显参数';",
  'export default async function ({ script, agent, human, args }) {',
  "  const prims = [script, agent, human].map((f) => typeof f);",
  "  writeFileSync(new URL('../out.json', import.meta.url), JSON.stringify({ args, prims }));",
  '}',
  ''
].join('\n');

function makeHome(root, tasks = { echo: ECHO_TASK }) {
  const home = path.join(root, '.workflow');
  mkdirSync(path.join(home, 'tasks'), { recursive: true });
  for (const [name, src] of Object.entries(tasks)) writeFileSync(path.join(home, 'tasks', `${name}.mjs`), src);
  return home;
}
const readOut = (home) => JSON.parse(readFileSync(path.join(home, 'out.json'), 'utf8'));

function runExample(task, extra = []) {
  const runId = `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const r = cli([task, '--yes', ...extra], { env: { AGENTFLOW_HOME: EXAMPLES, AGENTFLOW_RUN_ID: runId } });
  const logFile = path.join(EXAMPLES, 'logs', `${runId}.jsonl`);
  let rows = [];
  try {
    rows = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  } catch { /* 找不到任务时没有日志 */ }
  rmSync(logFile, { force: true });
  return { ...r, rows };
}

// ── --version / --help ────────────────────────────────────────────────────

test('version：--version / -v 打印 package.json 里的 version 到 stdout 并退出 0', () => {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  for (const flag of ['--version', '-v']) {
    const r = cli([flag]);
    assert.equal(r.code, 0, `${flag}: ${r.stderr}`);
    assert.equal(r.stdout, `${version}\n`, flag);
    assert.equal(r.stderr, '', flag);
  }
});

test('help：--help / -h 打印 USAGE 到 stdout 并退出 0', () => {
  for (const flag of ['--help', '-h']) {
    const r = cli([flag]);
    assert.equal(r.code, 0, `${flag}: ${r.stderr}`);
    assert.match(r.stdout, /^usage:/, flag);
    assert.match(r.stdout, /miworkflow init/, flag);
    assert.equal(r.stderr, '', flag);
  }
});

test('无参数：USAGE 打到 stderr 并退出 1（现状不变）', () => {
  const r = cli([]);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^usage:/);
});

// ── 跑任务 ────────────────────────────────────────────────────────────────

test('run：examples/ 作为 HOME 端到端跑通 demo，参数传进任务', () => {
  const r = runExample('demo', ['--who', '测试员']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.rows.at(-1).primitive, 'run');
  assert.equal(r.rows.at(-1).status, 'ok');
  assert.ok(r.rows.some((x) => x.primitive === 'script' && x.say === '打了个招呼：hello 测试员'), '--who 应经 args 传到脚本');
});

test('run：HOME 里没有这个任务 → 报错并说清在哪找', () => {
  const r = runExample('__no_such_task');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /task not found/);
  assert.ok(r.stderr.includes(path.join(EXAMPLES, 'tasks')), '报错里要带上找的目录');
});

test('run：任务模块加载失败也记一条 failed', () => {
  const home = makeHome(tmpDir(), { bad: 'export default async function ( {\n' });
  const r = cli(['bad', '--yes'], { env: { AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'load-fail' } });
  assert.equal(r.code, 1);
  const rows = readFileSync(path.join(home, 'logs', 'load-fail.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(rows.at(-1).primitive, 'run');
  assert.equal(rows.at(-1).status, 'failed');
});

test('args：--key value / --key=value / --flag，--yes 与 --dry-run 不进 args；原语传进来', () => {
  const home = makeHome(tmpDir());
  const r = cli(['echo', '--issue', '12', '--note=a=b', '--confirm', '--yes', '--dry-run', '--max', '5'],
    { env: { AGENTFLOW_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  const out = readOut(home);
  assert.deepEqual(out.args, { issue: '12', note: 'a=b', confirm: true, max: '5' });
  assert.deepEqual(out.prims, ['function', 'function', 'function']);
});

// ── HOME 自动找（§3）───────────────────────────────────────────────────────

test('HOME：在项目子目录里往上找到 .workflow/', () => {
  const root = tmpDir();
  const home = makeHome(root);
  const deep = path.join(root, 'src', 'deeper');
  mkdirSync(deep, { recursive: true });
  const r = cli(['echo', '--from', 'sub'], { cwd: deep });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readOut(home).args, { from: 'sub' });
  assert.ok(existsSync(path.join(home, 'logs')), '日志落在找到的 HOME 里');
});

test('HOME：找不到 .workflow/ → 报错并提示 init，不回落到当前目录', () => {
  const dir = tmpDir();
  mkdirSync(path.join(dir, 'tasks'));
  writeFileSync(path.join(dir, 'tasks', 'echo.mjs'), ECHO_TASK);
  const r = cli(['echo'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /miworkflow init/);
});

test('HOME：AGENTFLOW_HOME 优先于往上找', () => {
  const project = tmpDir();
  makeHome(project, {});
  const other = makeHome(tmpDir());
  const r = cli(['echo'], { cwd: project, env: { AGENTFLOW_HOME: other } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(other, 'out.json')));
});

// ── Agent 缺省目录（§10.1）：不给 inputs.cwd 就在项目根，不在 .workflow/ ──────

// 假 pi：把自己的 cwd 交回
const WHERE_PI = [
  "const text = JSON.stringify({ status: 'ok', choice: 'done', reason: '', data: { cwd: process.cwd() } });",
  "process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\\n');",
  ''
].join('\n');
const WHERE_TASK = [
  "import { writeFileSync } from 'node:fs';",
  'export default async function ({ agent }) {',
  "  const r = await agent('你在哪', {});",
  "  writeFileSync(new URL('../out.json', import.meta.url), JSON.stringify(r));",
  '}',
  ''
].join('\n');

test('agent：没给 inputs.cwd 时，HOME 是 <项目>/.workflow 就在项目根干活；别的 HOME 就在 HOME 里', () => {
  const fakePi = path.join(tmpDir(), 'where-pi.mjs');
  writeFileSync(fakePi, WHERE_PI);
  const env = { AGENTFLOW_AGENT: 'pi', PI_BIN: fakePi };
  const same = (a, b) => assert.equal(path.resolve(a).toLowerCase(), path.resolve(b).toLowerCase());

  const project = tmpDir();
  const home = makeHome(project, { where: WHERE_TASK });
  const r = cli(['where'], { cwd: project, env });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readOut(home).status, 'ok', JSON.stringify(readOut(home)));
  same(readOut(home).data.cwd, project);

  const plain = tmpDir();
  mkdirSync(path.join(plain, 'tasks'));
  writeFileSync(path.join(plain, 'tasks', 'where.mjs'), WHERE_TASK);
  const p = cli(['where'], { env: { ...env, AGENTFLOW_HOME: plain } });
  assert.equal(p.code, 0, p.stderr);
  same(readOut(plain).data.cwd, plain);
});

// ── 任务锁（§9）：同一 task 同时只跑一个 ────────────────────────────────

const lockPath = (home, task) => path.join(home, 'logs', `${task}.lock`);
const readLock = (home, task) => JSON.parse(readFileSync(lockPath(home, task), 'utf8'));
const writeLock = (home, task, pid, runId) => {
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  writeFileSync(lockPath(home, task), JSON.stringify({ pid, runId, at: new Date().toISOString() }));
};
// 一个已退出的进程，拿它的 pid 当「不存在的 pid」
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('lock：同一 task 已在跑 → 跳过，不执行任务体，退出码 0', () => {
  const home = makeHome(tmpDir());
  writeLock(home, 'echo', process.pid, 'holder'); // 当前测试进程还活着 → 锁有效

  const r = cli(['echo', '--yes'], { env: { AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'second' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /echo 已在跑/);
  assert.match(r.stdout, new RegExp(`pid ${process.pid}`));
  assert.match(r.stdout, /run holder/);
  assert.equal(existsSync(path.join(home, 'out.json')), false, '第二次不应执行任务体');
  assert.equal(readLock(home, 'echo').runId, 'holder', '没抢到锁，不该动锁');
});

test('lock：运行结束（正常 / 抛异常）都释放锁', () => {
  const home = makeHome(tmpDir(), { good: ECHO_TASK, bad: "export default async function () { throw new Error('炸了'); }\n" });

  assert.equal(cli(['good'], { env: { AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'r-good' } }).code, 0);
  assert.equal(existsSync(lockPath(home, 'good')), false, '正常结束后锁要没');

  assert.equal(cli(['bad'], { env: { AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'r-bad' } }).code, 1);
  assert.equal(existsSync(lockPath(home, 'bad')), false, '任务抛异常后锁也要没');
});

test('lock：陈锁（pid 已不在）被接管并覆盖', () => {
  const home = makeHome(tmpDir());
  writeLock(home, 'echo', deadPid(), 'dead');

  const r = cli(['echo'], { env: { AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'taker' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(home, 'out.json')), '陈锁不该挡住任务');
  assert.equal(existsSync(lockPath(home, 'echo')), false, '跑完释放锁');
});

test('lock：A 在跑，不同 task B 照跑，且不动 A 的锁', () => {
  const home = makeHome(tmpDir(), { a: ECHO_TASK, b: ECHO_TASK });
  writeLock(home, 'a', process.pid, 'holder');

  const r = cli(['b'], { env: { AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'b-run' } });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(home, 'out.json')), 'B 不该被 A 的锁挡住');
  assert.equal(readLock(home, 'a').runId, 'holder', 'B 不该删 A 的锁');
  assert.equal(existsSync(lockPath(home, 'b')), false, 'B 自己的锁跑完要释放');
});

// ── init ──────────────────────────────────────────────────────────────────

test('init：空白模板建在 git 仓库根，.gitignore 只含 logs/，AGENTS.md 指向 miworkflow skill', () => {
  const repo = tmpDir();
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const sub = path.join(repo, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const r = cli(['init'], { cwd: sub });
  assert.equal(r.code, 0, r.stderr);
  const home = path.join(repo, '.workflow');
  assert.ok(existsSync(path.join(home, 'tasks')));
  assert.ok(existsSync(path.join(home, 'scripts')));
  assert.equal(readFileSync(path.join(home, '.gitignore'), 'utf8'), 'logs/\n');
  assert.equal(existsSync(path.join(sub, '.workflow')), false);
  const agents = readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  assert.match(agents, /miworkflow skill/, 'AI 入口要指向完整写法');
  assert.doesNotMatch(agents, /[A-Za-z]:[\\/]|\/Users\/|\/home\//, '不写本机绝对路径：会进 Git、换机器就失效');
  assert.match(r.stdout, /miworkflow skill/);
});

test('skill：打印内核的 SKILL.md，不需要 .workflow/', () => {
  const r = cli(['skill'], { cwd: tmpDir() });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8'));
});

test('init：不在 git 仓库里就建在当前目录', () => {
  const dir = tmpDir();
  const r = cli(['init', '--template', 'blank'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, '.workflow', 'tasks')));
});

test('init：项目根 AGENTS.md 没有就建、已有就追加、重复 init 不重复追加', () => {
  const repo = tmpDir();
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(path.join(repo, 'AGENTS.md'), '# 项目自己的规矩\n\n- 别碰 vendor/\n');

  const r = cli(['init', '--template', 'blank'], { cwd: repo });
  assert.equal(r.code, 0, r.stderr);
  const rootAgents = path.join(repo, 'AGENTS.md');
  const first = readFileSync(rootAgents, 'utf8');
  assert.match(first, /^# 项目自己的规矩/, '原有内容不能被覆盖');
  assert.match(first, /- 别碰 vendor\//);
  assert.match(first, /<!-- miworkflow:begin -->/);
  assert.match(first, /\.workflow\/AGENTS\.md/, '入口要指到 .workflow/AGENTS.md');
  assert.match(r.stdout, /AGENTS\.md（已追加 MiWorkflow 段）/);

  const again = cli(['init', '--template', 'blank'], { cwd: repo });
  assert.equal(again.code, 0, again.stderr);
  const second = readFileSync(rootAgents, 'utf8');
  assert.equal(second, first, '重复 init 不动项目根 AGENTS.md');
  assert.equal(second.split('<!-- miworkflow:begin -->').length - 1, 1, 'marker 只出现一次');
  assert.match(again.stdout, /AGENTS\.md（已有 MiWorkflow 段，没动）/);
});

test('init：项目根没有 AGENTS.md 就建一个（不在 git 仓库里也是当前目录）', () => {
  const dir = tmpDir();
  const r = cli(['init', '--template', 'blank'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const content = readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.match(content, /<!-- miworkflow:begin -->/);
  assert.match(content, /miworkflow skill/);
  assert.match(r.stdout, /AGENTS\.md（新建）/);
});

test('init：复制模板（先叠共用模板），已有文件不覆盖并列出来；没有的模板报错', (t) => {
  const tpl = path.join(TEMPLATES, 'zz_test_tpl');
  const hadTemplates = existsSync(TEMPLATES);
  mkdirSync(path.join(tpl, 'tasks'), { recursive: true });
  writeFileSync(path.join(tpl, 'tasks', 'from_tpl.mjs'), "export const title = '模板任务';\n");
  writeFileSync(path.join(tpl, 'config.mjs'), 'export const X = 1;\n');
  t.after(() => rmSync(hadTemplates ? tpl : TEMPLATES, { recursive: true, force: true }));

  const dir = tmpDir();
  mkdirSync(path.join(dir, '.workflow'));
  writeFileSync(path.join(dir, '.workflow', 'config.mjs'), 'export const X = 42;\n');

  const r = cli(['init', '--template', 'zz_test_tpl'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, '.workflow', 'tasks', 'from_tpl.mjs')));
  assert.ok(existsSync(path.join(dir, '.workflow', 'tasks', 'dev.mjs')), '共用模板也复制了');
  assert.equal(readFileSync(path.join(dir, '.workflow', 'config.mjs'), 'utf8'), 'export const X = 42;\n');
  assert.match(r.stdout, /config\.mjs（已存在，没动）/);

  const again = cli(['init', '--template', 'zz_test_tpl'], { cwd: dir });
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^\s+\+ /m, '重复 init 一个文件都不新建');

  const bad = cli(['init', '--template', '__nope'], { cwd: dir });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /没有这个模板/);

  const shared = cli(['init', '--template', '_shared'], { cwd: dir });
  assert.equal(shared.code, 1, '共用模板不能单独选');
  assert.doesNotMatch(shared.stderr, /可选：[^\n]*_shared/);
});

// 在 templates/ 下临时摆几个模板目录：{ 目录名: { 相对路径: 内容 } }，测完删掉
function fixtureTemplates(t, dirs) {
  for (const [dir, files] of Object.entries(dirs)) {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(TEMPLATES, dir, rel)), { recursive: true });
      writeFileSync(path.join(TEMPLATES, dir, rel), text);
    }
  }
  t.after(() => { for (const dir of Object.keys(dirs)) rmSync(path.join(TEMPLATES, dir), { recursive: true, force: true }); });
}

test('init / init --upgrade：与共用模板同名的文件两边都是模板的赢；extends 叠共用层，清单不复制；记下模板名', (t) => {
  fixtureTemplates(t, {
    _zz_layer: { 'scripts/layer.mjs': '// layer\n', 'tasks/dev.mjs': '// layer dev\n' },
    zz_layered: { 'template.json': '{ "extends": ["_zz_layer"] }\n', 'tasks/dev.mjs': '// tpl dev\n', 'scripts/own.mjs': '// own\n' }
  });
  const dir = tmpDir();
  const home = path.join(dir, '.workflow');
  const r = cli(['init', '--template', 'zz_layered'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(path.join(home, 'tasks', 'dev.mjs'), 'utf8'), '// tpl dev\n', '模板覆盖共用层与共用模板');
  assert.equal(readFileSync(path.join(home, 'scripts', 'layer.mjs'), 'utf8'), '// layer\n');
  assert.ok(existsSync(path.join(home, 'scripts', 'own.mjs')));
  assert.ok(existsSync(path.join(home, 'prompts', 'dev.md')), '共用模板照样叠');
  assert.ok(!existsSync(path.join(home, 'template.json')), '清单不复制');
  assert.equal(readFileSync(path.join(home, '.template'), 'utf8'), 'zz_layered\n');

  writeFileSync(path.join(home, 'tasks', 'dev.mjs'), '// 改过\n');
  const up = cli(['init', '--upgrade'], { cwd: dir });
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /模板：zz_layered/);
  assert.equal(readFileSync(path.join(home, 'tasks', 'dev.mjs'), 'utf8'), '// tpl dev\n', '升级与 init 铺的是同一份');
  assert.doesNotMatch(up.stdout, /\.template/, '已记下就不再写');

  const bad = cli(['init', '--template', '__nope'], { cwd: dir });
  assert.doesNotMatch(bad.stderr, /可选：[^\n]*_zz_layer/, '共用层不出现在模板菜单');
});

test('init --upgrade：老项目没记模板名就猜，好几个都像时认最具体的并补记；记下的模板名优先于猜', (t) => {
  fixtureTemplates(t, {
    _zz_base: { 'scripts/base.mjs': '// base\n' },
    zz_plain: { 'template.json': '{ "extends": ["_zz_base"] }\n', 'scripts/plain_src.mjs': '// plain\n' },
    zz_rich: { 'template.json': '{ "extends": ["_zz_base"] }\n', 'scripts/plain_src.mjs': '// plain\n', 'scripts/rich.mjs': '// rich\n' }
  });
  const rich = tmpDir();
  assert.equal(cli(['init', '--template', 'zz_rich'], { cwd: rich }).code, 0);
  rmSync(path.join(rich, '.workflow', '.template'));
  const up = cli(['init', '--upgrade'], { cwd: rich });
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /模板：zz_rich/, 'zz_plain 也像，认文件更全的 zz_rich');
  assert.match(up.stdout, /\+ \.template（记下模板名 zz_rich/);
  assert.equal(readFileSync(path.join(rich, '.workflow', '.template'), 'utf8'), 'zz_rich\n');

  const plain = tmpDir();
  assert.equal(cli(['init', '--template', 'zz_plain'], { cwd: plain }).code, 0);
  writeFileSync(path.join(plain, '.workflow', 'scripts', 'rich.mjs'), '// 项目自己的同名文件\n');
  const kept = cli(['init', '--upgrade'], { cwd: plain });
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(kept.stdout, /模板：zz_plain/, '记下的是 zz_plain，文件再像 zz_rich 也不改认');
  assert.equal(readFileSync(path.join(plain, '.workflow', 'scripts', 'rich.mjs'), 'utf8'), '// 项目自己的同名文件\n');
});

test('init：模板清单的 extends 写错（不是 _ 开头的共用层 / 不存在）→ 报错', (t) => {
  fixtureTemplates(t, { zz_badext: { 'template.json': '{ "extends": ["github"] }\n' } });
  const r = cli(['init', '--template', 'zz_badext'], { cwd: tmpDir() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /extends 只能列以 _ 开头、存在的共用层/);
});

test('init --template github：共用 + GitHub 两部分都复制进来', () => {
  const dir = tmpDir();
  const r = cli(['init', '--template', 'github'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const home = path.join(dir, '.workflow');
  for (const f of ['config.mjs', 'tasks/dev.mjs', 'scripts/_lib.mjs', 'scripts/git_commit.mjs', 'scripts/run_cmd.mjs',
    'prompts/dev.md', 'prompts/review.md', 'prompts/fix.md',
    'source.mjs', 'tasks/discuss.mjs', 'scripts/_gh.mjs', 'scripts/ticket_ready.mjs', 'scripts/discuss_list.mjs',
    'scripts/tickets_create.mjs', 'scripts/_tickets.mjs', 'prompts/grilling.md']) {
    assert.ok(existsSync(path.join(home, f)), f);
  }
  assert.ok(!existsSync(path.join(home, 'tasks', 'github_dev.mjs')));

  const again = cli(['init', '--template', 'github'], { cwd: dir });
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^\s+\+ /m, '重复 init 一个文件都不新建');
});

test('init --template tapd：共用 + TAPD 两部分都复制进来，不带 GitHub 的', () => {
  const dir = tmpDir();
  const r = cli(['init', '--template', 'tapd'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const home = path.join(dir, '.workflow');
  for (const f of ['config.mjs', 'tasks/dev.mjs', 'scripts/_lib.mjs', 'prompts/dev.md',
    'source.mjs', 'scripts/_tapd.mjs', 'scripts/ticket_ready.mjs', 'scripts/ticket_view.mjs', 'scripts/ticket_mark.mjs',
    'tasks/discuss.mjs', 'scripts/discuss_list.mjs', 'scripts/discuss_view.mjs', 'scripts/discuss_post.mjs',
    'scripts/_discuss.mjs', 'scripts/tickets_create.mjs', 'scripts/_tickets.mjs']) {
    assert.ok(existsSync(path.join(home, f)), f);
  }
  assert.ok(!existsSync(path.join(home, 'scripts', '_gh.mjs')));
  assert.match(readFileSync(path.join(home, 'source.mjs'), 'utf8'), /WORKSPACE_ID/);

  const again = cli(['init', '--template', 'tapd'], { cwd: dir });
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^\s+\+ /m, '重复 init 一个文件都不新建');

  const bad = cli(['init', '--template', '__nope'], { cwd: dir });
  assert.match(bad.stderr, /可选：[^\n]*tapd/, '模板菜单出现 TAPD');
});

test('init --template beads：共用 + beads 两部分都复制进来（开发与讨论流程的脚本齐全）；upgrade 认得出', () => {
  const dir = tmpDir();
  const r = cli(['init', '--template', 'beads'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const home = path.join(dir, '.workflow');
  for (const f of ['config.mjs', 'tasks/dev.mjs', 'tasks/discuss.mjs', 'scripts/_lib.mjs', 'prompts/dev.md',
    'source.mjs', 'scripts/_bd.mjs', 'scripts/ticket_ready.mjs', 'scripts/ticket_view.mjs', 'scripts/ticket_mark.mjs',
    'scripts/discuss_list.mjs', 'scripts/discuss_view.mjs', 'scripts/discuss_post.mjs', 'scripts/tickets_create.mjs',
    'scripts/_discuss.mjs', 'scripts/_tickets.mjs', 'prompts/grilling.md']) {
    assert.ok(existsSync(path.join(home, f)), f);
  }
  assert.ok(!existsSync(path.join(home, 'scripts', '_gh.mjs')));
  assert.ok(!existsSync(path.join(home, 'scripts', '_tapd.mjs')));

  const bad = cli(['init', '--template', '__nope'], { cwd: dir });
  assert.match(bad.stderr, /可选：[^\n]*beads/, '模板菜单出现 beads');
  const up = cli(['init', '--upgrade'], { cwd: dir });
  assert.equal(up.code, 0, up.stderr);
  assert.match(up.stdout, /模板：beads/);
});

test('init --upgrade：认出模板；模板文件覆盖、缺的补上；项目配置的一行 export const 保留；项目自己的文件不碰；旧文件备份', () => {
  const dir = tmpDir();
  assert.equal(cli(['init', '--template', 'tapd'], { cwd: dir }).code, 0);
  const home = path.join(dir, '.workflow');
  const edit = (rel, fn) => writeFileSync(path.join(home, rel), fn(readFileSync(path.join(home, rel), 'utf8')));
  edit('source.mjs', (s) => `${s
    .replace("export const WORKSPACE_ID = '';", "export const WORKSPACE_ID = '52360842';")
    .replace(/^export const COMMIT_TYPES = .*;$/m, "export const COMMIT_TYPES = ['feat', 'fix', 'art'];")}export const OLD_ONLY = 1;\n`);
  edit('config.mjs', (s) => s.replace('export const PUSH = true;', 'export const PUSH = false;'));
  writeFileSync(path.join(home, 'tasks', 'dev.mjs'), '// 旧版\n');
  rmSync(path.join(home, 'prompts', 'fix.md'));
  writeFileSync(path.join(home, 'tasks', 'mine.mjs'), '// 项目自己的\n');
  mkdirSync(path.join(home, 'prompts', 'local'));
  writeFileSync(path.join(home, 'prompts', 'local', 'dev.md'), '项目补充\n');

  const r = cli(['init', '--upgrade'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /模板：tapd/);
  const tpl = (part, rel) => readFileSync(path.join(TEMPLATES, part, rel), 'utf8');
  assert.equal(readFileSync(path.join(home, 'tasks', 'dev.mjs'), 'utf8'), tpl('_shared', 'tasks/dev.mjs'));
  assert.match(r.stdout, /~ tasks\/dev\.mjs（已覆盖）/);
  assert.equal(readFileSync(path.join(home, 'prompts', 'fix.md'), 'utf8'), tpl('_shared', 'prompts/fix.md'));
  assert.match(r.stdout, /\+ prompts\/fix\.md/);
  assert.equal(readFileSync(path.join(home, 'tasks', 'mine.mjs'), 'utf8'), '// 项目自己的\n');
  assert.equal(readFileSync(path.join(home, 'prompts', 'local', 'dev.md'), 'utf8'), '项目补充\n');

  const src = readFileSync(path.join(home, 'source.mjs'), 'utf8');
  assert.match(src, /^export const WORKSPACE_ID = '52360842';$/m);
  assert.match(src, /^export const COMMIT_TYPES = \['feat', 'fix', 'art'\];$/m);
  assert.doesNotMatch(src, /OLD_ONLY/);
  assert.match(r.stdout, /source\.mjs（跟模板走，保留项目的 WORKSPACE_ID、COMMIT_TYPES，模板已没有、丢掉了 OLD_ONLY）/);
  assert.match(readFileSync(path.join(home, 'config.mjs'), 'utf8'), /^export const PUSH = false;$/m);

  const backups = readdirSync(path.join(home, 'logs')).filter((d) => d.startsWith('upgrade-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(home, 'logs', backups[0], 'tasks', 'dev.mjs'), 'utf8'), '// 旧版\n');
  assert.match(r.stdout, /备份在/);

  const again = cli(['init', '--upgrade'], { cwd: dir });
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^\s+[~+] /m, '再升一次什么都不动');

  const bare = tmpDir();
  mkdirSync(path.join(bare, '.workflow'));
  const unknown = cli(['init', '--upgrade'], { cwd: bare });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /认不出.*--template/);
});

// ── new ───────────────────────────────────────────────────────────────────

test('new：建传参骨架，能直接跑；已存在不覆盖', () => {
  const root = tmpDir();
  const home = makeHome(root, {});
  const r = cli(['new', 'fix_tests'], { cwd: root });
  assert.equal(r.code, 0, r.stderr);
  const file = path.join(home, 'tasks', 'fix_tests.mjs');
  const src = readFileSync(file, 'utf8');
  assert.match(src, /export const title/);
  assert.match(src, /\{ script, agent, human, args \}/);
  assert.doesNotMatch(src, /import/);

  assert.equal(cli(['fix_tests'], { cwd: root }).code, 0, '骨架本身能跑通');

  writeFileSync(file, '// 改过了\n');
  const again = cli(['new', 'fix_tests'], { cwd: root });
  assert.equal(again.code, 1);
  assert.equal(readFileSync(file, 'utf8'), '// 改过了\n');
});

test('new：没有 .workflow/ → 报错提示 init；保留字不能当任务名', () => {
  const dir = tmpDir();
  const r = cli(['new', 'x'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /miworkflow init/);

  makeHome(dir, {});
  assert.equal(cli(['new', 'view'], { cwd: dir }).code, 1);
  assert.equal(cli(['new', 'skill'], { cwd: dir }).code, 1);
  assert.equal(cli(['new', 'stop'], { cwd: dir }).code, 1);
  assert.equal(cli(['new', '../evil'], { cwd: dir }).code, 1);
});

// ── --every：起真实 CLI 子进程，秒级间隔，攒够轮数就杀掉外层循环 ──
const ROUND_TASK = [
  "import { appendFileSync } from 'node:fs';",
  "export const title = '循环一轮';",
  'export default async function ({ args }) {',
  "  appendFileSync(new URL('../rounds.jsonl', import.meta.url), JSON.stringify({ runId: process.env.AGENTFLOW_RUN_ID, args }) + '\\n');",
  "  if (args.fail) throw new Error('这一轮故意失败');",
  '}',
  ''
].join('\n');

function readRounds(home) {
  try {
    return readFileSync(path.join(home, 'rounds.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function loopUntil(argv, home, rounds, env = {}) {
  const base = { ...process.env };
  for (const k of ['AGENTFLOW_HOME', 'AGENTFLOW_TASK', 'AGENTFLOW_RUN_ID', 'AGENTFLOW_YES', 'AGENTFLOW_DRY_RUN']) delete base[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'run.mjs'), ...argv], {
    env: { ...base, AGENTFLOW_HOME: home, ...env }
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.once('exit', r));
  let done = false;
  exited.then(() => { done = true; });
  const deadline = Date.now() + 20_000;
  while (!done && readRounds(home).length < rounds && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300)); // 让最后一轮的退出码打到终端
  child.kill();
  await exited;
  return { rounds: readRounds(home), out };
}

test('--every：每轮全新 runId、不继承外部 runId，--every 不进 args，其余参数原样传', async () => {
  const home = makeHome(tmpDir(), { tick: ROUND_TASK });
  const r = await loopUntil(['tick', '--every', '1s', '--x', '1'], home, 2, { AGENTFLOW_RUN_ID: 'outer' });
  assert.ok(r.rounds.length >= 2, r.out);
  const ids = r.rounds.map((x) => x.runId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes('outer'));
  for (const x of r.rounds) assert.deepEqual(x.args, { x: '1' });
  // 外层循环不写 run 日志：日志里只有各轮自己的 runId
  const logs = readdirSync(path.join(home, 'logs')).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6));
  assert.ok(!logs.includes('outer'));
});

test('--every：某一轮失败记下退出码，循环照常继续', async () => {
  const home = makeHome(tmpDir(), { tick: ROUND_TASK });
  const r = await loopUntil(['tick', '--every=1s', '--fail'], home, 2);
  assert.ok(r.rounds.length >= 2, r.out);
  assert.match(r.out, /退出码 1/);
});

// ── stop：做完手头这一单再停 / --now 强关 ─────────────────────────────────
// 后台起一个真 run（或 --every 循环），等它就位，再用 miworkflow stop 停它
function startBg(argv, home) {
  const base = { ...process.env };
  for (const k of ['AGENTFLOW_HOME', 'AGENTFLOW_TASK', 'AGENTFLOW_RUN_ID', 'AGENTFLOW_YES', 'AGENTFLOW_DRY_RUN', 'AGENTFLOW_LOOP_PID']) delete base[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'run.mjs'), ...argv], { env: { ...base, AGENTFLOW_HOME: home } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return { child, exited, out: () => out };
}

async function waitFor(check, ms = 15_000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('等太久了');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const runRows = (home, runId) => readFileSync(path.join(home, 'logs', `${runId}.jsonl`), 'utf8').split('\n').filter(Boolean).map(JSON.parse);

// 每一「单」写一行 ticks，单与单之间查 stopping()
const SLOW_TASK = [
  "import { appendFileSync } from 'node:fs';",
  "export const title = '慢慢做';",
  'export default async function ({ stopping }) {',
  '  for (let i = 0; i < 400; i++) {',
  '    if (stopping()) return;',
  "    appendFileSync(new URL('../ticks.txt', import.meta.url), `${i}\\n`);",
  '    await new Promise((r) => setTimeout(r, 50));',
  '  }',
  '}',
  ''
].join('\n');

// 起一个睡死的孙进程（模拟 Agent CLI），pid 写进 grandchild.txt，自己也一直等
const HANG_TASK = [
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "export const title = '卡住';",
  'export default async function () {',
  "  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "  writeFileSync(new URL('../grandchild.txt', import.meta.url), String(g.pid));",
  '  await new Promise(() => {});',
  '}',
  ''
].join('\n');

const ticks = (home) => { try { return readFileSync(path.join(home, 'ticks.txt'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };

test('stop：没在跑 → 说一声，退出码 0；顺手清掉没人认领的旧请求', () => {
  const home = makeHome(tmpDir(), { slow: SLOW_TASK });
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  writeFileSync(path.join(home, 'logs', 'slow.stop'), JSON.stringify({ runId: 'old', loopPid: null }));
  const r = cli(['stop', 'slow'], { env: { AGENTFLOW_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /slow 没在跑/);
  assert.ok(!existsSync(path.join(home, 'logs', 'slow.stop')));
  assert.equal(cli(['stop'], { env: { AGENTFLOW_HOME: home } }).code, 1, '没给任务名报用法');
});

test('stop：任务查 stopping() 停在自己的边界，正常结束；记录写明收到停止请求，锁和请求都清掉', async () => {
  const home = makeHome(tmpDir(), { slow: SLOW_TASK });
  const bg = startBg(['slow'], home);
  await waitFor(() => ticks(home) >= 2);
  const { runId } = readLock(home, 'slow');

  const r = cli(['stop', 'slow'], { env: { AGENTFLOW_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已请求停止：slow 做完手头这一单就停/);
  assert.equal(await bg.exited, 0, bg.out());
  assert.ok(ticks(home) < 400, '没跑完全部就停了');
  const last = runRows(home, runId).at(-1);
  assert.equal(last.status, 'ok');
  assert.match(last.say, /收到停止请求/);
  assert.ok(!existsSync(lockPath(home, 'slow')));
  assert.ok(!existsSync(path.join(home, 'logs', 'slow.stop')));
});

test('stop：过期的请求对不上新 run，不会误停', () => {
  const home = makeHome(tmpDir(), {
    peek: "import { writeFileSync } from 'node:fs';\nexport default async function ({ stopping }) { writeFileSync(new URL('../out.json', import.meta.url), JSON.stringify({ stopping: stopping() })); }\n"
  });
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  writeFileSync(path.join(home, 'logs', 'peek.stop'), JSON.stringify({ runId: 'old-run', loopPid: 12345 }));
  const r = cli(['peek'], { env: { AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'new-run' } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readOut(home), { stopping: false });
});

test('stop --now：杀掉 run 和它的子孙进程，补一条 failed 终态，删锁', async () => {
  const home = makeHome(tmpDir(), { hang: HANG_TASK });
  const bg = startBg(['hang'], home);
  const gFile = path.join(home, 'grandchild.txt');
  await waitFor(() => existsSync(gFile) && readFileSync(gFile, 'utf8').length > 0);
  const grandchild = Number(readFileSync(gFile, 'utf8'));
  const { pid, runId } = readLock(home, 'hang');

  const r = cli(['stop', 'hang', '--now'], { env: { AGENTFLOW_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /已强关 hang/);
  await bg.exited;
  assert.ok(!alive(pid), 'run 进程没了');
  await waitFor(() => !alive(grandchild), 5000);
  assert.ok(!existsSync(lockPath(home, 'hang')), '锁删掉');
  const rows = runRows(home, runId);
  const last = rows.at(-1);
  assert.equal(last.primitive, 'run');
  assert.equal(last.status, 'failed');
  assert.match(last.say, /被强行停止/);
  assert.equal(last.seq, rows.at(-2).seq + 1, 'seq 接着往下排');
  assert.equal(last.title, '卡住');
});

test('stop：--every 循环跑完这一轮就退出，不再起下一轮；等下一轮时收到请求也马上退', async () => {
  const home = makeHome(tmpDir(), { tick: ROUND_TASK });
  const bg = startBg(['tick', '--every', '1h'], home);
  await waitFor(() => readRounds(home).length >= 1 && !existsSync(lockPath(home, 'tick')));
  assert.ok(existsSync(path.join(home, 'logs', 'tick.loop')), '循环记下了 pid');

  const r = cli(['stop', 'tick'], { env: { AGENTFLOW_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /--every 循环（pid \d+）马上退出/);
  assert.equal(await bg.exited, 0, bg.out());
  assert.match(bg.out(), /收到停止请求，跑了 1 轮，退出/);
  assert.equal(readRounds(home).length, 1);
  assert.ok(!existsSync(path.join(home, 'logs', 'tick.loop')));
  assert.ok(!existsSync(path.join(home, 'logs', 'tick.stop')));
});

test('stop：--every 循环的那一轮在跑时，run 用 stopping() 停下，循环也跟着退出', async () => {
  const home = makeHome(tmpDir(), { slow: SLOW_TASK });
  const bg = startBg(['slow', '--every', '1s'], home);
  await waitFor(() => ticks(home) >= 2);

  const r = cli(['stop', 'slow'], { env: { AGENTFLOW_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /这一轮跑完退出/);
  assert.equal(await bg.exited, 0, bg.out());
  assert.match(bg.out(), /跑了 1 轮/);
  assert.ok(ticks(home) < 400);
  assert.ok(!existsSync(path.join(home, 'logs', 'slow.stop')));
});

test('stop --now：--every 循环连同正在跑的那一轮一起杀掉', async () => {
  const home = makeHome(tmpDir(), { hang: HANG_TASK });
  const bg = startBg(['hang', '--every', '1s'], home);
  await waitFor(() => existsSync(lockPath(home, 'hang')) && existsSync(path.join(home, 'logs', 'hang.loop')));
  const loopPid = JSON.parse(readFileSync(path.join(home, 'logs', 'hang.loop'), 'utf8')).pid;

  const r = cli(['stop', 'hang', '--now'], { env: { AGENTFLOW_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  await bg.exited;
  assert.ok(!alive(loopPid));
  assert.ok(!existsSync(lockPath(home, 'hang')));
  assert.ok(!existsSync(path.join(home, 'logs', 'hang.loop')));
});

test('--every：同一任务已有循环在跑 → 不起第二个', () => {
  const home = makeHome(tmpDir(), { tick: ROUND_TASK });
  mkdirSync(path.join(home, 'logs'), { recursive: true });
  writeFileSync(path.join(home, 'logs', 'tick.loop'), JSON.stringify({ pid: process.pid }));
  const r = cli(['tick', '--every', '1s'], { env: { AGENTFLOW_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /tick 已有循环在跑/);
  assert.deepEqual(readRounds(home), []);
});

test('--every：缺值 / 格式不对 → 报错退出，不起任何 run', () => {
  const dir = tmpDir();
  const home = makeHome(dir, { tick: ROUND_TASK });
  for (const argv of [['tick', '--every'], ['tick', '--every', '--x', '1'], ['tick', '--every', '5'], ['tick', '--every=5x'], ['tick', '--every', '0s'], ['tick', '--every', '1000h']]) {
    const r = cli(argv, { cwd: dir });
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.stderr, /--every/);
  }
  assert.deepEqual(readRounds(home), []);
  assert.ok(!existsSync(path.join(home, 'logs')));
});
