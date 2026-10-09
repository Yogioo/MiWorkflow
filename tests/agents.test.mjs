import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCliArgv, renderPrompt, stripFence, normalizeReply, extractJson } from '../agents/prompt.mjs';
import { normalizeEvent, extractSessionFromRaw } from '../agents/normalize-event.mjs';
import { precheckSession, looksLikeSessionNotFound, sessionNotFound, sessionOut } from '../agents/session.mjs';
import { buildPiArgs } from '../agents/runners/pi.mjs';
import { buildCodexArgs } from '../agents/runners/codex.mjs';
import { buildCursorArgs, applyThinkingToModel } from '../agents/runners/cursor.mjs';
import { parseJsonlChunk } from '../agents/runners/spawn-turn.mjs';

// 一次性 HOME，必须在首次 import core 之前定好
const HOME = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-agents-'));
process.env.AGENTFLOW_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const LOGS = path.join(HOME, 'logs');
const uniq = () => `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const rows = (runId) => readFileSync(path.join(LOGS, `${runId}.jsonl`), 'utf8').split('\n').filter(Boolean).map(JSON.parse);

const TURN = { workdir: '/w', outFile: '/o.txt', promptFile: '/p.md' };

// ── 纯函数：各家开关映射（§19.2）────────────────────────────────────────

test('pi：model / thinking / provider 原样转交，全权限不排除工具', () => {
  const args = buildPiArgs({ ...TURN, model: 'sonnet', thinking: 'high', provider: 'anthropic', extraArgs: ['--x'] });
  assert.deepEqual(args, [
    '-p', '--no-session', '--mode', 'json', '--approve',
    '--provider', 'anthropic', '--model', 'sonnet', '--thinking', 'high', '--x', '@/p.md'
  ]);
  assert.ok(!args.includes('--exclude-tools'));
});

test('codex：-m / model_reasoning_effort，全权限，不带 --output-schema', () => {
  const args = buildCodexArgs({ ...TURN, model: 'gpt-5.5', thinking: 'high' });
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!args.includes('-s'), '不走沙箱');
  assert.ok(!args.includes('--output-schema'), '严格模式容不下自由形状的 data');
  assert.deepEqual(args.slice(args.indexOf('-m')), ['-m', 'gpt-5.5', '-c', 'model_reasoning_effort=high', '-']);
});

// ── 纯函数：会话进出（§10.1）────────────────────────────────────────────

test('pi：给会话号就 --session-id 续（不带 --no-session），没给维持一次性会话', () => {
  const args = buildPiArgs({ ...TURN, session: 's-1' });
  assert.deepEqual(args.slice(0, 4), ['-p', '--session-id', 's-1', '--mode']);
  assert.ok(!args.includes('--no-session'));
  assert.ok(buildPiArgs(TURN).includes('--no-session'));
});

test('codex：给会话号走 exec resume <id>，不带 exec resume 不认的 -C / --color', () => {
  const args = buildCodexArgs({ ...TURN, session: 'th-1', model: 'm' });
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'th-1']);
  assert.ok(!args.includes('-C') && !args.includes('--color'));
  assert.equal(args.at(-1), '-');
  assert.equal(buildCodexArgs(TURN)[1], '-C');
});

test('codex 事件流里取会话号：thread.started / 旧版 session_configured；别家不取', () => {
  assert.equal(extractSessionFromRaw({ type: 'thread.started', thread_id: 'th-9' }, 'codex'), 'th-9');
  assert.equal(extractSessionFromRaw({ msg: { type: 'session_configured', session_id: 'se-1' } }, 'codex'), 'se-1');
  assert.equal(extractSessionFromRaw({ type: 'thread.started', thread_id: 'x' }, 'pi'), '');
  const parsed = parseJsonlChunk(`${JSON.stringify({ type: 'thread.started', thread_id: 'th-2' })}\n`, '', 'codex');
  assert.equal(parsed.session, 'th-2');
});

test('会话号交回：pi 交回给的；codex 取事件流里的、没有就用给的；cursor 不交回', () => {
  assert.equal(sessionOut('create-or-resume', 's-1', ''), 's-1');
  assert.equal(sessionOut('create-or-resume', '', ''), '');
  assert.equal(sessionOut('resume', '', 'th-1'), 'th-1');
  assert.equal(sessionOut('resume', 'th-1', ''), 'th-1');
  assert.equal(sessionOut('none', 's-1', 'x'), '');
});

test('session_not_found：cursor 传会话号开跑前就判；错误文本像「会话不存在」才算', () => {
  assert.deepEqual(precheckSession('cursor', 'none', 's-1'), {
    status: 'failed', choice: 'session_not_found', reason: 'cursor 续不上会话 s-1：这家 CLI 不支持续会话', data: {}
  });
  assert.equal(precheckSession('cursor', 'none', ''), null);
  assert.equal(precheckSession('codex', 'resume', 'th-1'), null);
  assert.match(sessionNotFound('codex', 'th-1', 'boom').reason, /codex 续不上会话 th-1：boom/);

  assert.ok(looksLikeSessionNotFound('Error: No saved session found with ID th-1'));
  assert.ok(looksLikeSessionNotFound('thread th-1 not found'));
  assert.ok(looksLikeSessionNotFound('rollout does not exist'));
  assert.ok(!looksLikeSessionNotFound('额度用完了'));
  assert.ok(!looksLikeSessionNotFound('model not found'));
});

test('codex 的错误事件归一成 error，取出 API 错误里那句', () => {
  const ev = normalizeEvent({ type: 'error', message: JSON.stringify({ error: { message: 'Invalid schema' } }) }, 'codex');
  assert.equal(ev.kind, 'error');
  assert.equal(ev.text, 'Invalid schema');
  assert.equal(normalizeEvent({ type: 'turn.failed', error: { message: 'quota' } }, 'codex').text, 'quota');
});

test('codex / cursor：给 provider 就报错，不静默丢掉', () => {
  assert.throws(() => buildCodexArgs({ ...TURN, provider: 'x' }), /provider/);
  assert.throws(() => buildCursorArgs({ ...TURN, provider: 'x' }), /provider/);
});

test('cursor：思考等级折进 model[effort=…]；只给 thinking 就报错', () => {
  const args = buildCursorArgs({ ...TURN, model: 'composer-2.5', thinking: 'high' });
  assert.equal(args[args.indexOf('--model') + 1], 'composer-2.5[effort=high]');
  assert.ok(args.includes('--force') && args.includes('--approve-mcps'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'disabled');
  assert.throws(() => buildCursorArgs({ ...TURN, thinking: 'high' }), /thinking/);

  assert.equal(applyThinkingToModel('m[fast=true]', 'low'), 'm[fast=true,effort=low]');
  assert.equal(applyThinkingToModel('m[effort=max]', 'low'), 'm[effort=max]', '已有 effort 不覆盖');
});

test('parseCliArgv：三个开关两种写法，-- 之后原样给 CLI；--check 是布尔开关', () => {
  assert.deepEqual(parseCliArgv(['codex', '--model', 'm', '--thinking=high', '--', '--foo', 'bar']), {
    cli: 'codex', model: 'm', thinking: 'high', provider: '', session: '', check: false, extraArgs: ['--foo', 'bar']
  });
  assert.equal(parseCliArgv(['pi', '--session', 's-1']).session, 's-1');
  const check = parseCliArgv(['pi', '--check', '--model', 'm']);
  assert.equal(check.check, true);
  assert.equal(check.model, 'm', '--check 是开关，不吞下一个参数');
  assert.throws(() => parseCliArgv(['pi', '--foo']), /不认识的开关/);
});

// ── 纯函数：提示词与回话 ───────────────────────────────────────────────

test('renderPrompt：goal、inputs、constraints、预算与输出契约都在', () => {
  const p = renderPrompt({
    goal: '修掉失败的测试',
    inputs: { failures: 3, choices: ['fixed', 'give_up'] },
    constraints: ['不改公共 API'],
    budget: { maxTokens: 20000, maxTurns: 8, timeoutSec: 600, idleSec: 1200 }
  });
  assert.match(p, /修掉失败的测试/);
  assert.match(p, /"failures": 3/);
  assert.match(p, /- 不改公共 API/);
  assert.match(p, /600 秒后会被强制结束/);
  assert.match(p, /连续 1200 秒没有任何动静.*会被当成卡死/);
  assert.match(p, /`fixed` \/ `give_up`/, 'choice 只能取 inputs.choices');
  assert.match(p, /ok.*need_human.*failed/);
});

test('stripFence：只剥一层围栏，别的原样', () => {
  assert.equal(stripFence('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripFence('```\n{"a":1}```'), '{"a":1}');
  assert.equal(stripFence('  {"a":1}\n'), '{"a":1}');
  assert.equal(stripFence('好了：\n```json\n{"a":1}\n```'), '好了：\n```json\n{"a":1}\n```', '围栏外有话就不猜');
});

// ── 纯函数：回话归一（§10.1）————————————————————————————————————————

test('normalizeReply：纯 JSON / 围栏 / 夹在文字里，都取到契约 JSON', () => {
  assert.deepEqual(normalizeReply('{"status":"ok","choice":"done"}'), {
    text: '{"status":"ok","choice":"done"}', extracted: false
  });
  assert.deepEqual(normalizeReply('```json\n{"status":"ok","choice":"done"}\n```'), {
    text: '{"status":"ok","choice":"done"}', extracted: false
  });

  // pi 真实出现过的形状：一大段人话总结 + 空行 + 契约 JSON
  const mixed = normalizeReply('完成。改动如下：\n\n- run.mjs：加了占用锁\n\n{"status":"ok","choice":"done","data":{"n":1}}');
  assert.equal(mixed.extracted, true);
  assert.deepEqual(JSON.parse(mixed.text), { status: 'ok', choice: 'done', data: { n: 1 } });
});

test('normalizeReply：没有 JSON 就原样交回，让 core 判（不假装成功）', () => {
  const r = normalizeReply('我做完了，但忘了输出 JSON');
  assert.equal(r.extracted, false);
  assert.equal(r.text, '我做完了，但忘了输出 JSON');
});

test('extractJson：串里的花括号、多个 JSON、尾部杂字都不影响', () => {
  assert.equal(extractJson('用 {"pid": 1} 当锁\n{"status":"ok","choice":"done"}'), '{"status":"ok","choice":"done"}');
  assert.equal(extractJson('{"status":"a","choice":"x"}\n\n{"status":"ok","choice":"done"}'), '{"status":"ok","choice":"done"}', '取最后一个');
  assert.equal(extractJson('{"status":"ok","data":{"msg":"a } b { c"}}'), '{"status":"ok","data":{"msg":"a } b { c"}}', '串里的花括号不干扰');
  assert.equal(extractJson('前言\n{"status":"ok","choice":"done"}\n后记'), '{"status":"ok","choice":"done"}');
  assert.equal(extractJson('没有 JSON'), null);
  assert.equal(extractJson('[1, 2, 3]'), null, '没对象就 null');
  assert.equal(extractJson('[{"status":"ok","choice":"x"}]'), '{"status":"ok","choice":"x"}', '包在数组里的对象也认得');
});

test('parseJsonlChunk：半行留到下一块，最后回话取最新的一条', () => {
  const msg = (t) => JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
  const first = parseJsonlChunk(`${msg('一')}\n${msg('二')}\n{"type":"mess`, '', 'pi');
  assert.equal(first.reply, '二');
  assert.equal(first.rawEvents.length, 2);
  const second = parseJsonlChunk('age_end"}\nnot json\n', first.remainder, 'pi');
  assert.equal(second.rawEvents.length, 1);
});

