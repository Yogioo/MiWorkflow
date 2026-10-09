#!/usr/bin/env node
// agent_cli.mjs — 运行期 Agent 适配器（Core.md §10、§19.2）
//   node agents/agent_cli.mjs <pi|codex|cursor> [--model m] [--thinking t] [--provider p] [--session s] [--check] [-- 其余开关]
//   --check：只校验配置、不干活（§10.1）——不读 stdin、不起模型，stdout 直接给结论。
// stdin：§10 任务包 → 渲染提示词 → 起那家 CLI → stdout：最后一条回话（剥一层围栏；整段不是 JSON 就取最后一段 JSON）。
// 合不合 §6.2 契约由 core 判；这里只在 CLI 起不来 / 非 0 退出 / 没回话时写 agent_cli_failed（这是事实，不是猜），
// 配置不对（CLI 名字 / 参数组合 / 本机没这个命令）写 agent_bad_config——重试一百次也不会好，不混进 agent_cli_failed；
// 续不上会话时写 session_not_found；被强制结束时写 agent_idle（事件流 budget.idleSec 秒不动，看门狗）/ agent_timeout（到 budget.timeoutSec）。
// 有会话号可交回时，在回话 JSON 顶层加 session。
// 过程翻成人话写 stderr；提示词、原始输出、归一事件落在 AGENTFLOW_AGENT_LOG（core 给的前缀）或临时目录。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunner, runnerConfigProblems, runnerBinProblems } from './runners/index.mjs';
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
  await runAdapter(opts);
} catch (err) {
  process.stdout.write(JSON.stringify(err.result ?? { status: 'failed', choice: 'agent_cli_failed', reason: err.message, data: {} }));
  process.exitCode = 1;
}

// 配置错（§10.1）：CLI 名字、参数组合、本机有没有这个命令。开跑前就判，别混进 agent_cli_failed 去被当成临时故障重试。
// 顺序有意如此：先说不认识的 CLI / 不认的开关，再看会话（cursor 传 session 是「续不上」，不是配置错），
// 最后才查可执行文件——于是 cursor 传了 session 时仍交回 session_not_found，跟以前一样。
async function runAdapter(opts) {
  const spec = { cli: opts.cli, model: opts.model, thinking: opts.thinking, provider: opts.provider };
  const argProblems = runnerConfigProblems(opts.cli, spec);

  // --check：只校验、不干活（dev / discuss 启动时用它）——不读 stdin、不起模型，几秒内把结论写回 stdout
  if (opts.check) {
    const problems = [...argProblems, ...(argProblems.length ? [] : runnerBinProblems(opts.cli))];
    const out = problems.length ? badConfig(problems) : { status: 'ok', choice: 'ok', reason: '', data: {} };
    process.stdout.write(JSON.stringify(out));
    if (out.status !== 'ok') process.exitCode = 1;
    return;
  }

  if (argProblems.length) throw new Outcome(badConfig(argProblems));
  const runner = createRunner(opts.cli);
  const precheck = precheckSession(cli, runner.sessionMode, opts.session);
  if (precheck) throw new Outcome(precheck);
  const binProblems = runnerBinProblems(opts.cli);
  if (binProblems.length) throw new Outcome(badConfig(binProblems));

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
  const idleSec = Number(pkg.budget?.idleSec ?? 1200) || 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  // 看门狗：事件流 idleSec 秒没动静就杀整棵进程树。动静 = 任意一条事件（含命令输出的增量）
  const trace = createTrace();
  let idled = false;
  const watchdog = idleSec > 0
    ? setInterval(() => {
      if (Date.now() - trace.lastAt < idleSec * 1000) return;
      idled = true;
      controller.abort();
    }, Math.min(5000, idleSec * 250))
    : null;

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
      onEvent: (ev) => { trace.add(ev); narrate(ev); }
    });
  } catch (err) {
    throw new Error(`${cli} 起不来：${err.message}`);
  } finally {
    clearTimeout(timer);
    if (watchdog) clearInterval(watchdog);
  }

  if (res.aborted) {
    throw new Outcome(idled
      ? killedOutcome('agent_idle', `${cli} 空闲 ${idleSec} 秒没有动静，已结束进程`, { idleSec }, trace, base, files.eventsFile)
      : killedOutcome('agent_timeout', `${cli} 超时（${timeoutSec} 秒），已结束进程`, { timeoutSec }, trace, base, files.eventsFile));
  }
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
  if (extracted) say('  · 回话不是严格 JSON，已归一');
  process.stdout.write(withSession(text, sessionOut(runner.sessionMode, opts.session, res.session)));
}

