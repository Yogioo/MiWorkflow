// TAPD 工单源专用工具：tapd-cli 调用、OpenAPI 调用、令牌打码。通用的 stdin/stdout、git 在 _lib.mjs。
// 这是模板内容，复制进项目后归项目所有。
import { execFileSync } from 'node:child_process';

// ── 打码 ──────────────────────────────────────────────────────────────────
// 报错信息里不留令牌：32 位十六进制一律打码，TAPD_TOKEN 的原值也打码。
export function mask(text) {
  let s = String(text ?? '').replace(/\b[0-9a-f]{32}\b/gi, '***');
  const token = process.env.TAPD_TOKEN;
  if (token && token.length >= 4) s = s.split(token).join('***');
  return s;
}

// ── JSON ──────────────────────────────────────────────────────────────────
// 只解析第一段 JSON：`comment add` 会在 JSON 后面多一行 `已写入 /tmp/comment.log`。
export function firstJson(raw, context = 'tapd-cli') {
  const s = String(raw ?? '');
  const start = s.search(/[{[]/);
  if (start < 0) throw new Error(mask(`${context} 没有返回 JSON：${s.trim().slice(0, 200)}`));
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch (err) {
        throw new Error(mask(`${context} 返回非法 JSON：${err.message}`), { cause: err });
      }
    }
  }
  throw new Error(mask(`${context} 返回的 JSON 不完整`));
}

// TAPD 用 status=1 表示成功
export function checkPayload(parsed, context) {
  if (parsed && typeof parsed === 'object' && parsed.status !== undefined && Number(parsed.status) !== 1) {
    throw new Error(mask(`${context} 失败：${parsed.info || JSON.stringify(parsed).slice(0, 200)}`));
  }
  return parsed;
}

// ── tapd-cli ──────────────────────────────────────────────────────────────
// 不经 shell（Core §11）；瞬时错误最多重试 2 次。
// 参数一律下划线写法（entry_id=…）：tapd-cli 会静默丢掉连字符形式，把带过滤的查询变成不带过滤的。
// 测试 / 替换：设 MIWORKFLOW_TAPD 指向一个 JS 文件，就改成 node <那个文件> 执行（参数照传）。
const RETRIES = 2;
const RETRY_DELAY_MS = 100;

const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errorText = (err) =>
  [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean).map((v) => String(v).trim()).filter(Boolean).join(' ');

const retryable = (err) =>
  /network|timeout|timed out|connection|econnreset|econnrefused|etimedout|eai_again|enetunreach|ehostunreach|socket hang up|temporarily unavailable|rate limit|502|503|504|reset by peer|unexpected eof|\beof\b/i.test(errorText(err));

const missingCommand = (err) =>
  err?.code === 'ENOENT' || /\benoent\b|not recognized|不是内部或外部命令/i.test(errorText(err));

export function runTapd(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const fake = process.env.MIWORKFLOW_TAPD;
  const spawn = () => {
    const bin = fake ? process.execPath : 'tapd-cli';
    const args = fake ? [fake, ...argv] : argv;
    return execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return spawn();
    } catch (err) {
      if (!fake && missingCommand(err)) {
        throw new Error('找不到 tapd-cli：先装好它（见 tapd-cli 技能），或设 MIWORKFLOW_TAPD', { cause: err });
      }
      if (!retryable(err) || attempt >= (opts.retries ?? RETRIES)) {
        const detail = errorText(err);
        throw new Error(mask(`tapd-cli ${argv.join(' ')} 失败${detail ? `：${detail}` : ''}`), { cause: err });
      }
      sleep((opts.retryDelayMs ?? RETRY_DELAY_MS) * 2 ** attempt);
    }
  }
}

// 跑 tapd-cli 并取第一段 JSON、校验 status
export function tapdJson(argv, opts = {}) {
  const context = `tapd-cli ${argv.slice(0, 2).join(' ')}`;
  return checkPayload(firstJson(runTapd(argv, opts), context), context);
}

// ── OpenAPI ───────────────────────────────────────────────────────────────
// 读评论等要直接调：`tapd-cli comment list` 会把评论的 HTML 全部剥掉。
// $TAPD_API_ENDPOINT + Authorization: Bearer $TAPD_TOKEN；测试经 TAPD_API_ENDPOINT 指到本地假服务。
export async function openApi(pathname, { query = {}, method = 'GET', body, timeoutMs = 30_000 } = {}) {
  const endpoint = process.env.TAPD_API_ENDPOINT;
  const token = process.env.TAPD_TOKEN;
  if (!endpoint) throw new Error('缺环境变量 TAPD_API_ENDPOINT');
  if (!token) throw new Error('缺环境变量 TAPD_TOKEN');

  const url = new URL(String(pathname).replace(/^\/+/, ''), endpoint.endsWith('/') ? endpoint : `${endpoint}/`);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const what = `TAPD OpenAPI ${method} ${url.pathname}`;
  let res;
  let text;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (err) {
    throw new Error(mask(`${what} 失败：${err.message}`), { cause: err });
  }
  if (!res.ok) throw new Error(mask(`${what} 失败：HTTP ${res.status} ${text.slice(0, 200)}`));
  return checkPayload(firstJson(text, what), what);
}
