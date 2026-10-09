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
// 与 init 同一套组合：先共用模板，再所选工单源（缺省 GitHub）
const templatesOf = (source) => ['_shared', source].map((t) => path.join(ROOT, 'templates', t));

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
  // ghFail: { <子命令>: { times, message } }——该子命令先报错 times 次（模拟 GitHub 服务端故障）
  'const f = state.ghFail?.[action];',
  'if (f && f.times > 0) { f.times--; save(state); die(f.message ?? "HTTP 500"); }',
  'if (argv[0] === "--version") {',
  '  state.versionChecks = (state.versionChecks ?? 0) + 1; save(state);',
  '  process.stdout.write(`gh version ${state.ghVersion ?? "2.101.0"} (2026-01-01)\\n`);',
  '} else if (argv[0] === "auth" && action === "token") {',
  '  process.stdout.write("fake-token\\n");',
  '} else if (argv[0] === "label" && action === "create") {',
  '  if (!Array.isArray(state.repoLabels)) state.repoLabels = [];',
  '  if (state.repoLabels.includes(rest[0])) die("label already exists");',
  '  state.repoLabels.push(rest[0]); save(state); out({ ok: true });',
  '} else if (action === "create") {',
  '  let title = "", body = "", labels = [];',
  '  for (let k = 0; k < rest.length; k++) {',
  '    if (rest[k] === "--title") title = rest[++k];',
  '    else if (rest[k] === "--body") body = rest[++k];',
  '    else if (rest[k] === "--body-file") body = readFileSync(rest[++k], "utf8");',
  '    else if (rest[k] === "--label") { const name = rest[++k]; if (Array.isArray(state.repoLabels) && !state.repoLabels.includes(name)) die("label not found: " + name); labels.push({ name }); }',
  '  }',
  '  const number = Math.max(0, ...state.issues.map((i) => i.number)) + 1;',
  '  state.issues.push({ number, title, body, state: "OPEN", labels, comments: [] });',
  '  save(state);',
  '  process.stdout.write(`https://github.com/o/r/issues/${number}\\n`);',
  '} else if (action === "list") {',
  '  out(state.issues.filter((i) => i.state === "OPEN").map((i) => ({ number: i.number, title: i.title, body: i.body, labels: i.labels })));',
  '} else if (action === "view") {',
  '  const i = find(rest[0]); if (!i) die("no such issue");',
  '  out({ number: i.number, title: i.title, body: i.body, labels: i.labels, comments: (i.comments ?? []).map((c) => ({ author: { login: c.author }, createdAt: c.at, body: c.body })) });',
  '} else if (action === "edit") {',
  '  const i = find(rest[0]); if (!i) die("no such issue");',
  '  for (let k = 0; k < rest.length; k++) {',
  '    if (rest[k] === "--add-label") { const name = rest[++k]; if (Array.isArray(state.repoLabels) && !state.repoLabels.includes(name)) die("label not found: " + name); if (!i.labels.some((l) => l.name === name)) i.labels.push({ name }); }',
  '    if (rest[k] === "--remove-label") { const name = rest[++k]; i.labels = i.labels.filter((l) => l.name !== name); }',
  '    if (rest[k] === "--body") i.body = rest[++k];',
  '  }',
  '  save(state); out({ ok: true });',
  '} else if (action === "comment") {',
  '  const i = find(rest[0]); if (!i) die("no such issue");',
  '  let body = "";',
  '  const attach = [];',
  '  for (let k = 0; k < rest.length; k++) {',
  '    if (rest[k] === "--body") body = rest[++k];',
  '    else if (rest[k] === "--body-file") body = readFileSync(rest[++k], "utf8");',
  '    else if (rest[k] === "--attach") attach.push(rest[++k]);',
  '  }',
  '  i.comments = (i.comments ?? []).concat([{ author: "bot", at: "2026-01-01T00:00:00Z", body, cwd: process.cwd(), attach }]);',
  '  save(state); out({ ok: true });',
  '} else if (action === "close") {',
  '  const i = find(rest[0]); if (!i) die("no such issue");',
  '  i.state = "CLOSED"; save(state); out({ ok: true });',
  '} else { die("fake gh 不认：" + argv.join(" ")); }',
  ''
].join('\n'));

