#!/usr/bin/env node
// run.mjs — 唯一入口（§9）：miworkflow init | new <name> | view | skill | stop <task> | <task> [--key value]
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const KERNEL = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(path.join(KERNEL, 'package.json'), 'utf8')).version;
const TEMPLATES = path.join(KERNEL, 'templates');
// 工单源模板都先叠上这份共用模板；以 _ 开头的目录不当模板列出
const SHARED = '_shared';
// init --upgrade 时归项目所有的配置文件，与其中按行保留的写法
const PROJECT_FILES = new Set(['config.mjs', 'source.mjs']);
const ONE_LINE_EXPORT = /^(export const (\w+) = .*;)[ \t]*(?=\r?$)/gm;
const SKILL = path.join(KERNEL, 'SKILL.md');
const RESERVED = new Set(['init', 'new', 'view', 'skill', 'stop']);
const NAME = /^[A-Za-z0-9_-]+$/;
const USAGE = [
  'usage:',
  '  miworkflow init [--template <名字>]   在项目里建 .workflow/',
  '  miworkflow init --upgrade [--template <名字>]   把模板新版铺回已有的 .workflow/（项目配置保留）',
  '  miworkflow new <name>                 建任务骨架 .workflow/tasks/<name>.mjs',
  '  miworkflow view                       起网页：看运行、审批、点运行',
  '  miworkflow skill                      打印写任务的完整说明（给 AI 看）',
  '  miworkflow stop <task> [--now]        停任务：做完手头这一单再停；--now 立刻强关（杀整棵进程树）',
  '  miworkflow <task> [--key value]... [--yes] [--dry-run] [--every <30s|5m|1h>]'
].join('\n');

// init 放进 .workflow/ 的 AI 入口：只写硬规则，完整写法指向 miworkflow skill，换机器、升内核都不过时
const AGENTS_MD = [
  '# .workflow/',
  '',
  '这是 MiWorkflow 的工作流目录：`tasks/` 放任务，`scripts/` 放脚本，`tests/` 放测试，`logs/` 是运行记录（不进 Git）。',
  '',
  '**动手写或改任务 / 脚本之前，先运行 `miworkflow skill` 读完整写法。**',
  '',
  '硬规则：',
  '',
  '- 只改 `.workflow/` 里的文件，不改内核（全局装的 `miworkflow`）',
  '- 任务不 import 内核，原语和参数是传进来的：`export default async function ({ script, agent, human, args })`',
  '- 确定的步骤写成 `scripts/<动作>.mjs`（stdin 读 JSON，stdout 只写一段 JSON）；模糊的整段交给 `agent()`；高风险步骤前 `human()`',
  '- 跑：`miworkflow <task> [--key value]`；看运行、审批、点运行：`miworkflow view`',
  ''
].join('\n');

// init 同时往项目根的 AGENTS.md 追加一段入口（§3）：AI 从 cwd 往上找的是它，
// 而 `.workflow/` 是下一层，规则只写在那儿读不到。已有的 AGENTS.md 不覆盖：
// 没有这段就追加到末尾，已经有（认 marker）就不动。
const ROOT_AGENTS_MARK = '<!-- miworkflow:begin -->';
const ROOT_AGENTS_MD = [
  ROOT_AGENTS_MARK,
  '## MiWorkflow',
  '',
  '这个项目用 MiWorkflow 跑 Agent 工作流：任务在 `.workflow/tasks/`，脚本在 `.workflow/scripts/`。',
  '这一段是 `miworkflow init` 追加的入口，要改请改 `.workflow/AGENTS.md`。',
  '',
  '**动手写或改 `.workflow/` 之前，先读 `.workflow/AGENTS.md`，或运行 `miworkflow skill` 读完整写法。**',
  '',
  '- 跑任务：`miworkflow <task> [--key value]`；看运行 / 审批 / 点运行：`miworkflow view`',
  '- 只改 `.workflow/` 里的文件，不改内核（全局装的 `miworkflow`）',
  '<!-- miworkflow:end -->',
  ''
].join('\n');

