// C3 模板（templates/github/）的端到端测试：假 gh + 假 Agent + 临时 git 仓库（Core §15）。
// 模板复制出去的那一刻要是好的——所以这些测试留在内核仓库，不跟着模板进项目。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'templates', 'github');

const TMP = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-c3-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const tmpDir = () => { const d = path.join(TMP, `t${++n}`); mkdirSync(d, { recursive: true }); return d; };

// 假的 gh：以 FAKE_GH_STATE 里的 JSON 为后端，只实现模板用到的那几个子命令
const FAKE_GH = path.join(TMP, 'fake-gh.mjs');
writeFileSync(FAKE_GH, [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const STATE = process.env.FAKE_GH_STATE;',
  'const argv = process.argv.slice(2);',
  'const load = () => JSON.parse(readFileSync(STATE, "utf8"));',
  'const save = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));',
  'const out = (v) => process.stdout.write(JSON.stringify(v));',
  'const die = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };',
  'const state = load();',
  'const action = argv[1];',
  'const rest = [];',
  'for (let i = 2; i < argv.length; i++) { if (argv[i] === "--repo") { i++; continue; } rest.push(argv[i]); }',
  'const find = (x) => state.issues.find((i) => i.number === Number(x));',
  'if (action === "list") {',
  '  out(state.issues.filter((i) => i.state === "OPEN").map((i) => ({ number: i.number, title: i.title, body: i.body, labels: i.labels })));',
  '} else if (action === "view") {',
  '  const i = find(rest[0]); if (!i) die("no such issue");',
  '  out({ number: i.number, title: i.title, body: i.body, labels: i.labels, comments: (i.comments ?? []).map((c) => ({ author: { login: c.author }, createdAt: c.at, body: c.body })) });',
  '} else if (action === "edit") {',
  '  const i = find(rest[0]); if (!i) die("no such issue");',
  '  for (let k = 0; k < rest.length; k++) {',
  '    if (rest[k] === "--add-label") { const name = rest[++k]; if (!i.labels.some((l) => l.name === name)) i.labels.push({ name }); }',
  '    if (rest[k] === "--remove-label") { const name = rest[++k]; i.labels = i.labels.filter((l) => l.name !== name); }',
  '  }',
  '  save(state); out({ ok: true });',
  '} else if (action === "comment") {',
  '  const i = find(rest[0]); if (!i) die("no such issue");',
  '  let body = "";',
  '  for (let k = 0; k < rest.length; k++) if (rest[k] === "--body") body = rest[++k];',
  '  i.comments = (i.comments ?? []).concat([{ author: "bot", at: "2026-01-01T00:00:00Z", body }]);',
  '  save(state); out({ ok: true });',
  '} else if (action === "close") {',
  '  const i = find(rest[0]); if (!i) die("no such issue");',
  '  i.state = "CLOSED"; save(state); out({ ok: true });',
  '} else { die("fake gh 不认：" + argv.join(" ")); }',
  ''
].join('\n'));

// 假的 Agent：按 FAKE_AGENT_PLAN 数组逐次回话；step.file 时往 inputs.cwd 写文件
const FAKE_AGENT = path.join(TMP, 'fake-agent.mjs');
writeFileSync(FAKE_AGENT, [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "import path from 'node:path';",
  "let raw = '';",
  'for await (const c of process.stdin) raw += c;',
  'const pkg = raw ? JSON.parse(raw) : {};',
  'const planFile = process.env.FAKE_AGENT_PLAN;',
  'const plan = JSON.parse(readFileSync(planFile, "utf8"));',
  'const step = plan.shift();',
  'writeFileSync(planFile, JSON.stringify(plan));',
  'if (step.file) writeFileSync(path.join(pkg.inputs.cwd, step.file.name), step.file.content);',
  'process.stdout.write(JSON.stringify({ status: step.status ?? "ok", choice: step.choice, reason: step.reason ?? "", data: step.data ?? {} }));',
  ''
].join('\n'));

// ── 脚手架 ─────────────────────────────────────────────────────────────────

const git = (argv, cwd) => spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true });
const gitOut = (argv, cwd) => git(argv, cwd).stdout.trim();

const issue = (number, { title = `issue ${number}`, body = `做 ${number}`, labels = [], state = 'OPEN' } = {}) => ({
  number, title, body, labels: labels.map((name) => ({ name })), state, comments: []
});

const CONFIG = (verify, rounds, push) => [
  'export const DEV = null;',
  'export const REVIEWER = null;',
  `export const VERIFY = ${JSON.stringify(verify)};`,
  `export const ROUNDS = ${rounds};`,
  `export const PUSH = ${push};`,
  "export const LABELS = { ready: 'ready-for-agent', inProgress: 'in-progress', failed: 'afk-failed' };",
  ''
].join('\n');

