#!/usr/bin/env node
// run.mjs — 唯一入口（§9）：miworkflow init | new <name> | view | <task> [--key value]
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const KERNEL = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.join(KERNEL, 'templates');
const SKILL = path.join(KERNEL, 'SKILL.md');
const RESERVED = new Set(['init', 'new', 'view']);
const NAME = /^[A-Za-z0-9_-]+$/;
const USAGE = [
  'usage:',
  '  miworkflow init [--template <名字>]   在项目里建 .workflow/',
  '  miworkflow new <name>                 建任务骨架 .workflow/tasks/<name>.mjs',
  '  miworkflow view                       起网页：看运行、审批、点运行',
  '  miworkflow <task> [--key value]... [--yes] [--dry-run]'
].join('\n');

const { positional, args, dryRun } = parseArgv(process.argv.slice(2));
const [cmd, name] = positional;

if (!cmd) fail(USAGE);
else if (cmd === 'init') await init(args.template);
else if (cmd === 'new') newTask(name);
else if (cmd === 'view') {
  useHome();
  await import('./viewer/serve.mjs');
} else await runTask(cmd);

// ── 参数 ──────────────────────────────────────────────────────────────────
// --key value / --key=value / --flag(=true)；值一律是字符串。--yes、--dry-run 归内核，不进 args
function parseArgv(argv) {
  const positional = [];
  const args = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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
    args[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
  }
  return { positional, args, dryRun };
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

  const home = path.join(projectRoot(), '.workflow');
  const created = [];
  const skipped = [];
  for (const dir of ['tasks', 'scripts']) mkdirSync(path.join(home, dir), { recursive: true });
  place(path.join(home, '.gitignore'), home, created, skipped, (f) => writeFileSync(f, 'logs/\n'));
  if (template !== 'blank') copyTree(path.join(TEMPLATES, template), home, home, created, skipped);

  console.log(`HOME  ${home}（模板：${template}）`);
  for (const f of created) console.log(`  + ${f}`);
  for (const f of skipped) console.log(`  = ${f}（已存在，没动）`);
  console.log(`写任务：miworkflow new <name>，或把 ${SKILL} 交给 AI`);
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

// ── new ───────────────────────────────────────────────────────────────────
function newTask(task) {
  if (!task || !NAME.test(task) || RESERVED.has(task)) {
    fail('usage: miworkflow new <name>（字母、数字、_、-；不能叫 init / new / view）');
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
  console.log(`跑：miworkflow ${task}；写法见 ${SKILL}`);
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
  }
}