// 假的 Agent：按 FAKE_AGENT_PLAN 数组逐次回话；step.file 时往 inputs.cwd 写文件；step.commit 时自己提交（模拟「Agent 先提交了」）；
// step.crash 时什么都不吐直接非 0 退出（模拟进程被杀）；step.miworkflow 时跑一条 miworkflow 命令（模拟人在 Agent 干活时敲 miworkflow stop）
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
  'writeFileSync(planFile + ".seen.jsonl", JSON.stringify({ goal: pkg.goal, session: pkg.inputs?.session, issue: pkg.inputs?.issue, ticket: pkg.inputs?.ticket, reply: pkg.inputs?.reply, budget: pkg.budget }) + "\\n", { flag: "a" });',
  'writeFileSync(planFile, JSON.stringify(plan));',
  'if (step.crash) process.exit(1);',
  `if (step.miworkflow) spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'run.mjs'))}, ...step.miworkflow], { stdio: ['ignore', 2, 2] });`,
  'if (step.file) writeFileSync(path.join(pkg.inputs.cwd, step.file.name), step.file.content);',
  'if (step.reply) writeFileSync(pkg.inputs.reply, step.reply);',
  'if (step.ghComment) {',
  '  const st = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, "utf8"));',
  '  const num = pkg.inputs.id ?? pkg.inputs.number;',
  '  st.issues.find((i) => String(i.number) === String(num)).comments.push({ author: "human", at: "", body: step.ghComment });',
  '  writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st));',
  '}',
  'if (step.tapdComment) {',
  '  const st = JSON.parse(readFileSync(process.env.FAKE_TAPD_STATE, "utf8"));',
  '  const n = st.comments.length;',
  '  st.comments.push({ id: String(n + 1), entry_type: "stories", entry_id: String(pkg.inputs.id), description: step.tapdComment, author: "human", created: `2026-01-01 00:00:${String(n).padStart(2, "0")}` });',
  '  writeFileSync(process.env.FAKE_TAPD_STATE, JSON.stringify(st));',
  '}',
  'if (step.bdComment) {',
  '  const st = JSON.parse(readFileSync(process.env.FAKE_BD_STATE, "utf8"));',
  '  const i = st.issues.find((x) => x.id === String(pkg.inputs.id));',
  '  i.comments = (i.comments ?? []).concat([{ id: `h${i.comments?.length ?? 0}`, author: "human", text: step.bdComment, created_at: "" }]);',
  '  writeFileSync(process.env.FAKE_BD_STATE, JSON.stringify(st));',
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

// 假的 fetch：以 FAKE_FETCH_ROUTES 里的 JSON 为后端（url → { status, location?, bytes? }，没登记的 404），
// 每次请求记一行 { url, auth } 到 FAKE_FETCH_ROUTES.log.jsonl。测试里不碰真网络。
const FAKE_FETCH = path.join(TMP, 'fake-fetch.mjs');
writeFileSync(FAKE_FETCH, [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'export default async function (url, init = {}) {',
  '  const file = process.env.FAKE_FETCH_ROUTES;',
  '  const auth = init.headers?.Authorization ?? init.headers?.authorization ?? null;',
  '  writeFileSync(file + ".log.jsonl", JSON.stringify({ url, auth }) + "\\n", { flag: "a" });',
  '  const r = JSON.parse(readFileSync(file, "utf8"))[url];',
  '  if (!r) return new Response("not found", { status: 404 });',
  '  if (r.needsAuth && !auth) return new Response("not found", { status: 404 });',
  '  if (r.location) return new Response(null, { status: r.status ?? 302, headers: { location: r.location } });',
  '  return new Response(Buffer.from(r.bytes ?? [], "hex"), { status: r.status ?? 200 });',
  '}',
  ''
].join('\n'));

// ── 脚手架 ─────────────────────────────────────────────────────────────────