const argv = process.argv.slice(2);
const { positional, args, dryRun, every, forward } = parseArgv(argv);
const [cmd, name] = positional;

// 内核自身的开关，早于任务分派。注意 -v / -h 不是 -- 开头，parseArgv 会当成任务名
if (argv[0] === '--version' || argv[0] === '-v') process.stdout.write(`${VERSION}\n`);
else if (argv[0] === '--help' || argv[0] === '-h') process.stdout.write(`${USAGE}\n`);
else if (!cmd) fail(USAGE);
else if (cmd === 'init') await (args.upgrade ? upgrade(args.template) : init(args.template));
else if (cmd === 'new') newTask(name);
else if (cmd === 'view') {
  useHome();
  await import('./viewer/serve.mjs');
} else if (cmd === 'skill') process.stdout.write(readFileSync(SKILL, 'utf8'));
else if (cmd === 'stop') await stopTask(name, args.now === true);
else if (every !== undefined) await loopTask(cmd, every);
else await runTask(cmd, args);

// ── 参数 ──────────────────────────────────────────────────────────────────
// --key value / --key=value / --flag(=true)；值一律是字符串。--yes、--dry-run、--every 归内核，不进 args。
// forward 是去掉 --every 之后的原始 argv，循环的每一轮原样交给子进程
function parseArgv(argv) {
  const positional = [];
  const args = {};
  const forward = [];
  let dryRun = false;
  let every;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--every' || a.startsWith('--every=')) {
      const next = argv[i + 1];
      if (a !== '--every') every = a.slice('--every='.length);
      else every = next !== undefined && !next.startsWith('--') ? (i++, next) : '';
      continue;
    }
    forward.push(a);
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    if (a === '--yes') continue; // core 自己看 process.argv
    if (a === '--dry-run') {
      dryRun = true;
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 2) {
      args[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) forward.push(next);
    args[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
  }
  return { positional, args, dryRun, every, forward };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ── HOME（§3）：AGENTFLOW_HOME → 往上找 .workflow/ → 报错；不回落到当前目录 ──
function findHome() {
  if (process.env.AGENTFLOW_HOME) return path.resolve(process.env.AGENTFLOW_HOME);
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (isDir(path.join(dir, '.workflow'))) return path.join(dir, '.workflow');
    if (path.dirname(dir) === dir) return null;
  }
}

// core 与 viewer 都从 env 读 HOME，必须在加载它们之前写回
function useHome() {
  const home = findHome();
  if (!home) fail('找不到 .workflow/（从当前目录一路往上找过了）。先在项目里跑 miworkflow init，或设 AGENTFLOW_HOME');
  process.env.AGENTFLOW_HOME = home;
  return home;
}

// ── init ──────────────────────────────────────────────────────────────────
async function init(template) {
  const choices = ['blank', ...listTemplates()];
  template ??= process.stdin.isTTY && choices.length > 1 ? await pickTemplate(choices) : 'blank';
  if (!choices.includes(template)) fail(`没有这个模板：${template}（可选：${choices.join(' / ')}）`);

  const root = projectRoot();
  const home = path.join(root, '.workflow');
  const created = [];
  const skipped = [];
  for (const dir of ['tasks', 'scripts']) mkdirSync(path.join(home, dir), { recursive: true });
  place(path.join(home, '.gitignore'), home, created, skipped, (f) => writeFileSync(f, 'logs/\n'));
  place(path.join(home, 'AGENTS.md'), home, created, skipped, (f) => writeFileSync(f, AGENTS_MD));
  if (template !== 'blank') {
    for (const part of [SHARED, template]) copyTree(path.join(TEMPLATES, part), home, home, created, skipped);
  }
  const rootAgents = writeRootAgents(root);

  console.log(`HOME  ${home}（模板：${template}）`);
  for (const f of created) console.log(`  + ${f}`);
  for (const f of skipped) console.log(`  = ${f}（已存在，没动）`);
  console.log(`AI 入口  ${path.join(root, 'AGENTS.md')}（${rootAgents}）`);
  console.log('写任务：miworkflow new <name>，或让 AI 读 .workflow/AGENTS.md（完整写法：miworkflow skill）');
}

