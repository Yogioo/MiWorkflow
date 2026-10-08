// beads 讨论流程的存储形态：「规范形状 ↔ beads 存储」的翻译层，只给 discuss_* 用（Core.md §15）。
// 这是模板内容，复制进项目后归项目所有。
//
// beads 存纯文本，HTML 注释原样保留（实测 1.1.2），所以跟 GitHub 同一套形态：
// spec 与开发单清单写在描述（description）的两个 HTML 注释区域里，人写的原文留在上面；
// AI 记账标记是评论末尾的 HTML 注释——只认末尾：人引用 AI 评论时标记会落在中间，不能把人写的当成 AI 的。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBd } from './_bd.mjs';

export const SPEC_BEGIN = '<!-- miworkflow:spec:begin -->';
export const SPEC_END = '<!-- miworkflow:spec:end -->';
const SPEC_AREA = /<!--\s*miworkflow:spec:begin\s*-->([\s\S]*?)<!--\s*miworkflow:spec:end\s*-->/g;
const TICKETS_BEGIN = '<!-- miworkflow:tickets:begin -->';
const TICKETS_END = '<!-- miworkflow:tickets:end -->';
const TICKETS_AREA = /<!--\s*miworkflow:tickets:begin\s*-->[\s\S]*?<!--\s*miworkflow:tickets:end\s*-->/g;
const MARK_RE = /<!--\s*miworkflow:discuss\s+hash=([0-9a-f]+)((?:\s+\w+=\S+?)*)\s*-->\s*$/;

// 人写的正文：去掉 spec 区域与开发单区域
export const humanBodyOf = (body) => String(body ?? '').replace(SPEC_AREA, '').replace(TICKETS_AREA, '').trimEnd();

// 当前 spec（最后一次写的那个区域）或 null
export const specOfBody = (body) => {
  const m = [...String(body ?? '').matchAll(SPEC_AREA)];
  return m.length ? m[m.length - 1][1].trim() : null;
};

const ticketsOf = (body) => [...String(body ?? '').matchAll(TICKETS_AREA)].map((m) => m[0]).pop() ?? null;

// 拼回正文：人写的原文 + spec 区域 + 开发单区域；传 null 表示去掉那一段
export const withRegions = (body, { spec, tickets } = {}) => {
  const nextSpec = spec === undefined ? specOfBody(body) : spec;
  const nextTickets = tickets === undefined ? ticketsOf(body) : tickets;
  return [
    humanBodyOf(body),
    nextSpec === null || nextSpec === undefined ? null : `${SPEC_BEGIN}\n${nextSpec}\n${SPEC_END}`,
    nextTickets === null || nextTickets === undefined ? null : `${TICKETS_BEGIN}\n${nextTickets}\n${TICKETS_END}`
  ].filter(Boolean).join('\n\n');
};

// 评论末尾的记账标记 → { hash, seen, cli, session, body } 或 null
export function parseMark(text) {
  const m = MARK_RE.exec(String(text ?? ''));
  if (!m) return null;
  const fields = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
  return {
    hash: m[1],
    ...(fields.seen !== undefined ? { seen: Number(fields.seen) } : {}),
    ...(fields.cli ? { cli: fields.cli } : {}),
    ...(fields.session ? { session: fields.session } : {}),
    ...(fields.body ? { body: fields.body } : {})
  };
}

// 评论正文去掉末尾的标记（给人看 / 参与哈希的内容）
export const stripMark = (text) => String(text ?? '').replace(MARK_RE, '').trimEnd();

const MARK_FIELDS = ['hash', 'seen', 'cli', 'session', 'body'];
export const renderMark = (mark) =>
  `<!-- miworkflow:discuss ${MARK_FIELDS
    .filter((k) => mark?.[k] !== undefined && mark[k] !== null && mark[k] !== '')
    .map((k) => `${k}=${mark[k]}`).join(' ')} -->`;

// 长文（描述、评论、开发单正文）一律写成临时文件交给 bd，不经命令行（长度、换行都不受限）
export function withTextFile(text, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-bd-'));
  try {
    const file = path.join(dir, 'text.md');
    writeFileSync(file, text);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const addComment = (id, text) => withTextFile(text, (file) => runBd(['comments', 'add', id, '-f', file]));