// ── 端到端：core.agent() → 适配器 → 假 pi ───────────────────────────────

// 假 pi：按 FAKE_MODE 模拟各种情况，正常时把收到的 argv、cwd、提示词塞进 data 交回
const FAKE_PI = path.join(HOME, 'fake-pi.mjs');
writeFileSync(FAKE_PI, `
import { readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? 'ok';
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
const say = (text) => emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } });
if (mode === 'crash') { process.stderr.write('boom: 模型不存在\\n'); process.exit(3); }
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'stuck') {
  emit({ type: 'tool_execution_start', toolCallId: '1', toolName: 'read', args: { path: 'a.cs' } });
  emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'read', result: {} });
  emit({ type: 'tool_execution_start', toolCallId: '2', toolName: 'bash', args: { command: 'find / -name x' } });
  setInterval(() => {}, 1000);
} else if (mode === 'chatty') {
  let n = 0;
  const timer = setInterval(() => {
    emit({ type: 'message_update' });
    if (++n < 8) return;
    clearInterval(timer);
    say(JSON.stringify({ status: 'ok', choice: 'done', reason: '一直有动静', data: {} }));
  }, 250);
} else {
  emit({ type: 'tool_execution_start', toolCallId: '1', toolName: 'bash', args: { command: 'ls' } });
  if (mode === 'prose') say('我改好了，没什么要交回的');
  if (mode === 'ok') {
    const prompt = readFileSync(argv.at(-1).slice(1), 'utf8');
    say('\`\`\`json\\n' + JSON.stringify({ status: 'ok', choice: 'done', reason: '假 pi 做完了', data: { argv, cwd: process.cwd(), prompt } }) + '\\n\`\`\`');
  }
}
`);
process.env.PI_BIN = FAKE_PI;