function listTemplates() {
  try {
    return readdirSync(TEMPLATES, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name);
  } catch {
    return [];
  }
}

async function pickTemplate(choices) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const menu = choices.map((c, i) => `  ${i + 1}) ${c === 'blank' ? '空白（只建目录）' : c}`).join('\n');
  const answer = (await rl.question(`选模板：\n${menu}\n编号 [1]：`)).trim();
  rl.close();
  return choices[(Number(answer) || 1) - 1] ?? fail(`没有这个编号：${answer}`);
}

// 建在 git 仓库根；不在仓库里就建在当前目录
function projectRoot() {
  try {
    return path.resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim());
  } catch {
    return process.cwd();
  }
}

// 已有的文件一个不覆盖
function place(file, home, created, skipped, write) {
  const rel = path.relative(home, file).split(path.sep).join('/');
  if (existsSync(file)) return skipped.push(rel);
  mkdirSync(path.dirname(file), { recursive: true });
  write(file);
  created.push(rel);
}

function copyTree(src, dst, home, created, skipped) {
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(from, to, home, created, skipped);
    else place(to, home, created, skipped, (f) => copyFileSync(from, f));
  }
}

// ── init --upgrade（§15）─────────────────────────────────────────────────
// 模板改了（修 bug、改契约），已经 init 过的项目靠它跟上，不用两边各改一遍。
// 模板里的文件直接覆盖；项目配置文件（PROJECT_FILES）以模板新版为底，项目里「一行写完的 export const」原样保留
// （WORKSPACE_ID、PUSH、COMMIT_FORMAT 这类）。改动过的旧文件先备份到 logs/upgrade-<时间>/。
// 模板里没有的文件（项目自己写的任务、脚本）不碰；init 生成的 AGENTS.md、.gitignore 不碰。
async function upgrade(template) {
  const home = findHome();
  if (!home || !isDir(home)) fail('找不到 .workflow/（从当前目录一路往上找过了）。先在项目里跑 miworkflow init');
  const choices = listTemplates();
  template ??= detectTemplate(home, choices);
  if (!choices.includes(template)) fail(`没有这个模板：${template}（可选：${choices.join(' / ')}）`);

  const files = new Map();
  for (const part of [SHARED, template]) listFiles(path.join(TEMPLATES, part)).forEach((rel) => files.set(rel, path.join(TEMPLATES, part, rel)));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const backup = path.join(home, 'logs', `upgrade-${stamp}`);
  const lines = [];
  let same = 0;
  for (const [rel, src] of files) {
    const dst = path.join(home, rel);
    if (!existsSync(dst)) {
      mkdirSync(path.dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      lines.push(`  + ${rel}`);
      continue;
    }
    const cur = readFileSync(dst);
    let next = readFileSync(src);
    let note = '已覆盖';
    if (PROJECT_FILES.has(rel)) {
      const merged = keepProjectValues(cur.toString('utf8'), next.toString('utf8'));
      next = Buffer.from(merged.text, 'utf8');
      note = [
        '跟模板走',
        merged.kept.length ? `保留项目的 ${merged.kept.join('、')}` : '',
        merged.dropped.length ? `模板已没有、丢掉了 ${merged.dropped.join('、')}` : ''
      ].filter(Boolean).join('，');
    }
    if (cur.equals(next)) { same++; continue; }
    mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
    copyFileSync(dst, path.join(backup, rel));
    writeFileSync(dst, next);
    lines.push(`  ~ ${rel}（${note}）`);
  }

  console.log(`升级 HOME  ${home}（模板：${template}）`);
  for (const l of lines) console.log(l);
  console.log(`  = 另有 ${same} 个文件与模板一致，没动`);
  if (lines.some((l) => l.startsWith('  ~'))) console.log(`改动前的旧文件备份在 ${backup}`);
}

// 没给 --template 时认：模板的文件在 .workflow/ 里全都在的那一个
function detectTemplate(home, choices) {
  const hits = choices.filter((t) => listFiles(path.join(TEMPLATES, t)).every((rel) => existsSync(path.join(home, rel))));
  if (hits.length !== 1) fail(`认不出 .workflow/ 用的是哪个模板${hits.length ? `（${hits.join(' / ')} 都像）` : ''}，加 --template <名字>`);
  return hits[0];
}

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? listFiles(path.join(dir, e.name), `${prefix}${e.name}/`)
    : [`${prefix}${e.name}`]));
}

