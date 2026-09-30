// TAPD 讨论流程的工具：AI 记账标记、spec 评论、标签读写。
//
// 标记是评论末尾一行**纯文本**（2026-09-30 实测：TAPD 会把 HTML 注释整个剥掉，纯文本 / <sub> / <details> / <span data-*>
// 四种才活得下来，见 TODO F4.1）：
//   [miworkflow:discuss hash=<hash> seen=<n> cli=<cli> session=<s> body=<hash> kind=spec]
// 读回来是 HTML，经 htmlToMarkdown 转成 Markdown 后，标记就落在末尾那一行；kind=spec 的评论是当前 spec。
import { tapdJson, openApi, htmlToMarkdown, labelsOf } from './_tapd.mjs';
import { WORKSPACE_ID, COMMENTER, refOf } from '../source.mjs';

const MARK_FIELDS = ['hash', 'seen', 'cli', 'session', 'body', 'kind'];
const MARK_RE = /\[miworkflow:discuss\s+hash=([0-9a-f]+)((?:\s+\w+=\S+?)*)\]\s*$/;

export const renderMark = (mark, extra = {}) => {
  const all = { ...mark, ...extra };
  return `[miworkflow:discuss ${MARK_FIELDS
    .filter((k) => all[k] !== undefined && all[k] !== null && all[k] !== '')
    .map((k) => `${k}=${all[k]}`).join(' ')}]`;
};

// 评论（Markdown）末尾的标记 → { hash, seen, cli, session, body, kind } 或 null
export function parseMark(text) {
  const m = MARK_RE.exec(String(text ?? ''));
  if (!m) return null;
  const fields = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
  return {
    hash: m[1],
    ...(fields.seen !== undefined ? { seen: Number(fields.seen) } : {}),
    ...(fields.cli ? { cli: fields.cli } : {}),
    ...(fields.session ? { session: fields.session } : {}),
    ...(fields.body ? { body: fields.body } : {}),
    ...(fields.kind ? { kind: fields.kind } : {})
  };
}

export const stripMark = (text) => String(text ?? '').replace(MARK_RE, '').trimEnd();

export const md = (html) => htmlToMarkdown(html) || '';

const wsArg = (ws) => (ws ? [`workspace_id=${ws}`] : []);
const wsOf = (s) => String(s?.workspace_id || WORKSPACE_ID || '');

// 按需求号读一条需求
export function storyOf(id) {
  const listed = tapdJson(['story', 'list', `id=${id}`, 'with_v_status=1', ...wsArg(WORKSPACE_ID)]);
  const rows = Array.isArray(listed.data) ? listed.data : [];
  const story = rows.map((r) => r?.Story).find((s) => s && String(s.id).trim() === String(id));
  if (!story) throw new Error(`找不到 ${refOf(id)}`);
  return story;
}

// 写标签（多值用 | 分隔），写完回读校验 —— 写逗号会被当成一个新标签名，不报错但会建出垃圾标签
export function writeLabels(story, labels) {
  const id = String(story.id).trim();
  const want = [...new Set(labels.filter(Boolean))];
  const r = tapdJson(['story', 'update', `id=${id}`, `label=${want.join('|')}`, ...wsArg(wsOf(story))]);
  const back = labelsOf(r.data?.Story ?? story);
  const missing = want.filter((l) => !back.includes(l));
  if (missing.length) throw new Error(`${refOf(id)} 写标签后回读不到：${missing.join('、')}`);
  return want;
}

// 发一条评论（Markdown，末尾附上记账标记）
export function addComment(ws, id, markdown, mark) {
  if (!COMMENTER) throw new Error('缺评论人：设 TAPD_NPC_ROLE 或 source.mjs 的 COMMENTER');
  const body = [String(markdown).trim(), mark ? renderMark(mark) : null].filter(Boolean).join('\n\n');
  const r = tapdJson(['comment', 'add', 'entry_type=stories', `entry_id=${id}`, `description=${body}`, `author=${COMMENTER}`, ...wsArg(ws)]);
  return String(r.id ?? r.data?.Comment?.id ?? '');
}

// 写前后置依赖：只认表单扁平写法（JSON body 报 422），`relations[0][…]` 下标从 0 起
export async function saveRelations(ws, edges, currentUser) {
  if (!edges.length) return;
  const form = { workspace_id: ws, current_user: currentUser };
  edges.forEach((e, i) => {
    form[`relations[${i}][workitem_id]`] = e.from;
    form[`relations[${i}][dst_workitem_id]`] = e.to;
    form[`relations[${i}][src_field]`] = 'due';
    form[`relations[${i}][dst_field]`] = 'begin';
  });
  await openApi('/stories/save_time_relations', { method: 'POST', form });
}

// 本单是后置的那些关系里，前置是谁
export async function predecessorsOf(ws, id) {
  const r = await openApi('/stories/get_time_relative_stories', { query: { workspace_id: ws || undefined, story_id: id } });
  const rows = (Array.isArray(r.data) ? r.data : []).map((x) => x?.WorkitemTimeRelation).filter(Boolean);
  return rows.filter((x) => String(x.dst_workitem_id ?? '').trim() === String(id)).map((x) => String(x.workitem_id ?? '').trim());
}

// 子需求（开发单挂在讨论单下）
export function childrenOf(parentId, ws) {
  const r = tapdJson(['story', 'list', `parent_id=${parentId}`, 'limit=200', ...wsArg(ws)]);
  return (Array.isArray(r.data) ? r.data : []).map((x) => x?.Story).filter((s) => s && s.id != null)
    .map((s) => ({ id: String(s.id).trim(), title: s.name || String(s.id), labels: labelsOf(s) }));
}