async function callAgent(goal, opts, mode = 'ok') {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  process.env.FAKE_MODE = mode;
  const { agent } = await import('../core.mjs');
  return { r: await agent(goal, opts), runId };
}

test('opts.agent：展开成适配器，参数原样到 CLI，剥围栏后按契约透传，日志记 agent 与事件文件', async () => {
  const cwd = mkdtempSync(path.join(HOME, 'work-'));
  const { r, runId } = await callAgent('改点东西', {
    agent: { cli: 'pi', model: 'sonnet', thinking: 'high', provider: 'anthropic', args: ['--extra'] },
    inputs: { cwd, choices: ['done', 'no_change'] }
  });

  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.choice, 'done');
  assert.equal(r.reason, '假 pi 做完了');
  const argv = r.data.argv.join(' ');
  assert.match(argv, /--provider anthropic --model sonnet --thinking high --extra @/);
  assert.equal(path.resolve(r.data.cwd).toLowerCase(), cwd.toLowerCase(), 'Agent 在 inputs.cwd 里干活');
  assert.match(r.data.prompt, /改点东西/);
  assert.match(r.data.prompt, /`done` \/ `no_change`/);

  const row = rows(runId).at(-1);
  assert.deepEqual(row.agent, { cli: 'pi', model: 'sonnet', thinking: 'high' });
  assert.equal(row.events, `${runId}/agent-1.events.jsonl`);
  const events = readFileSync(path.join(LOGS, row.events), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(events.some((e) => e.kind === 'tool' && e.toolName === 'bash'), '归一事件落进 HOME logs/');
  assert.ok(existsSync(path.join(LOGS, `${runId}/agent-1.prompt.md`)));
});

