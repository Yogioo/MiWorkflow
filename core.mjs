// core.mjs — 三个原语：script / agent / human（§5）
// log() 供 run.mjs 写 run 级记录，不属于任务接口。
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// HOME：沉淀所在（§3）。tasks/ scripts/ logs/ 都在这里，缺省为当前目录
export const HOME = path.resolve(process.env.AGENTFLOW_HOME || process.cwd());
export const LOGS_DIR = path.join(HOME, 'logs');
// Agent 缺省在项目根干活：HOME 是 <项目>/.workflow 时取上一级，其它（如 examples/）就是 HOME（§3、§10.1）
const AGENT_CWD = path.basename(HOME) === '.workflow' ? path.dirname(HOME) : HOME;
const SCRIPTS_DIR = path.join(HOME, 'scripts');
const AGENT_CLI = fileURLToPath(new URL('./agents/agent_cli.mjs', import.meta.url));

// 一次运行一个 runId（§12）。延迟解析：run.mjs 先写好 env，再加载本模块。
let runIdCache = null;
function rid() {
  return process.env.AGENTFLOW_RUN_ID || (runIdCache ??= randomUUID());
}

let seq = 0;

// gitSha 只取一次（§12），取的是 HOME 所在仓库（沉淀的版本）；非 git 仓库则为 null
let gitShaCache;
function gitSha() {
  if (gitShaCache !== undefined) return gitShaCache;
  try {
    gitShaCache = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: HOME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    gitShaCache = null;
  }
  return gitShaCache;
}

// 每条记录带 say（§13.1）
export function log(record) {
  const row = {
    runId: rid(),
    task: process.env.AGENTFLOW_TASK ?? null,
    seq: ++seq,
    at: new Date().toISOString(),
    gitSha: gitSha(),
    ...record
  };
  mkdirSync(LOGS_DIR, { recursive: true });
  appendFileSync(path.join(LOGS_DIR, `${row.runId}.jsonl`), JSON.stringify(row) + '\n');
  return row.seq;
}

// ── 子进程 ────────────────────────────────────────────────────────────────
// 无 shell 依赖（§11）；stderr 原样透传，方便人当场看（§6.1）
function run(cmd, argv, input, timeoutMs, env = process.env, cwd = HOME) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      stderr += `\n[timeout ${timeoutMs}ms]`;
      child.kill('SIGKILL');
      finish(-1);
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; process.stderr.write(d); });
    // 子进程不读 stdin 就退出时写入会 EPIPE，这里吞掉，别让它掀翻整个 run
    child.stdin.on('error', () => {});
    child.on('error', (err) => { stderr += String(err.message); finish(-1); });
    child.on('close', (code) => finish(code ?? -1));
    child.stdin.end(input ?? '');
  });
}

// ── script（§6.1）─────────────────────────────────────────────────────────
export async function script(name, args = {}, opts = {}) {
  const startedAt = Date.now();
  const file = path.join(SCRIPTS_DIR, `${name}.mjs`);

  // dryRun（§6.1）：run.mjs 的 --dry-run 落到 env，core 统一注入 args，脚本自己决定怎么干跑
  const dryRun = opts.dryRun ?? process.env.AGENTFLOW_DRY_RUN === '1';
  const payload = dryRun ? { dryRun: true, ...args } : args;
  const res = await run(process.execPath, [file], JSON.stringify(payload), opts.timeoutMs ?? 120_000);

  let result;
  try {
    result = JSON.parse(res.stdout);
    // 非 0 退出码即失败，哪怕 stdout 是合法 JSON（§6.1）
    if (res.code !== 0 && result.status !== 'failed') {
      result = { ...result, status: 'failed', error: result.error ?? `exit_${res.code}` };
    }
  } catch {
    result = {
      status: 'failed',
      error: res.stdout.trim() ? 'invalid_json' : (res.stderr.trim().split('\n').pop() || `exit_${res.code}`)
    };
  }

  log({
    primitive: 'script',
    name,
    inputs: args, // 输入信息（§12、§13.6）：viewer 展开时看「这步拿什么参数跑的」
    status: result.status,
    error: result.error,
    say: result.say ?? `${name}: ${result.status}`,
    durationMs: Date.now() - startedAt
  });

  return result;
}

// ── agent（§6.2、§10）─────────────────────────────────────────────────────
let agentCalls = 0;