export const git = (argv, cwd) => spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true });
export const gitOut = (argv, cwd) => git(argv, cwd).stdout.trim();

export const issue = (number, { title = `issue ${number}`, body = `做 ${number}`, labels = [], state = 'OPEN' } = {}) => ({
  number, title, body, labels: labels.map((name) => ({ name })), state, comments: []
});

// review：config.mjs 的 REVIEW。缺省 'always'——既有场景大多在验审查路径，保持它们照旧覆盖；
// 审不审（'auto'）另有用例（tests/support/dev-scenarios.mjs 里的「审查分级」）。
// branch：主分支名（缺省 main）。给别的名字（如 develop）+ push 时 origin/HEAD 指向它，
// 用来验证 dev --dir 的主分支取自 origin/HEAD 而不是写死 main。
// overrides：覆盖 config.mjs 里的任意常量（用例造「配置写错」的场景用，如 REVIEWER / REVIEW）。
export const CONFIG = (verify, rounds, push, retryDelays = [0, 0], review = 'always', idleSec = 1200, killLimit = 3, devIdleSec = 600, overrides = {}) => {
  const values = {
    DEV: null,
    REVIEWER: null,
    WORKER: '',
    REVIEW: review,
    VERIFY: verify,
    ROUNDS: rounds,
    PUSH: push,
    AGENT_RETRY_DELAYS: retryDelays,
    AGENT_IDLE_SEC: idleSec,
    AGENT_KILL_LIMIT: killLimit,
    DISCUSS_IDLE_MAX_SEC: 600,
    // 退避给测试自己控：0 = 关掉，不然连着跑两次 dev 的第二轮会被上一轮队列空记下的退避拦住
    DEV_IDLE_MAX_SEC: devIdleSec,
    ...overrides
  };
  return Object.entries(values).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join('\n') + '\n';
};

// repoLabels：给了就只认这些仓库标签（贴没有的会报错，要先 gh label create）；不给 = 什么标签都能贴
// retryDelays：Agent 基础设施故障的重试间隔，测试里缺省 [0, 0]（不真等）
// config：覆盖 config.mjs 的常量（用例造「配置写错」的场景）
// discuss：写进 source.mjs 的 DISCUSS（用例造「DISCUSS 配错」的场景）
export function setup({ source = 'github', issues = [], repoLabels, verify = '', rounds = 2, push = false, dirty = false, remoteAhead = false, fetchRoutes = {}, retryDelays = [0, 0], ticketRetryDelays = [0, 0, 0], review = 'always', idleSec, killLimit, devIdleSec, branch = 'main', config = {}, discuss } = {}) {
  const base = tmpDir();
  const root = path.join(base, 'repo');
  mkdirSync(root, { recursive: true });

  const home = path.join(root, '.workflow');
  mkdirSync(home, { recursive: true });
  for (const t of templatesOf(source)) cpSync(t, home, { recursive: true });
  // 工单系统故障的退避间隔：测试里缺省全 0（不真等）
  const srcFile = path.join(home, 'source.mjs');
  let src = readFileSync(srcFile, 'utf8')
    .replace(/(export const (?:GH|TAPD|BD)_RETRY_DELAYS = )\[[^\]]*\];/, `$1${JSON.stringify(ticketRetryDelays)};`);
  if (discuss !== undefined) src = src.replace(/(export const DISCUSS = )[^;]*;/, `$1${JSON.stringify(discuss)};`);
  writeFileSync(srcFile, src);
  writeFileSync(path.join(home, 'config.mjs'), CONFIG(verify, rounds, push || remoteAhead, retryDelays, review, idleSec, killLimit, devIdleSec, config));
  writeFileSync(path.join(home, '.gitignore'), 'logs/\n');

  git(['init', '-q', `--initial-branch=${branch}`], root);
  git(['config', 'user.email', 't@t'], root);
  git(['config', 'user.name', 't'], root);
  writeFileSync(path.join(root, 'app.txt'), 'base\n');
  git(['add', '-A'], root);
  git(['commit', '-qm', 'init'], root);

  if (push || remoteAhead) {
    const bare = path.join(base, 'origin.git');
    git(['init', '-q', '--bare', `--initial-branch=${branch}`, bare]);
    git(['remote', 'add', 'origin', bare], root);
    git(['push', '-q', '-u', 'origin', branch], root);
    // origin/HEAD 指向 origin 上的主分支：dev --dir 靠它自动认主分支（真仓库由 clone 建立这个符号 ref）
    git(['remote', 'set-head', 'origin', '-a'], root);
    if (remoteAhead) {
      writeFileSync(path.join(root, 'upstream.txt'), 'x\n');
      git(['add', '-A'], root);
      git(['commit', '-qm', 'upstream'], root);
      git(['push', '-q', 'origin', branch], root);
      git(['reset', '--hard', 'HEAD~1'], root);
    }
  }

  if (dirty) writeFileSync(path.join(root, 'dirty.txt'), 'x\n');

  // 状态与计划文件放 root 外：git clean -fd 回滚时不会把它们删掉
  const stateFile = path.join(base, 'gh-state.json');
  const planFile = path.join(base, 'agent-plan.json');
  writeFileSync(stateFile, JSON.stringify({ issues, ...(repoLabels ? { repoLabels } : {}) }, null, 2));
  writeFileSync(planFile, JSON.stringify([]));
  const fetchFile = path.join(base, 'fetch-routes.json');
  writeFileSync(fetchFile, JSON.stringify(fetchRoutes));

  const env = {
    AGENTFLOW_HOME: home,
    AGENTFLOW_AGENT_CMD: `node ${FAKE_AGENT}`,
    MIWORKFLOW_GH: FAKE_GH,
    FAKE_GH_STATE: stateFile,
    FAKE_AGENT_PLAN: planFile,
    MIWORKFLOW_FETCH: FAKE_FETCH,
    FAKE_FETCH_ROUTES: fetchFile,
    GIT_CEILING_DIRECTORIES: TMP
  };
  return { base, root, home, stateFile, planFile, fetchFile, env };
}

