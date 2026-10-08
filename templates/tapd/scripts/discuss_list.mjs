// 工单源接口：列要处理的讨论单（TAPD 实现）。
// 只看标签：贴了 agent-discuss，且阶段标签（discuss:*）为空或是 grilling / spec。
// TAPD 没有「打开 / 关闭」这个开关（状态是人验收后自己流转的），所以讨论单结束时靠阶段标签（ticketed）或摘掉 agent-discuss 来退出。
// 入：{ enter, grilling, spec, cursor? }
// 出：{ status, say, data: { items: [{ id, ref, title, labels, changed }], cursor } }
//
// 增量（省调用额度）：cursor 是上一次交回的原样，记着各需求的 modified 与见过的最大评论 ID。
// 给了 cursor，changed = 需求改过（正文、标签）或有了新的人的评论（带 AI 标记的不算）；没给就全当 changed。
// 每次固定两次请求：一次 story list、一次全项目最新评论（不按需求逐张读）。
import { main, readStdin, emit } from './_lib.mjs';
import { tapdJson, openApi, labelsOf } from './_tapd.mjs';
import { md, parseMark } from './_discuss.mjs';
import { WORKSPACE_ID, refOf } from '../source.mjs';

const LIST_LIMIT = 200;
const COMMENT_PAGE = 200;
const byId = (a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const idNum = (v) => { try { return BigInt(String(v ?? '').trim() || '0'); } catch { return 0n; } };

await main(async () => {
  const args = await readStdin();
  const enter = args.enter ?? 'agent-discuss';
  const ok = new Set([args.grilling ?? 'discuss:grilling', args.spec ?? 'discuss:spec'].map((l) => l.toLowerCase()));
  const prev = args.cursor && typeof args.cursor === 'object' ? args.cursor : null;

  const listed = tapdJson(['story', 'list', `label=${enter}`, `limit=${LIST_LIMIT}`, ...(WORKSPACE_ID ? [`workspace_id=${WORKSPACE_ID}`] : [])]);
  const stories = (Array.isArray(listed.data) ? listed.data : [])
    .map((r) => r?.Story).filter((s) => s && s.id != null && String(s.id).trim())
    .map((s) => ({ id: String(s.id).trim(), story: s, labels: labelsOf(s) }))
    .filter((i) => i.labels.some((l) => l.toLowerCase() === enter.toLowerCase()))
    .filter((i) => i.labels.filter((l) => /^discuss:/i.test(l)).every((l) => ok.has(l.toLowerCase())))
    .sort(byId);

  // 没有讨论单就不翻评论：游标原样交回（没有就不给），等有了单子再定起点
  if (!stories.length) return emit({ status: 'ok', say: '没有讨论单', data: { items: [], ...(prev ? { cursor: prev } : {}) } });

  const since = prev ? idNum(prev.comment) : null;
  const fresh = await newHumanComments(WORKSPACE_ID || String(stories[0].story.workspace_id || ''), since);
  const items = stories.map(({ id, story, labels }) => ({
    id, ref: refOf(id), title: story.name || id, labels,
    changed: !prev || prev.stories?.[id] !== String(story.modified ?? '') || fresh.entries.has(id)
  }));
  const cursor = {
    stories: Object.fromEntries(stories.map(({ id, story }) => [id, String(story.modified ?? '')])),
    comment: String(since !== null && since > fresh.top ? since : fresh.top)
  };
  const changed = items.filter((i) => i.changed);
  emit({
    status: 'ok',
    say: prev ? `讨论单 ${items.length} 张，有变化 ${changed.length} 张${changed.length ? `：${changed.map((i) => i.ref).join('、')}` : ''}`
      : `讨论单 ${items.length} 张：${items.map((i) => i.ref).join('、')}`,
    data: { items, cursor }
  });
});

// 全项目按创建时间倒序翻评论：since 之后的人的评论落在哪些需求上（AI 自己发的带标记，不算）。
// since 为 null（没有游标）只取一条，拿到当前最大评论 ID 当起点。
// 同一秒的评论排序不稳，所以不在第一条旧评论处截断，而是翻到「整页都不新」或不满一页为止。
async function newHumanComments(ws, since) {
  const entries = new Set();
  let top = 0n;
  for (let page = 1; ; page++) {
    const r = await openApi('/comments', {
      query: { workspace_id: ws || undefined, entry_type: 'stories', order: 'created desc', limit: since === null ? 1 : COMMENT_PAGE, page }
    });
    const rows = (Array.isArray(r.data) ? r.data : []).map((x) => x?.Comment).filter(Boolean);
    let newer = 0;
    for (const c of rows) {
      const id = idNum(c.id);
      if (id > top) top = id;
      if (since === null || id <= since) continue;
      newer++;
      if (!parseMark(md(c.description))) entries.add(String(c.entry_id ?? '').trim());
    }
    if (since === null || !newer || rows.length < COMMENT_PAGE) break;
  }
  return { entries, top };
}