test('默认值顺序：AGENTFLOW_AGENT 是本机缺省；AGENTFLOW_AGENT_CMD 优先于它；opts.agent 再优先', async () => {
  process.env.AGENTFLOW_AGENT = 'pi';
  delete process.env.AGENTFLOW_AGENT_CMD;
  try {
    const viaEnv = await callAgent('随便', {});
    assert.equal(viaEnv.r.choice, 'done');
    assert.deepEqual(rows(viaEnv.runId).at(-1).agent, { cli: 'pi' });

    mkdirSync(path.join(HOME, 'bin'), { recursive: true });
    writeFileSync(path.join(HOME, 'bin', 'cmd.mjs'),
      "process.stdout.write(JSON.stringify({ status: 'ok', choice: 'from_cmd', reason: '' }));");
    process.env.AGENTFLOW_AGENT_CMD = 'node bin/cmd.mjs';
    assert.equal((await callAgent('随便', {})).r.choice, 'from_cmd');
    assert.equal((await callAgent('随便', { agent: 'pi' })).r.choice, 'done');
  } finally {
    delete process.env.AGENTFLOW_AGENT;
    delete process.env.AGENTFLOW_AGENT_CMD;
  }
});

test('CLI 非 0 退出 → agent_cli_failed，reason 带退出码和 stderr 首句', async () => {
  const { r } = await callAgent('随便', { agent: 'pi' }, 'crash');
  assert.equal(r.status, 'failed');
  assert.equal(r.choice, 'agent_cli_failed');
  assert.match(r.reason, /pi 退出码 3：boom: 模型不存在/);
});

test('错误写在事件流里（codex）→ reason 用那条错误，不说「没有 stderr」', async () => {
  const fakeCodex = path.join(HOME, 'fake-codex.mjs');
  writeFileSync(fakeCodex, [
    "process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: '额度用完了' } }) + '\\n');",
    'process.exitCode = 1;'
  ].join('\n'));
  process.env.CODEX_BIN = fakeCodex;
  try {
    const { r } = await callAgent('随便', { agent: 'codex' });
    assert.equal(r.choice, 'agent_cli_failed');
    assert.match(r.reason, /codex 退出码 1：额度用完了/);
  } finally {
    delete process.env.CODEX_BIN;
  }
});

test('CLI 没有回话 → agent_cli_failed', async () => {
  const { r } = await callAgent('随便', { agent: 'pi' }, 'silent');
  assert.equal(r.choice, 'agent_cli_failed');
  assert.match(r.reason, /没有给出最后回话/);
});

test('回话不是 JSON → 适配器不猜，core 判 agent_invalid_json', async () => {
  const { r } = await callAgent('随便', { agent: 'pi' }, 'prose');
  assert.equal(r.choice, 'agent_invalid_json');
  assert.match(r.data.stdout, /我改好了/);
});