// 以模板新版为底，同名的一行 export const 换回项目的写法；项目有、模板已经没有的报出来
function keepProjectValues(cur, next) {
  const mine = new Map([...cur.matchAll(ONE_LINE_EXPORT)].map((m) => [m[2], m[1]]));
  const names = new Set([...next.matchAll(/^export (?:const|let|(?:async )?function) (\w+)/gm)].map((m) => m[1]));
  const kept = [];
  const text = next.replace(ONE_LINE_EXPORT, (line, whole, name) => {
    const own = mine.get(name);
    if (own === undefined || own === whole) return line;
    kept.push(name);
    return own;
  });
  const dropped = [...mine.keys()].filter((k) => !names.has(k));
  return { text, kept, dropped };
}

// 返回值是「项目根 AGENTS.md 怎么处理了」，给 init 拼成一行输出
function writeRootAgents(root) {
  const file = path.join(root, 'AGENTS.md');
  if (!existsSync(file)) {
    writeFileSync(file, ROOT_AGENTS_MD);
    return '新建';
  }
  const cur = readFileSync(file, 'utf8');
  if (cur.includes(ROOT_AGENTS_MARK)) return '已有 MiWorkflow 段，没动';
  writeFileSync(file, `${cur}${cur.endsWith('\n') ? '' : '\n'}\n${ROOT_AGENTS_MD}`);
  return '已追加 MiWorkflow 段';
}