// 找 Agent 命令（§19.2）：opts.cmd → opts.agent → AGENTFLOW_AGENT_CMD → AGENTFLOW_AGENT → 没有
function agentCommand(opts) {
  const split = (s) => s.split(/\s+/).filter(Boolean);
  if (opts.cmd) return { argv: split(opts.cmd) };
  if (opts.agent) return adapterCommand(opts.agent, opts);
  if (process.env.AGENTFLOW_AGENT_CMD) return { argv: split(process.env.AGENTFLOW_AGENT_CMD) };
  if (process.env.AGENTFLOW_AGENT) return adapterCommand(process.env.AGENTFLOW_AGENT, opts);
  return null;
}

// opts.agent（对象或只写 CLI 名）展开成内核适配器；值原样转交，不翻译、不校验
// opts.check 时在 `--` 之前插一个 --check（§10.1 的只校验用法），不然会被当成给 CLI 的开关转交下去
function adapterCommand(spec, { check = false } = {}) {
  const a = typeof spec === 'string' ? { cli: spec } : spec;
  const argv = [process.execPath, AGENT_CLI, String(a.cli)];
  for (const k of ['model', 'thinking', 'provider', 'session']) if (a[k]) argv.push(`--${k}`, String(a[k]));
  if (check) argv.push('--check');
  if (a.args?.length) argv.push('--', ...a.args.map(String));
  return { argv, agent: { cli: a.cli, model: a.model, thinking: a.thinking, session: a.session } };
}

export async function agent(goal, opts = {}) {
  // 只校验、不干活（§10.1）：问一句这份配置能不能用，不调模型、不写日志、不占一次 agentCalls
  if (opts.check) return checkAgent(opts);

  const startedAt = Date.now();
  const pkg = {
    goal,
    inputs: opts.inputs ?? {},
    constraints: opts.constraints ?? [],
    budget: { maxTokens: 20000, timeoutSec: 7200, idleSec: 1200, maxTurns: 8, ...(opts.budget ?? {}) }
  };

  let status;
  let choice;
  let reason;
  let data;
  let session; // 适配器交回的会话号：只透传、记日志，不参与契约判定（§10）

  const command = agentCommand(opts);

  // 过程事件（§10.1、§13.6）：每次 agent 调用开跑前就分配好过程文件位置，
  // 随 running 行一起给 viewer，过程按钮不必等终态。适配器会往里写归一事件；
  // 自定义命令（opts.cmd）也可以写，不写就是空文件。覆盖继承来的 AGENTFLOW_AGENT_LOG，免得串到外层步骤。
  let env = process.env;
  let events;
  if (command) {
    const absBase = path.join(LOGS_DIR, rid(), `agent-${++agentCalls}`);
    env = { ...process.env, AGENTFLOW_AGENT_LOG: absBase };
    events = eventsRel(absBase);
  }

  // 进行中记录（§13.1）：动作已开始是既成事实，不是对结果的承诺。
  // say 取任务给的短名（label，缺省 'Agent'）：提示词太长，当节点名会淹掉时间线（§13.6），
  // 全文改记在 goal 字段里，viewer 展开「输入信息」时再显示。不凭空编「正在努力…」。
  const label = opts.label ? String(opts.label) : 'Agent';
  const runningSeq = command
    ? log({ primitive: 'agent', name: 'agent', label, agent: command.agent, events, goal: String(goal), status: 'running', say: label })
    : null;

  if (!command) {
    // 没配外部 Agent 时不假装思考：明确 failed，让任务自己决定怎么办（§6.2）
    status = 'failed';
    choice = 'agent_unavailable';
    reason = `未配置 Agent：设 AGENTFLOW_AGENT=pi|codex|cursor，或传 opts.agent / AGENTFLOW_AGENT_CMD；stub 收到 goal：${goal}`;
    data = {};
  } else {
    const [bin, ...rest] = command.argv;
    const res = await run(bin, rest, JSON.stringify(pkg), (pkg.budget.timeoutSec + 5) * 1000, env, AGENT_CWD);
    try {
      const out = JSON.parse(res.stdout);
      session = out?.session;
      // 输出不合契约（§6.2）就 failed：不补默认值，不猜，不隐式回落
      if (!['ok', 'need_human', 'failed'].includes(out?.status) || typeof out?.choice !== 'string') {
        status = 'failed';
        choice = 'agent_bad_output';
        reason = 'agent_bad_output';
        data = { stdout: res.stdout.slice(-2000), stderr: res.stderr.slice(-2000) };
      } else {
        status = out.status;
        choice = out.choice;
        reason = out.reason ?? '';
        data = out.data ?? {};
      }
    } catch {
      status = 'failed';
      choice = 'agent_invalid_json';
      reason = 'agent_invalid_json';
      data = { stdout: res.stdout.slice(-2000), stderr: res.stderr.slice(-2000) };
    }
  }

  log({
    primitive: 'agent',
    name: 'agent',
    label,
    agent: command?.agent,
    events,
    ref: runningSeq ?? undefined, // 指回进行中那条，viewer 据此判定步骤已结束（§13.5 的重放机制）
    status,
    choice,
    reason,
    session,
    say: reason || `agent: ${choice}`,
    error: status === 'failed' ? reason : undefined,
    durationMs: Date.now() - startedAt
  });

  return session === undefined ? { status, choice, reason, data } : { status, choice, reason, data, session };
}

