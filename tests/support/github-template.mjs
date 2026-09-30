// dev + GitHub 工单源的端到端脚手架：假 gh + 假 Agent + 临时 git 仓库。
// 用例拆在 template-github-*.test.mjs 里：node:test 只按文件起进程，而测试体是同步 spawnSync
// （会把事件循环堵死，文件内 describe 并发也没用），所以靠拆文件让它们真并行。
// C3 模板（templates/_shared/ + templates/github/）的端到端测试：假 gh + 假 Agent + 临时 git 仓库（Core §15）。
// 模板复制出去的那一刻要是好的——所以这些测试留在内核仓库，不跟着模板进项目。
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 与 init --template github 同一套组合：先共用模板，再 GitHub 工单源
const TEMPLATES = ['_shared', 'github'].map((t) => path.join(ROOT, 'templates', t));

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
  '    if (rest[k] === "--body") i.body = rest[++k];',
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

// 假的 Agent：按 FAKE_AGENT_PLAN 数组逐次回话；step.file 时往 inputs.cwd 写文件；step.commit 时自己提交（模拟「Agent 先提交了」）
const FAKE_AGENT = path.join(TMP, 'fake-agent.mjs');
writeFileSync(FAKE_AGENT, [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  "import path from 'node:path';",
  "let raw = '';",
  'for await (const c of process.stdin) raw += c;',
  'const pkg = raw ? JSON.parse(raw) : {};',
  'const planFile = process.env.FAKE_AGENT_PLAN;',
  'const plan = JSON.parse(readFileSync(planFile, "utf8"));',
  'const step = plan.shift();',
  'writeFileSync(planFile + ".seen.jsonl", JSON.stringify({ goal: pkg.goal, session: pkg.inputs?.session, issue: pkg.inputs?.issue }) + "\\n", { flag: "a" });',
  'writeFileSync(planFile, JSON.stringify(plan));',
  'if (step.file) writeFileSync(path.join(pkg.inputs.cwd, step.file.name), step.file.content);',
  'if (step.ghComment) {',
  '  const st = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, "utf8"));',
  '  st.issues.find((i) => i.number === pkg.inputs.number).comments.push({ author: "human", at: "", body: step.ghComment });',
  '  writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st));',
  '}',
  'if (step.ghCreate) {',
  '  const st = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, "utf8"));',
  '  st.issues.push(...step.ghCreate);',
  '  writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st));',
  '}',
  'if (step.commit) {',
  '  spawnSync("git", ["add", "-A"], { cwd: pkg.inputs.cwd });',
  '  spawnSync("git", ["commit", "-qm", step.commit], { cwd: pkg.inputs.cwd });',
  '}',
  'process.stdout.write(JSON.stringify({ status: step.status ?? "ok", choice: step.choice, reason: step.reason ?? "", data: step.data ?? {}, ...(step.session ? { session: step.session } : {}) }));',
  ''
].join('\n'));

// ── 脚手架 ─────────────────────────────────────────────────────────────────

export const git = (argv, cwd) => spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true });
export const gitOut = (argv, cwd) => git(argv, cwd).stdout.trim();

export const issue = (number, { title = `issue ${number}`, body = `做 ${number}`, labels = [], state = 'OPEN' } = {}) => ({
  number, title, body, labels: labels.map((name) => ({ name })), state, comments: []
});

export const CONFIG = (verify, rounds, push) => [
  'export const DEV = null;',
  'export const REVIEWER = null;',
  `export const VERIFY = ${JSON.stringify(verify)};`,
  `export const ROUNDS = ${rounds};`,
  `export const PUSH = ${push};`,
  ''
].join('\n');

export function setup({ issues = [], verify = '', rounds = 2, push = false, dirty = false, remoteAhead = false } = {}) {
  const base = tmpDir();
  const root = path.join(base, 'repo');
  mkdirSync(root, { recursive: true });

  const home = path.join(root, '.workflow');
  mkdirSync(home, { recursive: true });
  for (const t of TEMPLATES) cpSync(t, home, { recursive: true });
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

export const plan = (s, steps) => writeFileSync(s.planFile, JSON.stringify(steps));
export const seen = (s) => { try { return readFileSync(`${s.planFile}.seen.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const readState = (s) => JSON.parse(readFileSync(s.stateFile, 'utf8'));
export const issueState = (s, num) => readState(s).issues.find((i) => i.number === num);
export const labelNames = (i) => i.labels.map((l) => l.name);
export const comments = (i) => (i.comments ?? []).map((c) => c.body).join('\n');
export const labelsOf = (s, num) => labelNames(issueState(s, num));

// 直接跑 .workflow/scripts/ 里的一个脚本（stdin JSON → stdout JSON），给工单脚本的契约测试用
export function runScript(s, name, input = {}) {
  const r = spawnSync(process.execPath, [path.join(s.home, 'scripts', `${name}.mjs`)], {
    cwd: s.root, env: { ...process.env, ...s.env }, input: JSON.stringify(input), encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

export function cli(s, argv) {
  const base = { ...process.env };
  for (const k of ['AGENTFLOW_HOME', 'AGENTFLOW_AGENT_CMD', 'AGENTFLOW_AGENT', 'AGENTFLOW_DRY_RUN', 'AGENTFLOW_TASK', 'AGENTFLOW_RUN_ID', 'AGENTFLOW_YES']) {
    delete base[k];
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'run.mjs'), ...argv], {
    cwd: s.root, env: { ...base, ...s.env }, encoding: 'utf8'
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
