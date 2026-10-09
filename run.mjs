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
  '  miworkflow stop <task> [任务参数]     只停对应实例（如 stop dev --dir wt1）；不带参数停这个任务的全部实例',
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
else if (cmd === 'stop') await stopTask(name, args.now === true, args);
else if (every !== undefined) await loopTask(cmd, every, args);
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

// ── 任务实例（§9）────────────────────────────────────────────────────────
// 同一「任务 + 实例」同时只允许一个 run / 一个循环 / 一份停止请求，文件名都从身份派生：
// 没实例是 <task>.lock，有实例是 <task>@<实例>.lock。实例名只有任务自己知道（导出 instance(args)，
// 如 dev 拿工位目录名）；内核不认识 --dir 这类业务概念。任务没导出 instance、或返回空，一切照旧。

// 实例名进文件名：只留 A-Za-z0-9_-，其余按 %XX 转义（目录名里的斜杠、空格、中文都落在同一套规则里）
function instanceTag(inst) {
  return [...String(inst)].map((c) => (/^[A-Za-z0-9_-]$/.test(c)
    ? c
    : [...Buffer.from(c, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''))).join('');
}

// 转回来只为人看：给人讲的是目录名 wt/2，不是文件名里的 wt%2F2
function instanceName(tag) {
  const bytes = [];
  for (const m of tag.matchAll(/%([0-9A-F]{2})|(.)/g)) {
    if (m[2] === undefined) bytes.push(Number.parseInt(m[1], 16));
    else bytes.push(...Buffer.from(m[2], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

// 身份 = 任务 + 实例；消息里这么叫（dev@wt2）
function identity(task, inst) {
  return inst ? `${task}@${inst}` : task;
}

// 文件名里的身份：实例名先转义（dev@wt%2F2.lock）
function stateFile(HOME, kind, task, inst) {
  return path.join(HOME, 'logs', `${task}${inst ? `@${instanceTag(inst)}` : ''}.${kind}`);
}

function lockFile(HOME, task, inst) {
  return stateFile(HOME, 'lock', task, inst);
}

function loopFile(HOME, task, inst) {
  return stateFile(HOME, 'loop', task, inst);
}

function stopFile(HOME, task, inst) {
  return stateFile(HOME, 'stop', task, inst);
}

// 任务模块（title / default / 可选的 instance）
async function loadTask(HOME, task) {
  const file = path.join(HOME, 'tasks', `${task}.mjs`);
  if (!existsSync(file)) fail(`task not found: ${task}（在 ${path.join(HOME, 'tasks')} 下找）`);
  return import(pathToFileURL(file).href);
}

// 向任务要实例名：没导出 instance、返回空（null / undefined / 空白）→ 没实例，跟以前一样。
// 只把 args 交给任务，内核不认识它拿什么算的（dev 用 --dir，别的任务用别的）。
async function taskInstance(mod, args, task) {
  let raw;
  try {
    raw = await mod.instance?.(args);
  } catch (err) {
    return fail(`${task} 的 instance() 报错：${String(err?.message ?? err)}`);
  }
  return raw == null ? '' : String(raw).trim();
}

// ── 任务锁（§9）──────────────────────────────────────────────────────────
// 同一「任务 + 实例」同时只允许一个 run：起跑前在 logs/ 下建锁（logs/ 不进 Git，§12）。
// 锁里是 { pid, runId, instance, at }；进程没了（被杀 / 断电 / Ctrl-C）的锁视为陈锁，直接接管。

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
function acquireLock(HOME, task, inst, runId) {
  const file = lockFile(HOME, task, inst);
  mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ pid: process.pid, runId, instance: inst || null, at: new Date().toISOString() })}\n`;
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
// （删掉 AGENTFLOW_RUN_ID / AGENTFLOW_TASK，子进程自己生成；子进程按同样的 args 算出实例，
// 锁与停止请求都落在同一个身份上），间隔从上一轮结束算，所以不会自己重叠。
// Ctrl-C 只顺手删掉循环标记：终端把信号发给整个前台进程组，外层和正在跑的 run 一起结束。
// 循环在 logs/<task>[@<实例>].loop 记下 pid，miworkflow stop 靠它找到循环；收到停止请求就不再起下一轮（等的时候也照查）。
function parseInterval(text) {
  const m = /^(\d+)([smh])$/.exec(text);
  const ms = m ? Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2]] : 0;
  return ms > 0 && ms <= 2 ** 31 - 1 ? ms : null; // setTimeout 超过约 24.8 天会立刻触发，循环就空转了
}

async function loopTask(task, every, args = {}) {
  const ms = parseInterval(every);
  if (!ms) fail(`--every 要一个间隔，如 30s / 5m / 1h，最长 596h（拿到的是：${every || '空'}）`);
  const home = useHome();
  const inst = await taskInstance(await loadTask(home, task), args, task);
  const me = identity(task, inst);

  const marker = loopFile(home, task, inst);
  const other = readJson(marker);
  if (other && other.pid !== process.pid && pidAlive(other.pid)) {
    // 同一「任务 + 实例」只留一个循环：停止请求按身份找循环，两个就分不清
    console.log(`${me} 已有循环在跑（pid ${other.pid}）`);
    return;
  }
  writeJson(marker, { pid: process.pid, instance: inst || null, at: new Date().toISOString() });
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
  const stopped = () => readJson(stopFile(home, task, inst))?.loopPid === process.pid;
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
  rmSync(stopFile(home, task, inst), { force: true });
  dropIfOwner(marker, process.pid);
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  console.log(`[every ${every}] 收到停止请求，跑了 ${round} 轮，退出`);
}

// ── 停止（§9）──────────────────────────────────────────────────────────────
// 两种：默认「做完手头这一单再停」——写停止请求 logs/<task>[@<实例>].stop，任务用 stopping() 查，在自己定的边界停下；
// 不查的任务就把这次跑完；--every 循环跑完这一轮不再起下一轮。--now 立刻强关：杀整棵进程树，
// 替被杀的 run 补一条终态记录、删锁；停在半路的步骤留下什么（改动、外部状态）原样交给人收拾。
// 目标按「任务 + 实例」找：带任务参数只停那一个实例，不带参数停这个任务的全部实例。
// 停止请求写明对准谁（runId / 循环 pid），过期的请求对不上任何新 run，不会误停。

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
function stopRequested(HOME, task, inst, runId) {
  const s = readJson(stopFile(HOME, task, inst));
  if (!s) return false;
  return (s.runId != null && s.runId === runId)
    || (s.loopPid != null && String(s.loopPid) === process.env.AGENTFLOW_LOOP_PID);
}

// 除了内核开关 --now，还给没给任务参数（如 --dir wt1）
function hasTaskArgs(args) {
  return Object.keys(args).some((k) => k !== 'now');
}

// logs/ 里属于这个任务的全部身份：dev.lock / dev@wt1.loop / dev@wt2.stop …。
// 标签里没有 `.`（转义过），所以 @ 后面的部分一定到扩展名前为止；返回的是人看的实例名。
function scanInstances(HOME, task) {
  let files;
  try {
    files = readdirSync(path.join(HOME, 'logs'));
  } catch {
    return []; // 还没跑过任何任务
  }
  const re = new RegExp(`^${task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:@([A-Za-z0-9_%-]+))?\\.(?:lock|loop|stop)$`);
  const insts = new Set();
  for (const f of files) {
    const m = re.exec(f);
    if (m) insts.add(m[1] === undefined ? '' : instanceName(m[1]));
  }
  return [...insts];
}

// 停谁：带任务参数就问任务要实例（只停这一个）；不带参数就扫 logs/ 找这个任务的全部身份，
// 一个都找不到时也回一条「没实例」的，好把没人认领的旧请求清掉、照旧报「没在跑」。
async function stopTargets(home, task, args) {
  if (hasTaskArgs(args)) {
    const inst = await taskInstance(await loadTask(home, task), args, task);
    return [inst];
  }
  const found = scanInstances(home, task);
  return found.length ? found : [''];
}

async function stopTask(task, now, args = {}) {
  if (!task || !NAME.test(task) || RESERVED.has(task)) fail('usage: miworkflow stop <task> [--now]');
  const home = useHome();

  const targets = await stopTargets(home, task, args);
  const live = [];
  for (const inst of targets) {
    const lock = readJson(lockFile(home, task, inst));
    const run = lock && pidAlive(lock.pid) ? lock : null;
    const loopRec = readJson(loopFile(home, task, inst));
    const loop = loopRec && pidAlive(loopRec.pid) ? loopRec : null;
    if (run || loop) live.push({ inst, run, loop });
    else rmSync(stopFile(home, task, inst), { force: true }); // 没人认领的旧请求
  }
  if (!live.length) {
    console.log(`${identity(task, targets[0])} 没在跑`);
    return;
  }

  if (!now) {
    for (const t of live) {
      writeJson(stopFile(home, task, t.inst), { runId: t.run?.runId ?? null, loopPid: t.loop?.pid ?? null, instance: t.inst || null, at: new Date().toISOString() });
      const me = identity(task, t.inst);
      if (t.run) console.log(`已请求停止：${me} 做完手头这一单就停（pid ${t.run.pid}，run ${t.run.runId}）`);
      if (t.loop) console.log(`${me} 的 --every 循环（pid ${t.loop.pid}）${t.run ? '这一轮跑完' : '马上'}退出，不再起下一轮`);
    }
    // 带了任务参数就原样带上：光写 stop <task> --now 会把这个任务的全部实例都杀掉
    console.log(`要立刻强关：miworkflow ${forward.join(' ')} --now`);
    return;
  }

  const pids = live.flatMap((t) => [t.loop?.pid, t.run?.pid]).filter(Boolean);
  for (const p of pids) killTree(p);
  const left = await waitDead(pids);
  if (left.length) fail(`没杀掉：pid ${left.join('、')}（可能没权限），锁和记录都没动`);
  for (const t of live) {
    const me = identity(task, t.inst);
    if (t.run) closeRun(home, task, t.run.runId);
    if (t.run) dropIfOwner(lockFile(home, task, t.inst), t.run.pid);
    if (t.loop) dropIfOwner(loopFile(home, task, t.inst), t.loop.pid);
    rmSync(stopFile(home, task, t.inst), { force: true });
    if (t.loop) console.log(`已强关 ${me} 的 --every 循环（pid ${t.loop.pid}）`);
    if (t.run) {
      console.log(`已强关 ${me}（pid ${t.run.pid}，run ${t.run.runId}）`);
      console.log('停在半路的步骤没有收尾：工作区可能留着改动、外部状态（比如工单标签）可能还是进行中，看这次运行的记录再收拾');
    }
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

// 任务失败：普通 Error（`throw new Error('…')`）是任务有意给人的结论，终端只打一行结论，栈对人没用；
// 其它异常（TypeError、SyntaxError 等）多半是代码 bug，照旧打完整栈。不管哪种，栈都进 JSONL 事后能查。
function failRow(title, err, extra = {}) {
  const message = String(err?.message ?? err);
  const say = `✖ ${title} 失败：${message}`;
  // 严格判 `constructor === Error`：子类（SyntaxError 等）和跨模块抛出的都按 bug 处理，宁可多打栈
  if (err?.constructor === Error) console.error(say);
  else console.error(err);
  return { primitive: 'run', status: 'failed', title, error: message, stack: err?.stack, say, ...extra };
}

// ── 跑任务 ────────────────────────────────────────────────────────────────
async function runTask(task, args = {}) {
  useHome();
  // 先定 runId，再加载 core（core 里 runId 是延迟解析的）
  process.env.AGENTFLOW_TASK = task;
  process.env.AGENTFLOW_RUN_ID ??= randomUUID();
  if (dryRun) process.env.AGENTFLOW_DRY_RUN = '1';

  const { log, script, agent, human, HOME } = await import('./core.mjs');
  // 实例名要先问任务（锁就按「任务 + 实例」建），所以模块要提前加载。
  // 加载失败（语法错）也记一条 failed：这是这次 run 的全部交代，人从日志里看得到。
  let mod;
  try {
    mod = await loadTask(HOME, task);
  } catch (err) {
    log(failRow(task, err, { inputs: args }));
    process.exitCode = 1;
    return;
  }
  const inst = await taskInstance(mod, args, task);
  const me = identity(task, inst);

  const lock = acquireLock(HOME, task, inst, process.env.AGENTFLOW_RUN_ID);
  if (!lock.held) {
    // 有意跳过：不是出错，退出码 0（§9）
    console.log(`${me} 已在跑（pid ${lock.existing.pid}，run ${lock.existing.runId}）`);
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

  // 停止请求（miworkflow stop <task> [任务参数]）：任务在自己定的边界查它，比如做完一张单再挑下一张之前
  const runId = process.env.AGENTFLOW_RUN_ID;
  const stopping = () => stopRequested(HOME, task, inst, runId);

  let title = task;
  try {
    title = mod.title ?? task;
    log({ primitive: 'run', status: 'running', title, inputs: args, say: `▶ ${title}` });
    console.log(title); // 人类可见：这次运行在干什么（§13.3）

    await mod.default({ script, agent, human, args, stopping });
    log({ primitive: 'run', status: 'ok', title, say: `✔ ${title} 完成${stopping() ? '（收到停止请求，停下了）' : ''}` });
  } catch (err) {
    log(failRow(title, err));
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // 对准这次 run 的请求到此用完；对准循环的留给循环收
    if (readJson(stopFile(HOME, task, inst))?.runId === runId && !process.env.AGENTFLOW_LOOP_PID) rmSync(stopFile(HOME, task, inst), { force: true });
    releaseLock(lock);
  }
}