export const fetchLog = (s) => { try { return readFileSync(`${s.fetchFile}.log.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

export const plan = (s, steps) => writeFileSync(s.planFile, JSON.stringify(steps));
export const seen = (s) => { try { return readFileSync(`${s.planFile}.seen.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
export const readState = (s) => JSON.parse(readFileSync(s.stateFile, 'utf8'));
export const issueState = (s, num) => readState(s).issues.find((i) => i.number === num);
export const labelNames = (i) => i.labels.map((l) => l.name);
export const comments = (i) => (i.comments ?? []).map((c) => c.body).join('\n');
export const labelsOf = (s, num) => labelNames(issueState(s, num));

// 直接跑 .workflow/scripts/ 里的一个脚本（stdin JSON → stdout JSON），给工单脚本的契约测试用
export function spawnScript(s, name, input = {}, env = {}) {
  const base = { ...process.env };
  delete base.AGENTFLOW_RUN_ID;
  const r = spawnSync(process.execPath, [path.join(s.home, 'scripts', `${name}.mjs`)], {
    cwd: s.root, env: { ...base, ...s.env, ...env }, input: JSON.stringify(input), encoding: 'utf8'
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(r.stdout), stderr: r.stderr };
}

export const runScript = (s, name, input = {}, env = {}) => spawnScript(s, name, input, env).out;

export function cli(s, argv) {
  const base = { ...process.env };
  for (const k of ['AGENTFLOW_HOME', 'AGENTFLOW_AGENT_CMD', 'AGENTFLOW_AGENT', 'AGENTFLOW_DRY_RUN', 'AGENTFLOW_TASK', 'AGENTFLOW_RUN_ID', 'AGENTFLOW_YES', 'AGENTFLOW_LOOP_PID']) {
    delete base[k];
  }
  const r = spawnSync(process.execPath, [path.join(ROOT, 'run.mjs'), ...argv], {
    cwd: s.root, env: { ...base, ...s.env }, encoding: 'utf8'
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