function setup({ issues = [], verify = '', rounds = 2, push = false, dirty = false, remoteAhead = false } = {}) {
  const base = tmpDir();
  const root = path.join(base, 'repo');
  mkdirSync(root, { recursive: true });

  const home = path.join(root, '.workflow');
  mkdirSync(home, { recursive: true });
  cpSync(TEMPLATE, home, { recursive: true });
  const withPush = push || remoteAhead;
  writeFileSync(path.join(home, 'config.mjs'), CONFIG(verify, rounds, withPush));
  writeFileSync(path.join(home, '.gitignore'), 'logs/\n');

  git(['init', '-q', '--initial-branch=main'], root);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  writeFileSync(path.join(root, 'app.txt'), 'base\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);

  if (push || remoteAhead) {
    const bare = path.join(base, 'origin.git');
    git(['init', '-q', '--bare', '--initial-branch=main', bare]);
    git(['remote', 'add', 'origin', bare], root);
    git(['push', '-q', '-u', 'origin', 'main'], root);
    if (remoteAhead) {
      writeFileSync(path.join(root, 'upstream.txt'), 'x\n');
      git(['add', '-A'], root);
      git(['commit', '-qm', 'upstream'], root);
      git(['push', '-q', 'origin', 'main'], root);
      git(['reset', '--hard', 'HEAD~1'], root);
    }
  }

  if (dirty) writeFileSync(path.join(root, 'dirty.txt'), 'x\n');

  // 状态与计划文件放 root 外：git clean -fd 回滚时不会把它们删掉
  const stateFile = path.join(base, 'gh-state.json');
  const planFile = path.join(base, 'agent-plan.json');
  writeFileSync(stateFile, JSON.stringify({ issues }, null, 2));
  writeFileSync(planFile, JSON.stringify([]));

  const env = {
    AGENTFLOW_HOME: home,
    AGENTFLOW_AGENT_CMD: `node ${FAKE_AGENT}`,
    MIWORKFLOW_GH: FAKE_GH,
    FAKE_GH_STATE: stateFile,
    FAKE_AGENT_PLAN: planFile,
    GIT_CEILING_DIRECTORIES: TMP
  };
  return { base, root, home, stateFile, planFile, env };
}

const plan = (s, steps) => writeFileSync(s.planFile, JSON.stringify(steps));
const readState = (s) => JSON.parse(readFileSync(s.stateFile, 'utf8'));
const issueState = (s, num) => readState(s).issues.find((i) => i.number === num);
const labelNames = (i) => i.labels.map((l) => l.name);
const comments = (i) => (i.comments ?? []).map((c) => c.body).join('\n');
const labelsOf = (s, num) => labelNames(issueState(s, num));

function cli(s, argv) {
  const base = { ...process.env };
  for (const k of ['AGENTFLOW_HOME', 'AGENTFLOW_AGENT_CMD', 'AGENTFLOW_AGENT', 'AGENTFLOW_DRY_RUN', 'AGENTFLOW_TASK', 'AGENTFLOW_RUN_ID', 'AGENTFLOW_YES']) {
    delete base[k];
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'run.mjs'), ...argv], {
    cwd: s.root, env: { ...base, ...s.env }, encoding: 'utf8'
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ── 测试 ───────────────────────────────────────────────────────────────────

test('成功：认领 → 开发 → 审查 → 提交 → 关单（且推送）', () => {
  const s = setup({ issues: [issue(1, { title: '加个文件', labels: ['ready-for-agent'] })], push: true });
  plan(s, [
    { choice: 'done', reason: '写好 note.txt 了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '看着没问题' }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 1).state, 'CLOSED');
  assert.deepEqual(labelsOf(s, 1), [], 'ready 与 in-progress 都要摘掉');
  assert.match(comments(issueState(s, 1)), /提交：/);
  assert.ok(existsSync(path.join(s.root, 'note.txt')));
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 加个文件/);
  assert.equal(gitOut(['status', '--porcelain'], s.root), '', '提交后工作区应干净');
  // 远端也拿到了这个提交
  assert.match(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), /^#1 加个文件/);
});

test('审查拒绝 → 回滚改动 + afk-failed + 评论', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })] });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'bad.txt', content: 'x' } },
    { choice: 'reject', reason: '方向根本错了' }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 1);
  assert.equal(issueState(s, 1).state, 'OPEN', '失败不关单');
  assert.ok(!existsSync(path.join(s.root, 'bad.txt')), '回滚应删掉 Agent 写的文件');
  assert.ok(labelsOf(s, 1).includes('afk-failed'));
  assert.ok(!labelsOf(s, 1).includes('in-progress'), '失败要摘掉 in-progress');
  assert.ok(labelsOf(s, 1).includes('ready-for-agent'), '保留 ready，摘掉 afk-failed 后能重新入队');
  assert.match(comments(issueState(s, 1)), /方向根本错了/);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init', '不该有提交');
});

