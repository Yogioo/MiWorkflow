#!/usr/bin/env node
// run.mjs — 唯一入口（§9）
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const argv = process.argv.slice(2);
const task = argv.find((a) => !a.startsWith('--'));
const dryRun = argv.includes('--dry-run');

if (!task) {
  console.error('usage: miworkflow <task> [--yes] [--dry-run]');
  process.exit(1);
}

// 先定 runId，再加载 core（core 里 runId 是延迟解析的）
process.env.AGENTFLOW_TASK = task;
process.env.AGENTFLOW_RUN_ID ??= randomUUID();
if (dryRun) process.env.AGENTFLOW_DRY_RUN = '1';

const { log, HOME } = await import('./core.mjs');
const taskFile = path.join(HOME, 'tasks', `${task}.mjs`);

if (!existsSync(taskFile)) {
  console.error(`task not found: ${task}（在 ${path.join(HOME, 'tasks')} 下找；HOME 由 AGENTFLOW_HOME 指定，缺省为当前目录）`);
  process.exit(1);
}

const mod = await import(pathToFileURL(taskFile).href);
const title = mod.title ?? task;

log({ primitive: 'run', status: 'running', title, say: `▶ ${title}` });

console.log(title); // 人类可见：这次运行在干什么（§13.3）

try {
  await mod.default();
  log({ primitive: 'run', status: 'ok', title, say: `✔ ${title} 完成` });
} catch (err) {
  const message = String(err?.message ?? err);
  log({ primitive: 'run', status: 'failed', title, error: message, say: `✖ ${title} 失败：${message}` });
  console.error(err);
  process.exitCode = 1;
}