// 只校验 Agent 配置（§10.1）：起适配器的 --check 用法问一句，不调模型。
// 自定义命令（opts.cmd / AGENTFLOW_AGENT_CMD）没法校验，直接 ok。
async function checkAgent(opts) {
  const command = agentCommand(opts);
  if (!command) {
    return {
      status: 'failed',
      choice: 'agent_unavailable',
      reason: '未配置 Agent：设 AGENTFLOW_AGENT=pi|codex|cursor，或传 opts.agent / AGENTFLOW_AGENT_CMD',
      data: {}
    };
  }
  if (!command.agent) return { status: 'ok', choice: 'ok', reason: '自定义命令，跳过校验', data: {} };

  const [bin, ...rest] = command.argv;
  const res = await run(bin, rest, '', 60_000);
  let out;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    return {
      status: 'failed',
      choice: 'agent_cli_failed',
      reason: `校验 Agent 配置时适配器没交回结论：${firstLine(res.stderr) || `exit_${res.code}`}`,
      data: {}
    };
  }
  return {
    status: out.status === 'ok' ? 'ok' : 'failed',
    choice: typeof out.choice === 'string' ? out.choice : 'agent_bad_config',
    reason: String(out.reason ?? ''),
    data: out.data ?? {}
  };
}

const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// events 一律记成相对 HOME logs/ 的路径（§12）：viewer 按 logs/<events> 拼文件
function eventsRel(absBase) {
  return path.relative(LOGS_DIR, absBase).split(path.sep).join('/') + '.events.jsonl';
}

// ── human（§6.3、§13.4、§13.5）────────────────────────────────────────────
export async function human(prompt, opts = {}) {
  const startedAt = Date.now();

  const auto = opts.answer ?? (autoYes() ? 'ok' : null);
  if (auto) {
    log({
      primitive: 'human', status: auto, prompt,
      say: `${prompt} → ${zh(auto)}（自动）`,
      durationMs: Date.now() - startedAt
    });
    return { status: auto };
  }

  const seq = log({ primitive: 'human', status: 'pending', prompt, say: `⏸ ${prompt}` });

  const status = humanMode() === 'stdin'
    ? await askStdin(prompt)
    : await waitForDecision(path.join(LOGS_DIR, `${rid()}.decide.${seq}.json`), prompt, opts.timeoutMs ?? 3_600_000);

  log({
    primitive: 'human', ref: seq, status, prompt,
    say: `${prompt} → ${zh(status)}`,
    durationMs: Date.now() - startedAt
  });

  return { status };
}

function zh(s) {
  return s === 'ok' ? '通过' : s === 'skipped' ? '拒绝' : s === 'failed' ? '超时/失败' : s;
}

function autoYes() {
  return process.env.AGENTFLOW_YES === '1' || process.argv.includes('--yes');
}

// 有终端就地问（§13.4）；没有终端等决定文件（§13.5）
function humanMode() {
  return process.env.AGENTFLOW_HUMAN ?? (process.stdin.isTTY ? 'stdin' : 'web');
}

function askStdin(prompt) {
  process.stderr.write(`\n⏸ ${prompt} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(String(d).trim()) ? 'ok' : 'skipped');
    });
  });
}

async function waitForDecision(file, prompt, timeoutMs) {
  process.stderr.write(
    `\n⏸ 等待人工确认：${prompt}\n` +
    `   打开 http://<本机>:${process.env.PORT ?? 8787} 点「通过 / 拒绝」\n`
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      return d.decision === 'ok' ? 'ok' : d.decision === 'skipped' ? 'skipped' : 'failed';
    } catch { /* 还没写 */ }
    if (Date.now() > deadline) return 'failed';
    await sleep(300);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