// ── new ───────────────────────────────────────────────────────────────────
function newTask(task) {
  if (!task || !NAME.test(task) || RESERVED.has(task)) {
    fail('usage: miworkflow new <name>（字母、数字、_、-；不能叫 init / new / view / skill / stop）');
  }
  const home = findHome();
  if (!home || !isDir(home)) fail('找不到 .workflow/。先在项目里跑 miworkflow init');

  const file = path.join(home, 'tasks', `${task}.mjs`);
  if (existsSync(file)) fail(`已存在，不覆盖：${file}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, [
    `export const title = '${task}';`,
    '',
    'export default async function ({ script, agent, human, args }) {',
    "  // 确定的步骤：写成 scripts/<action>.mjs，这里 await script('<action>', { ... })",
    "  // 模糊的整段：await agent('目标', { inputs: { ... } })，按返回的 choice 分支",
    "  // 高风险步骤之前：await human('确认 ...')",
    '}',
    ''
  ].join('\n'));
  console.log(`+ ${file}`);
  console.log(`跑：miworkflow ${task}；写法：miworkflow skill`);
}

// ── 任务锁（§9）──────────────────────────────────────────────────────────
// 同一 task 同时只允许一个 run：起跑前在 logs/ 下建 <task>.lock（logs/ 不进 Git，§12）。
// 锁里是 { pid, runId, at }；进程没了（被杀 / 断电 / Ctrl-C）的锁视为陈锁，直接接管。
function lockFile(HOME, task) {
  return path.join(HOME, 'logs', `${task}.lock`);
}

// 锁、循环标记、停止请求都是一小段 JSON
function readJson(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null; // 没有 / 半截 / 坏 JSON：都当拿不到，锁按陈锁处理
  }
}

// 跨平台判活：signal 0 只探测不真发；EPERM 说明进程在，只是不归我们管（§9）
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// 用 'wx'（只在不存在时创建）原子抢锁；已存在且 pid 还活着 → held:false 交给调用方跳过
function acquireLock(HOME, task, runId) {
  const file = lockFile(HOME, task);
  mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ pid: process.pid, runId, at: new Date().toISOString() })}\n`;
  for (let i = 0; i < 5; i++) {
    try {
      writeFileSync(file, body, { flag: 'wx' });
      return { file, held: true, existing: null };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readJson(file);
      if (existing && pidAlive(existing.pid)) return { file, held: false, existing };
      rmSync(file, { force: true }); // 陈锁 / 坏文件：删掉重抢（下一轮 wx 要么我拿到，要么别人拿到）
    }
  }
  writeFileSync(file, body); // 极端竞争兜底：直接接管，别死循环
  return { file, held: true, existing: null };
}

function releaseLock(lock) {
  if (!lock?.held) return;
  try {
    rmSync(lock.file, { force: true });
  } catch { /* 已经没了就算了 */ }
}

// ── 循环运行（§9）：--every <间隔> ──────────────────────────────────────────
// 外层循环不是 run：不加载 core、不写日志、不拿锁。每一轮起一个子进程当全新的 run
// （删掉 AGENTFLOW_RUN_ID / AGENTFLOW_TASK，子进程自己生成），间隔从上一轮结束算，所以不会自己重叠。
// Ctrl-C 只顺手删掉循环标记：终端把信号发给整个前台进程组，外层和正在跑的 run 一起结束。
// 循环在 logs/<task>.loop 记下 pid，miworkflow stop 靠它找到循环；收到停止请求就不再起下一轮（等的时候也照查）。
function parseInterval(text) {
  const m = /^(\d+)([smh])$/.exec(text);
  const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]] : 0;
  return ms > 0 && ms <= 2 ** 31 - 1 ? ms : null; // setTimeout 超过约 24.8 天会立刻触发，循环就空转了
}

async function loopTask(task, every) {
  const ms = parseInterval(every);
  if (!ms) fail(`--every 要一个间隔，如 30s / 5m / 1h，最长 596h（拿到的是：${every || '空'}）`);
  const home = useHome();
  if (!existsSync(path.join(home, 'tasks', `${task}.mjs`))) fail(`task not found: ${task}（在 ${path.join(home, 'tasks')} 下找）`);

  const marker = loopFile(home, task);
  const other = readJson(marker);
  if (other && other.pid !== process.pid && pidAlive(other.pid)) {
    // 同一任务只留一个循环：停止请求按任务找循环，两个就分不清
    console.log(`${task} 已有循环在跑（pid ${other.pid}）`);
    return;
  }
  writeJson(marker, { pid: process.pid, at: new Date().toISOString() });
  const onSignal = (sig) => {
    dropIfOwner(marker, process.pid);
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const env = { ...process.env, AGENTFLOW_LOOP_PID: String(process.pid) };
  delete env.AGENTFLOW_RUN_ID;
  delete env.AGENTFLOW_TASK;
  const stopped = () => readJson(stopFile(home, task))?.loopPid === process.pid;
  let round = 0;
  while (!stopped()) {
    round++;
    console.log(`[every ${every}] 第 ${round} 轮`);
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...forward], { env, stdio: 'inherit' });
      child.on('error', (err) => {
        console.error(err);
        resolve(1);
      });
      child.on('exit', (c, sig) => resolve(c ?? sig));
    });
    if (code !== 0) console.error(`[every ${every}] 第 ${round} 轮退出码 ${code}，继续`);
    for (const until = Date.now() + ms; Date.now() < until && !stopped();) {
      await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
    }
  }
  rmSync(stopFile(home, task), { force: true });
  dropIfOwner(marker, process.pid);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  console.log(`[every ${every}] 收到停止请求，跑了 ${round} 轮，退出`);
}

