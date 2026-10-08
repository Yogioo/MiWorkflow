// beads 工单源专用工具：bd 调用、issue 小工具。通用的 stdin/stdout、git 在 _lib.mjs。
// 这是模板内容，复制进项目后归项目所有。
//
// 实测过的 bd 行为（1.1.2）：
// - `bd list --json` 只列没关的单，带 labels 与 dependencies（{ depends_on_id, type }），子单另有 parent；缺省只给 50 条，要 --limit 0
// - `bd show <id> --json` 出一个元素的数组，不带评论；评论另用 `bd comments <id> --json`（{ id, author, text, created_at }）
// - `bd label remove` 摘一个没贴的标签不报错；`bd comments add <id> -f <文件>` 从文件读评论（多行、长文都不经命令行）
// - bd 在当前目录一路往上找 .beads/，脚本的工作目录是 .workflow/，找得到项目根的库
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BD, ACTOR, BD_RETRY_DELAYS } from '../source.mjs';

// ── bd ────────────────────────────────────────────────────────────────────
// 不经 shell（Core §11）；暂时失败（库被锁、server 连不上、超时）按 BD_RETRY_DELAYS 退避重试。
// 重试完仍失败，抛出的错误带 transient: true，main() 据此在出参 data 里标 transient（Core §15）。
// 测试 / 替换：设 MIWORKFLOW_BD 指向一个 JS 文件，就改成 node <那个文件> 执行（参数照传）。
const sleep = (ms) => {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const errorText = (err) =>
  [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean).map((v) => String(v).trim()).filter(Boolean).join(' ');

const firstSentence = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// 只看 bd 的输出：err.message 里带着命令行，标题、评论里的字眼会被误认成故障
const outputText = (err) =>
  [err?.stderr, err?.stdout].filter(Boolean).map((v) => String(v).trim()).filter(Boolean).join(' ') || String(err?.message ?? '');

export const retryable = (err) =>
  /database is locked|\block(ed)?\b|\bbusy\b|timeout|timed out|connection refused|connection reset|econnrefused|econnreset|broken pipe|bad connection|too many connections|temporarily unavailable|try again|\bHTTP[/\d.]*\s*50[0-4]\b/i
    .test(outputText(err));

const missingCommand = (err) =>
  err?.code === 'ENOENT' || /\benoent\b|not recognized|不是内部或外部命令/i.test(errorText(err));

const viaNode = (file) => /\.m?js$/i.test(file);

function command() {
  const fake = process.env.MIWORKFLOW_BD;
  if (fake) return [process.execPath, [fake]];
  if (BD) return viaNode(BD) ? [process.execPath, [BD]] : [BD, []];
  if (process.platform === 'win32' && process.env.APPDATA) {
    const bin = path.join(process.env.APPDATA, 'npm', 'node_modules', '@beads', 'bd', 'bin');
    for (const name of ['bd.exe', 'bd.js']) {
      const file = path.join(bin, name);
      if (existsSync(file)) return viaNode(file) ? [process.execPath, [file]] : [file, []];
    }
  }
  return ['bd', []];
}

export function runBd(argv, opts = {}) {
  const [bin, prefix] = command();
  const args = [...prefix, ...(ACTOR ? ['--actor', ACTOR] : []), ...argv];
  const delays = opts.retryDelays ?? BD_RETRY_DELAYS;
  const retries = opts.retries ?? delays.length;
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(bin, args, { cwd: opts.cwd ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      if (!process.env.MIWORKFLOW_BD && missingCommand(err)) {
        throw new Error('找不到 bd：先装 beads（npm i -g @beads/bd），或在 source.mjs 的 BD 写上 bd 的路径', { cause: err });
      }
      const transient = retryable(err);
      const detail = errorText(err);
      if (!transient || attempt >= retries) {
        const e = new Error(`bd ${argv.join(' ')} 失败${detail ? `：${detail}` : ''}`, { cause: err });
        if (transient) e.transient = true;
        throw e;
      }
      const wait = delays[Math.min(attempt, delays.length - 1)] ?? 0;
      process.stderr.write(`bd ${argv[0]} ${argv[1] ?? ''} 第 ${attempt + 1} 次重试（等 ${Math.round(wait / 1000)} 秒）：${firstSentence(outputText(err))}\n`);
      sleep(wait);
    }
  }
}

// 跑一条带 --json 的 bd 命令并解析；输出前面混了提示行也从第一个 [ / { 开始读
export function bdJson(argv) {
  const raw = runBd([...argv, '--json']);
  const start = raw.search(/[[{]/);
  if (start < 0) {
    if (!raw.trim()) return null;
    throw new Error(`bd ${argv.join(' ')} 没有返回 JSON：${raw.trim().slice(0, 200)}`);
  }
  try {
    return JSON.parse(raw.slice(start));
  } catch (err) {
    throw new Error(`bd ${argv.join(' ')} 返回非法 JSON：${err.message}`, { cause: err });
  }
}

// ── issue 小工具 ──────────────────────────────────────────────────────────
export const labelsOf = (issue) => (Array.isArray(issue?.labels) ? issue.labels.map(String) : []);

export const hasLabel = (issue, name) =>
  labelsOf(issue).some((l) => l.toLowerCase() === String(name).toLowerCase());

// beads 的优先级本来就是 0~4（0 最急）；没有或不认识的当 2
export const priorityOf = (issue) =>
  (Number.isInteger(issue?.priority) && issue.priority >= 0 && issue.priority <= 4 ? issue.priority : 2);

// 依赖两种形状：bd list 给 { depends_on_id, type }，bd show 给前置单本身 { id, …, dependency_type }
const depsOf = (issue) => (Array.isArray(issue?.dependencies) ? issue.dependencies : [])
  .map((d) => ({ id: String(d?.depends_on_id ?? d?.id ?? ''), type: String(d?.type ?? d?.dependency_type ?? '') }))
  .filter((d) => d.id);

// 挡住这张单的前置：只认 blocks 类依赖（related、discovered-from 这些不挡）
export const blockersOf = (issue) => depsOf(issue).filter((d) => d.type === 'blocks').map((d) => d.id);

export const parentOf = (issue) =>
  issue?.parent ? String(issue.parent) : (depsOf(issue).find((d) => d.type === 'parent-child')?.id ?? null);

// 工单号（字符串）；空的报错。beads ID 形如 demo-a3f2、demo-a3f2.1
export function issueId(id) {
  const s = String(id ?? '').trim();
  if (!s || /\s/.test(s)) throw new Error(`工单号不对：${id}`);
  return s;
}

export function showIssue(id) {
  const rows = bdJson(['show', id]);
  const issue = Array.isArray(rows) ? rows[0] : rows;
  if (!issue?.id) throw new Error(`读不到工单 ${id}`);
  return issue;
}

export function listComments(id) {
  const rows = bdJson(['comments', id]);
  return (Array.isArray(rows) ? rows : []).map((c) => ({
    id: String(c.id ?? ''),
    author: String(c.author ?? ''),
    at: String(c.created_at ?? ''),
    text: String(c.text ?? '')
  }));
}