test('超时 → 适配器杀掉 CLI，agent_timeout，同样交回结束时在跑什么与过程摘要', async () => {
  const { r } = await callAgent('随便', { agent: 'pi', budget: { timeoutSec: 1 } }, 'hang');
  assert.equal(r.status, 'failed');
  assert.equal(r.choice, 'agent_timeout');
  assert.match(r.reason, /pi 超时（1 秒），已结束进程；没有在跑的工具，停在等模型回话/);
  assert.equal(r.data.timeoutSec, 1);
  assert.equal(r.data.stuck, null);
  assert.ok(existsSync(r.data.trace));
});

test('看门狗：事件流 idleSec 秒不动 → 杀掉 CLI，agent_idle，交回卡住的工具调用与过程摘要', async () => {
  const { r, runId } = await callAgent('随便', { agent: 'pi', budget: { idleSec: 1 } }, 'stuck');
  assert.equal(r.status, 'failed');
  assert.equal(r.choice, 'agent_idle');
  assert.match(r.reason, /pi 空闲 1 秒没有动静，已结束进程；卡在 bash：find \/ -name x/);
  assert.equal(r.data.idleSec, 1);
  assert.deepEqual(r.data.stuck.args, { command: 'find / -name x' }, '跑完了的 read 不算卡住');
  const trace = readFileSync(r.data.trace, 'utf8');
  assert.match(trace, /· read a\.cs/);
  assert.match(trace, /· bash find \/ -name x/);
  const row = rows(runId).at(-1);
  assert.equal(path.resolve(r.data.events), path.join(LOGS, row.events));
  assert.equal(row.say, r.reason);
});

test('看门狗：一直有动静（哪怕只是输出增量）就不杀', async () => {
  const { r } = await callAgent('随便', { agent: 'pi', budget: { idleSec: 1 } }, 'chatty');
  assert.equal(r.choice, 'done', JSON.stringify(r));
});

test('不认识的 CLI、cursor 只给 thinking → agent_bad_config，说清原因（不是 agent_cli_failed）', async () => {
  const unknown = (await callAgent('随便', { agent: 'gemini' })).r;
  assert.equal(unknown.choice, 'agent_bad_config');
  assert.match(unknown.reason, /不认识的 Agent CLI：gemini（可选：pi \/ codex \/ cursor）/);

  const cursor = (await callAgent('随便', { agent: { cli: 'cursor', thinking: 'high' } })).r;
  assert.equal(cursor.choice, 'agent_bad_config');
  assert.match(cursor.reason, /只给 thinking/);
});

test('本机没有这个命令 → agent_bad_config，说清用哪个环境变量指路', async () => {
  process.env.PI_BIN = path.join(HOME, 'nope', 'missing-pi.mjs');
  try {
    const { r } = await callAgent('随便', { agent: 'pi' });
    assert.equal(r.choice, 'agent_bad_config');
    assert.match(r.reason, /本机找不到 pi 的命令/);
    assert.match(r.reason, /PI_BIN/);
  } finally {
    process.env.PI_BIN = FAKE_PI;
  }
});

// ── 只校验用法（opts.check，§10.1）：dev / discuss 启动时用它，不调模型 ──

test('opts.check：配置合法 → ok，不叫模型、不写日志', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  process.env.FAKE_MODE = 'ok';
  const { agent } = await import('../core.mjs');
  const r = await agent('随便', { agent: { cli: 'pi', model: 'sonnet', thinking: 'high' }, check: true });
  assert.deepEqual(r, { status: 'ok', choice: 'ok', reason: '', data: {} });
  assert.ok(!existsSync(path.join(LOGS, `${runId}.jsonl`)), '只校验不是一次 Agent 调用，不写日志');
});