// ── 停止（§9）──────────────────────────────────────────────────────────────
// 两种：默认「做完手头这一单再停」——写 logs/<task>.stop，任务用 stopping() 查，在自己定的边界停下；
// 不查的任务就把这次跑完；--every 循环跑完这一轮不再起下一轮。--now 立刻强关：杀整棵进程树，
// 替被杀的 run 补一条终态记录、删锁；停在半路的步骤留下什么（改动、外部状态）原样交给人收拾。
// 按任务找目标：同一任务同时只有一个 run（任务锁）、一个循环（循环标记）。
// 停止请求写明对准谁（runId / 循环 pid），过期的请求对不上任何新 run，不会误停。
function stopFile(HOME, task) {
  return path.join(HOME, 'logs', `${task}.stop`);
}

function loopFile(HOME, task) {
  return path.join(HOME, 'logs', `${task}.loop`);
}

// 先写临时文件再改名：读的一方不会读到半个
function writeJson(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(body)}\n`);
  renameSync(`${file}.tmp`, file);
}

function dropIfOwner(file, pid) {
  if (readJson(file)?.pid === pid) rmSync(file, { force: true });
}

// 这次 run 有没有被要求停：请求对准这个 runId，或对准它所在的 --every 循环
function stopRequested(HOME, task, runId) {
  const s = readJson(stopFile(HOME, task));
  if (!s) return false;
  return (s.runId != null && s.runId === runId)
    || (s.loopPid != null && String(s.loopPid) === process.env.AGENTFLOW_LOOP_PID);
}

async function stopTask(task, now) {
  if (!task || !NAME.test(task) || RESERVED.has(task)) fail('usage: miworkflow stop <task> [--now]');
  const home = useHome();
  const lock = readJson(lockFile(home, task));
  const run = lock && pidAlive(lock.pid) ? lock : null;
  const loopRec = readJson(loopFile(home, task));
  const loop = loopRec && pidAlive(loopRec.pid) ? loopRec : null;
  if (!run && !loop) {
    rmSync(stopFile(home, task), { force: true }); // 没人认领的旧请求
    console.log(`${task} 没在跑`);
    return;
  }

  if (!now) {
    writeJson(stopFile(home, task), { runId: run?.runId ?? null, loopPid: loop?.pid ?? null, at: new Date().toISOString() });
    if (run) console.log(`已请求停止：${task} 做完手头这一单就停（pid ${run.pid}，run ${run.runId}）`);
    if (loop) console.log(`--every 循环（pid ${loop.pid}）${run ? '这一轮跑完' : '马上'}退出，不再起下一轮`);
    console.log(`要立刻强关：miworkflow stop ${task} --now`);
    return;
  }

  for (const p of [loop?.pid, run?.pid]) if (p) killTree(p);
  const left = await waitDead([loop?.pid, run?.pid].filter(Boolean));
  if (left.length) fail(`没杀掉：pid ${left.join('、')}（可能没权限），锁和记录都没动`);
  if (run) closeRun(home, task, run.runId);
  if (run) dropIfOwner(lockFile(home, task), run.pid);
  if (loop) dropIfOwner(loopFile(home, task), loop.pid);
  rmSync(stopFile(home, task), { force: true });
  if (loop) console.log(`已强关 ${task} 的 --every 循环（pid ${loop.pid}）`);
  if (run) {
    console.log(`已强关 ${task}（pid ${run.pid}，run ${run.runId}）`);
    console.log('停在半路的步骤没有收尾：工作区可能留着改动、外部状态（比如工单标签）可能还是进行中，看这次运行的记录再收拾');
  }
}

// 杀整棵进程树：Agent CLI 和它起的命令都在 run 下面。Windows 用 taskkill /T；其它平台用 ps 找出全部子孙
function killTree(pid) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* 已经没了 */ }
    return;
  }
  const kids = new Map();
  try {
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
      const [p, pp] = line.trim().split(/\s+/).map(Number);
      if (p) kids.set(pp, [...(kids.get(pp) ?? []), p]);
    }
  } catch { /* 没有 ps：只杀根 */ }
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...(kids.get(all[i]) ?? []));
  for (const p of all) {
    try {
      process.kill(p, 'SIGKILL');
    } catch { /* 已经没了 */ }
  }
}

async function waitDead(pids, ms = 5000) {
  const until = Date.now() + ms;
  while (pids.some(pidAlive) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return pids.filter(pidAlive);
}

// 被杀的 run 自己写不了终态：照 core.log 的形状补一条 failed（进程已死，seq 接着日志里最大的往下排）
function closeRun(HOME, task, runId) {
  const file = path.join(HOME, 'logs', `${runId}.jsonl`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // 还没写第一行就被杀了
  }
  const rows = text.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return {}; }
  });
  if (rows.some((r) => r.primitive === 'run' && r.status !== 'running')) return;
  const title = rows.find((r) => r.primitive === 'run')?.title ?? task;
  const row = {
    runId,
    task,
    seq: Math.max(0, ...rows.map((r) => Number(r.seq) || 0)) + 1,
    at: new Date().toISOString(),
    gitSha: rows.findLast((r) => 'gitSha' in r)?.gitSha ?? null,
    primitive: 'run',
    status: 'failed',
    title,
    error: '被强行停止（miworkflow stop --now）',
    say: `■ ${title} 被强行停止`
  };
  // 被杀时最后一行可能只写了半截：另起一行，别粘上去
  appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}${JSON.stringify(row)}\n`);
}