// 配置不对的交回（§10.1）：choice 用 agent_bad_config，任务据此不重试
function badConfig(problems) {
  return { status: 'failed', choice: 'agent_bad_config', reason: `Agent 配置不对：${problems.join('；')}`, data: { problems } };
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

// 工具参数里最能说明「在干什么」的那一项
function toolWhat(args) {
  const a = args && typeof args === 'object' ? args : {};
  const what = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? (args ? JSON.stringify(args) : '');
  return Array.isArray(what) ? what.join(' ') : String(what);
}

// 过程摘要：最后 300 行（工具开跑、说了什么、错误）+ 开跑了还没跑完的工具调用 + 最后一次动静的时间。
// 主流程在顶层 await 里就会调到这里，所以不用模块级 const（那时还没求值）
function createTrace() {
  const lines = [];
  const open = new Map();
  const push = (t, text) => {
    lines.push(`[${new Date(t).toTimeString().slice(0, 8)}] ${text}`);
    if (lines.length > 300) lines.shift();
  };
  const trace = {
    lastAt: Date.now(),
    lines,
    open,
    add(ev) {
      trace.lastAt = Date.now();
      if (ev.kind === 'tool') {
        const key = ev.callId || ev.toolName;
        if (ev.phase !== 'start') { open.delete(key); return; }
        open.set(key, { toolName: ev.toolName, args: ev.args, at: ev.t });
        push(ev.t, `· ${ev.toolName} ${clip(toolWhat(ev.args), 300)}`);
      } else if (ev.kind === 'assistant' && ev.text) {
        push(ev.t, `» ${clip(ev.text, 500)}`);
      } else if (ev.kind === 'error' && ev.text) {
        push(ev.t, `✖ ${clip(ev.text, 300)}`);
      }
    }
  };
  return trace;
}

// 被强制结束（看门狗 agent_idle / 超时 agent_timeout）的交回：结束时在跑什么（最后一个开跑了还没跑完的工具调用；
// 没有就是停在等模型），过程摘要落成 <base>.trace.md，给诊断用
function killedOutcome(choice, head, extra, trace, base, eventsFile) {
  const last = [...trace.open.values()].at(-1);
  const stuck = last ? { toolName: last.toolName, args: last.args, sinceSec: Math.round((Date.now() - last.at) / 1000) } : null;
  const traceFile = `${base}.trace.md`;
  writeFileSync(traceFile, `${trace.lines.join('\n')}\n`);
  const where = stuck
    ? `卡在 ${stuck.toolName}：${clip(toolWhat(stuck.args), 160)}（已跑 ${stuck.sinceSec} 秒）`
    : '没有在跑的工具，停在等模型回话';
  const reason = `${head}；${where}`;
  say(`  ✖ ${reason}`);
  return { status: 'failed', choice, reason, data: { ...extra, stuck, trace: traceFile, events: eventsFile } };
}

// 归一事件 → 一行人话：工具开跑、说了什么
function narrate(ev) {
  if (ev.kind === 'tool' && ev.phase === 'start') {
    say(`  · ${ev.toolName} ${clip(toolWhat(ev.args), 100)}`);
  } else if (ev.kind === 'assistant' && ev.text) {
    say(`  » ${clip(ev.text, 160)}`);
  } else if (ev.kind === 'error' && ev.text) {
    say(`  ✖ ${clip(ev.text, 200)}`);
  }
}
