// GitHub 工单源专用工具：gh 调用、issue / label 小工具。通用的 stdin/stdout、git 在 _lib.mjs。
// 这是模板内容，复制进项目后归项目所有。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GH_RETRY_DELAYS } from '../source.mjs';

// ── gh ────────────────────────────────────────────────────────────────────
// 不经 shell（Core §11）；工单系统故障（网络、5xx、GraphQL 通用服务端报错、限流）按 GH_RETRY_DELAYS 退避重试。
// 重试完仍是故障，抛出的错误带 transient: true，main() 据此在出参 data 里标 transient（Core §15）。
// 测试 / 替换：设 MIWORKFLOW_GH 指向一个 JS 文件，就改成 node <那个文件> 执行（参数照传）。
const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errorText = (err) =>
  [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean).map((v) => String(v).trim()).filter(Boolean).join(' ');

const firstSentence = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// 状态码要带 HTTP 或原因短语：「number of 500」这类工单号不算
const SERVER_ERROR = /\bHTTP[/\d.]*\s*50[0-4]\b|\b50[0-4]\s+(internal server error|bad gateway|service unavailable|gateway time-?out)/i;
const CLIENT_ERROR = /\bHTTP 4\d\d\b|not found|could not resolve|permission|forbidden|unauthori[sz]ed|must have|not accessible/i;

// 只看 gh 的输出：err.message 里带着命令行，工单号 500 这类参数会被误认成状态码
const outputText = (err) =>
  [err?.stderr, err?.stdout].filter(Boolean).map((v) => String(v).trim()).filter(Boolean).join(' ') || String(err?.message ?? '');

export const retryable = (err) => {
  const text = outputText(err);
  if (/rate limit/i.test(text)) return true;
  if (/network|timeout|timed out|connection|econnreset|econnrefused|etimedout|eai_again|socket hang up|temporarily unavailable|reset by peer|unexpected eof|\beof\b/i.test(text)) return true;
  if (SERVER_ERROR.test(text)) return true;
  if (/something went wrong while executing your query/i.test(text)) return true;
  return /GraphQL: Could not /i.test(text) && !CLIENT_ERROR.test(text);
};

export function runGh(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const fake = process.env.MIWORKFLOW_GH;
  const spawn = () => {
    const bin = fake ? process.execPath : 'gh';
    const args = fake ? [fake, ...argv] : argv;
    return execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  };
  const delays = opts.retryDelays ?? GH_RETRY_DELAYS;
  const retries = opts.retries ?? delays.length;
  for (let attempt = 0; ; attempt++) {
    try {
      return spawn();
    } catch (err) {
      const transient = retryable(err);
      const detail = errorText(err);
      if (!transient || attempt >= retries) {
        const e = new Error(`gh ${argv.join(' ')} 失败${detail ? `：${detail}` : ''}`, { cause: err });
        if (transient) e.transient = true;
        throw e;
      }
      const wait = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      process.stderr.write(`gh ${argv[0]} ${argv[1] ?? ''} 第 ${attempt + 1} 次重试（等 ${Math.round(wait / 1000)} 秒）：${firstSentence(outputText(err))}\n`);
      sleep(wait);
    }
  }
}

// ── 图片下载 ───────────────────────────────────────────────────────────────
// 私有仓库的 github.com/user-attachments/… 不带鉴权是 404；带 gh auth token 会 302 到 S3 预签名地址。
// 重定向手动跟：令牌只经 https 发给 github.com，跟到别的主机或降级到 http 就不带。
// 测试 / 替换：设 MIWORKFLOW_FETCH 指向一个默认导出 fetch 的 JS 文件。
const needsToken = (url) => { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'github.com'; };

export function ghToken() {
  return runGh(['auth', 'token'], { retries: 0 }).trim();
}

export async function fetchImpl() {
  const fake = process.env.MIWORKFLOW_FETCH;
  return fake ? (await import(pathToFileURL(path.resolve(fake)).href)).default : fetch;
}

export async function downloadImage(url, { token, fetch: doFetch, maxHops = 5, timeoutMs = 30_000 }) {
  let u = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const headers = token && needsToken(u) ? { Authorization: `Bearer ${token}` } : {};
    const res = await doFetch(u, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} 没有 Location`);
      u = new URL(loc, u).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`重定向超过 ${maxHops} 次`);
}

export const anyNeedsToken = (urls) => urls.some((u) => { try { return needsToken(u); } catch { return false; } });

// ── issue / label 小工具 ──────────────────────────────────────────────────
export const labelName = (label) =>
  typeof label === 'string' ? label : (label?.name ?? '');

export const hasLabel = (issue, name) =>
  (issue?.labels ?? []).some((l) => labelName(l).toLowerCase() === String(name).toLowerCase());

// P0~P4 取最小；没有 P 标签当 P2
export function priorityFromLabels(labels) {
  const ps = (labels ?? []).map(labelName)
    .map((n) => /^P([0-4])$/i.exec(n)).filter(Boolean).map((m) => Number(m[1]));
  return ps.length ? Math.min(...ps) : 2;
}

// 正文里 `- [ ] #123` = 被 #123 挡着；勾上就算满足。只认同仓库的 #N
export function parseTaskList(body) {
  const refs = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*-\s+\[([ xX])\]\s+#(\d+)(?:\s|$)/);
    if (m) refs.push({ number: Number(m[2]), checked: m[1].toLowerCase() === 'x' });
  }
  return refs;
}

export const commentAuthor = (c) =>
  typeof c?.author === 'string' ? c.author : (c?.author?.login ?? '');

// GitHub 的工单引用：#N
export const refOf = (number) => `#${number}`;

// 工单号（字符串）→ issue 号；不是正整数就报错
export function issueNumber(id) {
  const s = String(id ?? '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(s) || Number(s) <= 0) throw new Error(`工单号不对：${id}`);
  return Number(s);
}

// 读一个 issue：正文 + 全部评论（按时间，不截断）+ 拼好给 Agent 看的文本。ticket_view 与 gh_discuss_view 共用
export function viewIssue(number, repoArg = []) {
  const raw = runGh([
    'issue', 'view', String(number),
    '--json', 'number,title,body,labels,comments', ...repoArg
  ]);
  const issue = JSON.parse(raw);

  const comments = (issue.comments ?? []).map((c) => ({
    author: commentAuthor(c),
    at: c.createdAt ?? '',
    body: c.body ?? ''
  }));

  // 人补充的说明、上次失败留下的评论，执行端都要能看到
  const text = [
    `# ${refOf(issue.number)} ${issue.title}`,
    '',
    issue.body ?? '',
    ...comments.map((c) => `\n---\n@${c.author} 评论（${c.at}）：\n${c.body}`)
  ].join('\n');

  return {
    number: Number(issue.number),
    title: issue.title ?? '',
    body: issue.body ?? '',
    comments,
    text,
    labels: (issue.labels ?? []).map(labelName)
  };
}
