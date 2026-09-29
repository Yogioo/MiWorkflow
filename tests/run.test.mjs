import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('init：复制模板，已有文件不覆盖并列出来；没有的模板报错', (t) => {
  const tpl = path.join(TEMPLATES, '__test_tpl');
  const hadTemplates = existsSync(TEMPLATES);
  mkdirSync(path.join(tpl, 'tasks'), { recursive: true });
  writeFileSync(path.join(tpl, 'tasks', 'from_tpl.mjs'), "export const title = '模板任务';\n");
  writeFileSync(path.join(tpl, 'config.mjs'), 'export const X = 1;\n');
  t.after(() => rmSync(hadTemplates ? tpl : TEMPLATES, { recursive: true, force: true }));

  const dir = tmpDir();
  mkdirSync(path.join(dir, '.workflow'));
  writeFileSync(path.join(dir, '.workflow', 'config.mjs'), 'export const X = 42;\n');

  const r = cli(['init', '--template', '__test_tpl'], { cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(path.join(dir, '.workflow', 'tasks', 'from_tpl.mjs')));
  assert.equal(readFileSync(path.join(dir, '.workflow', 'config.mjs'), 'utf8'), 'export const X = 42;\n');
  assert.match(r.stdout, /config\.mjs（已存在，没动）/);

  const again = cli(['init', '--template', '__test_tpl'], { cwd: dir });
  assert.equal(again.code, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /^\s+\+ /m, '重复 init 一个文件都不新建');

  const bad = cli(['init', '--template', '__nope'], { cwd: dir });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /没有这个模板/);
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
  assert.equal(cli(['new', '../evil'], { cwd: dir }).code, 1);
});