// ── 跑任务 ────────────────────────────────────────────────────────────────
async function runTask(task, args = {}) {
  useHome();
  // 先定 runId，再加载 core（core 里 runId 是延迟解析的）
  process.env.AGENTFLOW_TASK = task;
  process.env.AGENTFLOW_RUN_ID ??= randomUUID();
  if (dryRun) process.env.AGENTFLOW_DRY_RUN = '1';

  const { log, script, agent, human, HOME } = await import('./core.mjs');
  const taskFile = path.join(HOME, 'tasks', `${task}.mjs`);
  if (!existsSync(taskFile)) fail(`task not found: ${task}（在 ${path.join(HOME, 'tasks')} 下找）`);

  const lock = acquireLock(HOME, task, process.env.AGENTFLOW_RUN_ID);
  if (!lock.held) {
    // 有意跳过：不是出错，退出码 0（§9）
    console.log(`${task} 已在跑（pid ${lock.existing.pid}，run ${lock.existing.runId}）`);
    return;
  }

  // 正常结束 / 抛异常都靠 finally 释放；Ctrl-C / kill 走信号，删完锁再把信号抛回去
  const onSignal = (sig) => {
    releaseLock(lock);
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // 停止请求（miworkflow stop <task>）：任务在自己定的边界查它，比如做完一张单再挑下一张之前
  const runId = process.env.AGENTFLOW_RUN_ID;
  const stopping = () => stopRequested(HOME, task, runId);

  let title = task;
  try {
    const mod = await import(pathToFileURL(taskFile).href);
    title = mod.title ?? task;
    log({ primitive: 'run', status: 'running', title, inputs: args, say: `▶ ${title}` });
    console.log(title); // 人类可见：这次运行在干什么（§13.3）

    await mod.default({ script, agent, human, args, stopping });
    log({ primitive: 'run', status: 'ok', title, say: `✔ ${title} 完成${stopping() ? '（收到停止请求，停下了）' : ''}` });
  } catch (err) {
    const message = String(err?.message ?? err);
    log({ primitive: 'run', status: 'failed', title, error: message, say: `✖ ${title} 失败：${message}` });
    console.error(err);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // 对准这次 run 的请求到此用完；对准循环的留给循环收
    if (readJson(stopFile(HOME, task))?.runId === runId && !process.env.AGENTFLOW_LOOP_PID) rmSync(stopFile(HOME, task), { force: true });
    releaseLock(lock);
  }
}