test('验证不过、超过 ROUNDS → 回滚 + afk-failed', () => {
  const s = setup({
    issues: [issue(1, { labels: ['ready-for-agent'] })],
    verify: ['node', '-e', 'process.exit(1)'],
    rounds: 1
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'a.txt', content: '1' } },
    { choice: 'clean', reason: '没问题' },
    { choice: 'fixed', reason: '改了' }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 1);
  assert.ok(!existsSync(path.join(s.root, 'a.txt')), '回滚');
  assert.ok(labelsOf(s, 1).includes('afk-failed'));
  assert.equal(issueState(s, 1).state, 'OPEN');
});

test('验证配了且能过 → 正常提交关单', () => {
  const s = setup({
    issues: [issue(2, { labels: ['ready-for-agent'] })],
    verify: ['node', '-e', 'process.exit(0)']
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'ok.txt', content: '1' } },
    { choice: 'clean', reason: '没问题' }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 2).state, 'CLOSED');
});

test('Agent need_human → 回滚 + 把问题贴成评论 + afk-failed', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })] });
  plan(s, [{ status: 'need_human', choice: 'ask', reason: '请补充接口文档' }]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 1);
  assert.ok(labelsOf(s, 1).includes('afk-failed'));
  assert.match(comments(issueState(s, 1)), /请补充接口文档/);
});

test('Agent no_change → 不重试、afk-failed、等人判断', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })] });
  plan(s, [{ choice: 'no_change', reason: '已经满足，无需改动' }]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 1);
  assert.ok(labelsOf(s, 1).includes('afk-failed'));
  assert.match(comments(issueState(s, 1)), /已经满足/);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init');
});

test('推送失败 → 不关单、整轮停下、本地提交保留', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })], remoteAhead: true });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '没问题' }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 1, '推送失败应让整轮失败');
  assert.equal(issueState(s, 1).state, 'OPEN', '不关单');
  assert.ok(!labelsOf(s, 1).includes('afk-failed'), '推送失败不是 issue 失败，不贴 afk-failed');
  assert.ok(labelsOf(s, 1).includes('in-progress'), '留着 in-progress 提醒人处理');
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 /, '本地提交要保留');
  assert.match(r.stdout, /推送失败/);
});

test('依赖挡住 → 不算就绪，不跑', () => {
  const s = setup({
    issues: [
      issue(1, { title: '前置', body: '先做这个' }),
      issue(2, { title: '被挡', body: '- [ ] #1' , labels: ['ready-for-agent'] })
    ]
  });
  plan(s, []);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /队列空/);
  assert.equal(issueState(s, 2).state, 'OPEN');
});

test('优先级 P0 比 issue 号靠前；--issue 点名不看标签和依赖', () => {
  const s = setup({
    issues: [
      issue(1, { labels: ['ready-for-agent', 'P3'] }),
      issue(9, { labels: ['ready-for-agent', 'P0'] })
    ]
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'nine.txt', content: '1' } },
    { choice: 'clean', reason: 'ok' }
  ]);

  const r = cli(s, ['github_dev', '--max', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 9).state, 'CLOSED', 'P0 先做');
  assert.equal(issueState(s, 1).state, 'OPEN');

  // --issue 点名一个没贴 ready 的
  const s2 = setup({ issues: [issue(7, { labels: [] })] });
  plan(s2, [
    { choice: 'done', reason: '做了', file: { name: 'seven.txt', content: '1' } },
    { choice: 'clean', reason: 'ok' }
  ]);
  const r2 = cli(s2, ['github_dev', '--issue', '7']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(issueState(s2, 7).state, 'CLOSED');
});

test('工作区不干净 → 整轮不跑', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })], dirty: true });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'x', content: '1' } }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /工作区有未提交改动/);
  assert.equal(issueState(s, 1).state, 'OPEN');
  assert.deepEqual(labelsOf(s, 1), ['ready-for-agent'], '一个 gh 调用都不该发生');
});

test('--dry-run → 只报会做哪个 issue，不叫 Agent、不改盘', () => {
  const s = setup({ issues: [issue(1, { title: '加个文件', labels: ['ready-for-agent'] })] });
  plan(s, []);

  const r = cli(s, ['github_dev', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /干跑/);
  assert.match(r.stdout, /#1/);
  assert.equal(issueState(s, 1).state, 'OPEN');
  assert.deepEqual(labelsOf(s, 1), ['ready-for-agent']);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init');
  assert.equal(gitOut(['status', '--porcelain'], s.root), '', '干跑不弄脏工作区');
});
