#!/usr/bin/env node
// run.mjs — 唯一入口（§9）：miworkflow init | new <name> | view | skill | <task> [--key value]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const KERNEL = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(readFileSync(path.join(KERNEL, 'package.json'), 'utf8')).version;
const TEMPLATES = path.join(KERNEL, 'templates');
const SKILL = path.join(KERNEL, 'SKILL.md');
const RESERVED = new Set(['init', 'new', 'view', 'skill']);
const NAME = /^[A-Za-z0-9_-]+$/;
const USAGE = [
  'usage:',
  '  miworkflow init [--template <名字>]   在项目里建 .workflow/',
  '  miworkflow new <name>                 建任务骨架 .workflow/tasks/<name>.mjs',
  '  miworkflow view                       起网页：看运行、审批、点运行',
  '  miworkflow skill                      打印写任务的完整说明（给 AI 看）',
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
else if (cmd === 'init') await init(args.template);
else if (cmd === 'new') newTask(name);
else if (cmd === 'view') {
  useHome();
  await import('./viewer/serve.mjs');
} else if (cmd === 'skill') process.stdout.write(readFileSync(SKILL, 'utf8'));
else if (every !== undefined) await loopTask(cmd, every);
else await runTask(cmd);

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
  if (template !== 'blank') copyTree(path.join(TEMPLATES, template), home, home, created, skipped);
  const rootAgents = writeRootAgents(root);

  console.log(`HOME  ${home}（模板：${template}）`);
  for (const f of created) console.log(`  + ${f}`);
  for (const f of skipped) console.log(`  = ${f}（已存在，没动）`);
  console.log(`AI 入口  ${path.join(root, 'AGENTS.md')}（${rootAgents}）`);
  console.log('写任务：miworkflow new <name>，或让 AI 读 .workflow/AGENTS.md（完整写法：miworkflow skill）');
}

function listTemplates() {
  try {
    return readdirSync(TEMPLATES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
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
    fail('usage: miworkflow new <name>（字母、数字、_、-；不能叫 init / new / view / skill）');
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

function readLock(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null; // 没有 / 半截 / 坏 JSON：都当拿不到锁信息，按陈锁处理
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
      const existing = readLock(file);
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
// Ctrl-C 不拦：终端把信号发给整个前台进程组，外层和正在跑的 run 一起结束。
function parseInterval(text) {
  const m = /^(\d+)([smh])$/.exec(text);
  const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]] : 0;
  return ms > 0 ? ms : null;
}

async function loopTask(task, every) {
  const ms = parseInterval(every);
  if (!ms) fail(`--every 要一个间隔，如 30s / 5m / 1h（拿到的是：${every || '空'}）`);
  const home = useHome();
  if (!existsSync(path.join(home, 'tasks', `${task}.mjs`))) fail(`task not found: ${task}（在 ${path.join(home, 'tasks')} 下找）`);

  const env = { ...process.env };
  delete env.AGENTFLOW_RUN_ID;
  delete env.AGENTFLOW_TASK;
  for (let round = 1; ; round++) {
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
    await new Promise((r) => setTimeout(r, ms));
  }
}

// ── 跑任务 ────────────────────────────────────────────────────────────────
async function runTask(task) {
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

  let title = task;
  try {
    const mod = await import(pathToFileURL(taskFile).href);
    title = mod.title ?? task;
    log({ primitive: 'run', status: 'running', title, say: `▶ ${title}` });
    console.log(title); // 人类可见：这次运行在干什么（§13.3）

    await mod.default({ script, agent, human, args });
    log({ primitive: 'run', status: 'ok', title, say: `✔ ${title} 完成` });
  } catch (err) {
    const message = String(err?.message ?? err);
    log({ primitive: 'run', status: 'failed', title, error: message, say: `✖ ${title} 失败：${message}` });
    console.error(err);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    releaseLock(lock);
  }
}