test('opts.check：名字不认识 / 参数组合非法 / 命令找不到 → agent_bad_config，reason 说清哪一项；自定义命令没法查 → ok', async () => {
  const unknown = (await callAgent('随便', { agent: 'gemini', check: true })).r;
  assert.equal(unknown.status, 'failed');
  assert.equal(unknown.choice, 'agent_bad_config');
  assert.match(unknown.reason, /不认识的 Agent CLI：gemini（可选：pi \/ codex \/ cursor）/);

  const combo = (await callAgent('随便', { agent: { cli: 'cursor', thinking: 'high' }, check: true })).r;
  assert.equal(combo.choice, 'agent_bad_config');
  assert.match(combo.reason, /只给 thinking/);

  process.env.PI_BIN = path.join(HOME, 'nope', 'missing-pi.mjs');
  try {
    const missing = (await callAgent('随便', { agent: 'pi', check: true })).r;
    assert.equal(missing.choice, 'agent_bad_config');
    assert.match(missing.reason, /本机找不到 pi 的命令/);
  } finally {
    process.env.PI_BIN = FAKE_PI;
  }

  // 自定义命令没法校验：直接 ok
  process.env.AGENTFLOW_AGENT_CMD = 'node bin/cmd.mjs';
  try {
    const custom = (await callAgent('随便', { check: true })).r;
    assert.equal(custom.status, 'ok');
  } finally {
    delete process.env.AGENTFLOW_AGENT_CMD;
  }
});

test('opts.check：没配 Agent → agent_unavailable，不写日志', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  delete process.env.AGENTFLOW_AGENT_CMD;
  delete process.env.AGENTFLOW_AGENT;
  const { agent } = await import('../core.mjs');
  const r = await agent('随便', { check: true });
  assert.equal(r.status, 'failed');
  assert.equal(r.choice, 'agent_unavailable');
  assert.ok(!existsSync(path.join(LOGS, `${runId}.jsonl`)));
});

// ── 端到端：会话进出（§10.1）────────────────────────────────────────────

test('pi：opts.agent.session 到 --session-id，交回同一个会话号，记进日志；不进 inputs', async () => {
  const { r, runId } = await callAgent('续着干', { agent: { cli: 'pi', session: 's-42' } });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.session, 's-42');
  assert.match(r.data.argv.join(' '), /--session-id s-42/);
  assert.ok(!r.data.argv.includes('--no-session'));
  assert.doesNotMatch(r.data.prompt, /s-42/, '会话号是适配器参数，不进发给 Agent 的 inputs');
  const row = rows(runId).at(-1);
  assert.equal(row.session, 's-42');
  assert.equal(row.agent.session, 's-42');
});

test('pi：不写 session 行为不变，返回值没有 session 字段', async () => {
  const { r, runId } = await callAgent('随便', { agent: 'pi' });
  assert.equal(r.choice, 'done');
  assert.ok(!('session' in r));
  assert.ok(r.data.argv.includes('--no-session'));
  assert.ok(!('session' in rows(runId).at(-1)));
});

test('cursor：传 session → session_not_found，reason 写明哪家、哪个会话号', async () => {
  const { r } = await callAgent('随便', { agent: { cli: 'cursor', session: 'c-1' } });
  assert.equal(r.status, 'failed');
  assert.equal(r.choice, 'session_not_found');
  assert.match(r.reason, /cursor 续不上会话 c-1/);
  assert.ok(!('session' in r));
});

// 假 codex：事件流报 thread.started，回话写进 -o 指的文件；resume missing 时按「会话不存在」失败
const FAKE_CODEX = path.join(HOME, 'fake-codex-session.mjs');
writeFileSync(FAKE_CODEX, `
import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
for await (const _ of process.stdin);
const resume = argv[1] === 'resume' ? argv[2] : null;
if (resume === 'missing') { process.stderr.write('Error: No saved session found with ID missing\\n'); process.exit(1); }
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: resume ?? 'th-new' }) + '\\n');
writeFileSync(argv[argv.indexOf('-o') + 1], JSON.stringify({ status: 'ok', choice: 'done', reason: '', data: { argv } }));
`);

test('codex：没给会话号从事件流取出交回；给了就 exec resume 续；续不上 → session_not_found', async () => {
  process.env.CODEX_BIN = FAKE_CODEX;
  try {
    const fresh = (await callAgent('随便', { agent: 'codex' })).r;
    assert.equal(fresh.status, 'ok', JSON.stringify(fresh));
    assert.equal(fresh.session, 'th-new');

    const resumed = (await callAgent('随便', { agent: { cli: 'codex', session: 'th-7' } })).r;
    assert.equal(resumed.session, 'th-7');
    assert.deepEqual(resumed.data.argv.slice(0, 3), ['exec', 'resume', 'th-7']);

    const missing = (await callAgent('随便', { agent: { cli: 'codex', session: 'missing' } })).r;
    assert.equal(missing.status, 'failed');
    assert.equal(missing.choice, 'session_not_found');
    assert.match(missing.reason, /codex 续不上会话 missing：Error: No saved session found/);
  } finally {
    delete process.env.CODEX_BIN;
  }
});
