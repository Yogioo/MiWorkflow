// core.mjs — 三个原语：script / agent / human（§5）
// log() 供 run.mjs 写 run 级记录，不属于任务接口。
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const LOGS_DIR = path.join(ROOT, 'logs');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// 一次运行一个 runId（§12）。延迟解析：run.mjs 先写好 env，再加载本模块。
let runIdCache = null;
function rid() {
  return process.env.AGENTFLOW_RUN_ID || (runIdCache ??= randomUUID());
}

let seq = 0;

// gitSha 只取一次（§12），非 git 仓库则为 null
let gitShaCache;
function gitSha() {
  if (gitShaCache !== undefined) return gitShaCache;
  try {
    gitShaCache = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
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
function run(cmd, argv, input, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    status: result.status,
    error: result.error,
    say: result.say ?? `${name}: ${result.status}`,
    durationMs: Date.now() - startedAt
  });

  return result;
}

// ── agent（§6.2、§10）─────────────────────────────────────────────────────
export async function agent(goal, opts = {}) {
  const startedAt = Date.now();
  const pkg = {
    goal,
    inputs: opts.inputs ?? {},
    constraints: opts.constraints ?? [],
    budget: { maxTokens: 20000, timeoutSec: 120, maxTurns: 8, ...(opts.budget ?? {}) }
  };

  let status;
  let choice;
  let reason;
  let data;

  const cmd = opts.cmd ?? process.env.AGENTFLOW_AGENT_CMD;
  if (!cmd) {
    // 没配外部 Agent 时不假装思考：明确 failed，让任务自己决定怎么办（§6.2）
    status = 'failed';
    choice = 'agent_unavailable';
    reason = `未配置 AGENTFLOW_AGENT_CMD；stub 收到 goal：${goal}`;
    data = {};
  } else {
    const [bin, ...rest] = cmd.split(/\s+/).filter(Boolean);
    const res = await run(bin, rest, JSON.stringify(pkg), (pkg.budget.timeoutSec + 5) * 1000);
    try {
      const out = JSON.parse(res.stdout);
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
      data = { stderr: res.stderr.slice(-2000) };
    }
  }

  log({
    primitive: 'agent',
    name: 'agent',
    status,
    choice,
    reason,
    say: reason || `agent: ${choice}`,
    error: status === 'failed' ? reason : undefined,
    durationMs: Date.now() - startedAt
  });

  return { status, choice, reason, data };
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
