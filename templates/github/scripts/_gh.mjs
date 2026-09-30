// GitHub 工单源专用工具：gh 调用、issue / label 小工具。通用的 stdin/stdout、git 在 _lib.mjs。
// 这是模板内容，复制进项目后归项目所有。
import { execFileSync } from 'node:child_process';

// ── gh ────────────────────────────────────────────────────────────────────
// 不经 shell（Core §11）；网络类错误有限重试。
// 测试 / 替换：设 MIWORKFLOW_GH 指向一个 JS 文件，就改成 node <那个文件> 执行（参数照传）。
const RETRIES = 3;
const RETRY_DELAY_MS = 100;

const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errorText = (err) =>
  [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean).map((v) => String(v).trim()).filter(Boolean).join(' ');

const retryable = (err) =>
  /network|timeout|timed out|connection|econnreset|econnrefused|etimedout|eai_again|socket hang up|temporarily unavailable|rate limit|502|503|504|reset by peer|unexpected eof|\beof\b/i.test(errorText(err));

export function runGh(argv, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const fake = process.env.MIWORKFLOW_GH;
  const spawn = () => {
    const bin = fake ? process.execPath : 'gh';
    const args = fake ? [fake, ...argv] : argv;
    return execFileSync(bin, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return spawn();
    } catch (err) {
      if (!retryable(err) || attempt >= (opts.retries ?? RETRIES)) {
        const detail = errorText(err);
        throw new Error(`gh ${argv.join(' ')} 失败${detail ? `：${detail}` : ''}`, { cause: err });
      }
      sleep((opts.retryDelayMs ?? RETRY_DELAY_MS) * 2 ** attempt);
    }
  }
}

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
