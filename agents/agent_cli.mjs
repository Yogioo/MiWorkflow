#!/usr/bin/env node
// agent_cli.mjs — 运行期 Agent 适配器（Core.md §10、§19.2）
//   node agents/agent_cli.mjs <pi|codex|cursor> [--model m] [--thinking t] [--provider p] [-- 其余开关]
// stdin：§10 任务包 → 渲染提示词 → 起那家 CLI → stdout：最后一条回话（剥掉至多一层围栏）。
// 合不合 §6.2 契约由 core 判；这里只在 CLI 起不来 / 非 0 退出 / 超时 / 没回话时写 agent_cli_failed（这是事实，不是猜）。
// 过程翻成人话写 stderr；提示词、原始输出、归一事件落在 AGENTFLOW_AGENT_LOG（core 给的前缀）或临时目录。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from './runners/index.mjs';
import { parseCliArgv, renderPrompt, stripFence } from './prompt.mjs';

let cli = 'agent';
try {
  const opts = parseCliArgv(process.argv.slice(2));
  cli = opts.cli || cli;
  const runner = createRunner(opts.cli);

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    throw new Error('stdin 不是 JSON 任务包');
  }

  const base = process.env.AGENTFLOW_AGENT_LOG || path.join(mkdtempSync(path.join(os.tmpdir(), 'miworkflow-agent-')), 'agent');
  mkdirSync(path.dirname(base), { recursive: true });
  const files = {
    promptFile: `${base}.prompt.md`,
    outFile: `${base}.out.txt`,
    logFile: `${base}.log`,
    eventsFile: `${base}.events.jsonl`
  };
  const prompt = renderPrompt(pkg);
  writeFileSync(files.promptFile, prompt);
  writeFileSync(files.outFile, '');
  writeFileSync(files.eventsFile, '');

  const workdir = path.resolve(pkg.inputs?.cwd ?? process.cwd());
  const timeoutSec = Number(pkg.budget?.timeoutSec) || 7200;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  const label = [opts.model, opts.thinking].filter(Boolean).join(' · ');
  say(`[agent] ${cli}${label ? `（${label}）` : ''} 开始，目录 ${workdir}`);

  let res;
  try {
    res = await runner.runTurn({
      ...files,
      workdir,
      prompt,
      model: opts.model,
      thinking: opts.thinking,
      provider: opts.provider,
      extraArgs: opts.extraArgs,
      signal: controller.signal,
      onEvent: narrate
    });
  } catch (err) {
    throw new Error(`${cli} 起不来：${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.aborted) throw new Error(`${cli} 超时（${timeoutSec} 秒），已结束进程`);
  if (res.code !== 0) {
    throw new Error(`${cli} 退出码 ${res.code}：${firstLine(res.error) || firstLine(res.stderr) || '没有错误输出'}`);
  }

  const reply = readFileSync(files.outFile, 'utf8');
  if (!reply.trim()) throw new Error(`${cli} 没有给出最后回话`);
  process.stdout.write(stripFence(reply));
} catch (err) {
  process.stdout.write(JSON.stringify({ status: 'failed', choice: 'agent_cli_failed', reason: err.message, data: {} }));
  process.exitCode = 1;
}

function say(line) {
  process.stderr.write(line + '\n');
}

function firstLine(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

function clip(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 归一事件 → 一行人话：工具开跑、说了什么
function narrate(ev) {
  if (ev.kind === 'tool' && ev.phase === 'start') {
    const a = ev.args && typeof ev.args === 'object' ? ev.args : {};
    const what = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? (ev.args ? JSON.stringify(ev.args) : '');
    say(`  · ${ev.toolName} ${clip(Array.isArray(what) ? what.join(' ') : what, 100)}`);
  } else if (ev.kind === 'assistant' && ev.text) {
    say(`  » ${clip(ev.text, 160)}`);
  } else if (ev.kind === 'error' && ev.text) {
    say(`  ✖ ${clip(ev.text, 200)}`);
  }
}
