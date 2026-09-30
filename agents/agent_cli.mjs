#!/usr/bin/env node
// agent_cli.mjs — 运行期 Agent 适配器（Core.md §10、§19.2）
//   node agents/agent_cli.mjs <pi|codex|cursor> [--model m] [--thinking t] [--provider p] [--session s] [-- 其余开关]
// stdin：§10 任务包 → 渲染提示词 → 起那家 CLI → stdout：最后一条回话（剥一层围栏；整段不是 JSON 就取最后一段 JSON）。
// 合不合 §6.2 契约由 core 判；这里只在 CLI 起不来 / 非 0 退出 / 超时 / 没回话时写 agent_cli_failed（这是事实，不是猜），
// 续不上会话时写 session_not_found。有会话号可交回时，在回话 JSON 顶层加 session。
// 过程翻成人话写 stderr；提示词、原始输出、归一事件落在 AGENTFLOW_AGENT_LOG（core 给的前缀）或临时目录。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from './runners/index.mjs';
import { parseCliArgv, renderPrompt, normalizeReply } from './prompt.mjs';
import { precheckSession, looksLikeSessionNotFound, sessionNotFound, sessionOut } from './session.mjs';

// 带着现成结果的失败：catch 里原样写出，不再包成 agent_cli_failed
class Outcome extends Error {
  constructor(result) {
    super(result.reason);
    this.result = result;
  }
}

let cli = 'agent';
try {
  const opts = parseCliArgv(process.argv.slice(2));
  cli = opts.cli || cli;
  const runner = createRunner(opts.cli);
  const precheck = precheckSession(cli, runner.sessionMode, opts.session);
  if (precheck) throw new Outcome(precheck);

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
      session: opts.session,
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
    const why = firstLine(res.error) || firstLine(res.stderr) || '没有错误输出';
    if (opts.session && looksLikeSessionNotFound(`${res.error}\n${res.stderr}`)) {
      throw new Outcome(sessionNotFound(cli, opts.session, why));
    }
    throw new Error(`${cli} 退出码 ${res.code}：${why}`);
  }

  const reply = readFileSync(files.outFile, 'utf8');
  if (!reply.trim()) throw new Error(`${cli} 没有给出最后回话`);
  const { text, extracted } = normalizeReply(reply);
  if (extracted) say('  · 回话里除了 JSON 还有别的字，取了最后一段 JSON');
  process.stdout.write(withSession(text, sessionOut(runner.sessionMode, opts.session, res.session)));
} catch (err) {
  process.stdout.write(JSON.stringify(err.result ?? { status: 'failed', choice: 'agent_cli_failed', reason: err.message, data: {} }));
  process.exitCode = 1;
}

// 会话号放回话 JSON 顶层；没有会话号、或回话不是 JSON 对象（交给 core 判）就原样
function withSession(text, session) {
  if (!session) return text;
  try {
    const out = JSON.parse(text);
    if (!out || typeof out !== 'object' || Array.isArray(out)) return text;
    return JSON.stringify({ ...out, session });
  } catch {
    return text;
  }
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
