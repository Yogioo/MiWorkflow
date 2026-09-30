// 工单源接口：列就绪工单。TAPD 实现：只接需求（story），缺陷不处理；入队只看标签——贴了 ready、没贴任何机器标签，不要求处理人。
// 一次 `story list label=<ready>` 拿全部候选（个人令牌每天有配额，别逐个拉）；就绪的按优先级 → 工单号排序。
// 空壳需求（描述与评论都为空）不进 ready：进 blocked，并贴 failed 标签 + 评论请人补充（干跑只进 blocked、不改 TAPD）。
// 只对描述为空的候选走 OpenAPI 读评论（`tapd-cli comment list` 会剥 HTML，只有图片的评论会被当成空）。
// 依赖判断留给后续单：blocked 目前只含空壳。
// 入：{ dryRun? }；AGENTFLOW_DRY_RUN=1 也算干跑
// 出：{ status, say, data: { ready: [{ id, ref, title, priority }], blocked: [{ id, ref, reason }] } }，id 为字符串
import { main, readStdin, emit } from './_lib.mjs';
import { tapdJson, openApi } from './_tapd.mjs';
import { WORKSPACE_ID, COMMENTER, LABELS, priorityOf, knownPriority, refOf } from '../source.mjs';

// TAPD 单页上限 200；满页说明可能还有，提示一句而不是逐页拉
const LIST_LIMIT = 200;
const EMPTY_COMMENT = `需求为空，请补充描述后摘掉 ${LABELS.failed}`;

const labelsOf = (s) => String(s.label ?? '').split('|').map((l) => l.trim()).filter(Boolean);
const blank = (html) => !/<img\b/i.test(String(html ?? '')) &&
  !String(html ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').trim();
const byId = (a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const ws = (s) => String(s.workspace_id || WORKSPACE_ID || '');
const wsArg = (s) => (ws(s) ? [`workspace_id=${ws(s)}`] : []);

await main(async () => {
  const args = await readStdin();
  const dryRun = Boolean(args.dryRun) || process.env.AGENTFLOW_DRY_RUN === '1';
  const notes = [];

  const listed = tapdJson([
    'story', 'list', `label=${LABELS.ready}`, `limit=${LIST_LIMIT}`,
    ...(WORKSPACE_ID ? [`workspace_id=${WORKSPACE_ID}`] : [])
  ]);
  const rows = Array.isArray(listed.data) ? listed.data : [];
  if (rows.length >= LIST_LIMIT) notes.push(`候选满 ${LIST_LIMIT} 条，可能没列全`);

  const machine = [LABELS.claimed, LABELS.delivered, LABELS.failed];
  const candidates = rows
    .map((r) => r?.Story)
    .filter((s) => s && s.id != null && String(s.id).trim())
    .map((s) => ({ ...s, id: String(s.id).trim(), labels: labelsOf(s) }))
    .filter((s) => s.labels.includes(LABELS.ready) && !machine.some((l) => s.labels.includes(l)));

  const empty = [];
  for (const s of candidates.filter((c) => blank(c.description))) {
    const r = await openApi('/comments', { query: { workspace_id: ws(s) || undefined, entry_type: 'stories', entry_id: s.id } });
    const comments = (Array.isArray(r.data) ? r.data : []).map((c) => c?.Comment?.description);
    if (comments.every(blank)) empty.push(s);
  }

  if (empty.length && !dryRun) {
    if (!COMMENTER) throw new Error('缺评论人：设 TAPD_NPC_ROLE 或 source.mjs 的 COMMENTER（空壳需求要贴标签并评论）');
    for (const s of empty) {
      const label = [...s.labels, LABELS.failed].join('|');
      const u = tapdJson(['story', 'update', `id=${s.id}`, `label=${label}`, ...wsArg(s)]);
      if (!labelsOf(u.data?.Story ?? {}).includes(LABELS.failed)) {
        throw new Error(`${refOf(s.id)} 贴 ${LABELS.failed} 后回读不到该标签`);
      }
      tapdJson(['comment', 'add', 'entry_type=stories', `entry_id=${s.id}`, `description=${EMPTY_COMMENT}`, `author=${COMMENTER}`, ...wsArg(s)]);
    }
  }

  const emptyIds = new Set(empty.map((s) => s.id));
  const unknown = [];
  const ready = candidates
    .filter((s) => !emptyIds.has(s.id))
    .map((s) => {
      const raw = s.priority_label || s.priority;
      if (!knownPriority(raw)) unknown.push(`${refOf(s.id)}「${String(raw).trim()}」`);
      return { id: s.id, ref: refOf(s.id), title: s.name || s.id, priority: priorityOf(raw) };
    })
    .sort((a, b) => a.priority - b.priority || byId(a, b));
  if (unknown.length) notes.push(`不认识的优先级按 2 处理：${unknown.join('、')}`);

  const blocked = empty
    .sort(byId)
    .map((s) => ({
      id: s.id,
      ref: refOf(s.id),
      reason: dryRun ? '需求为空（描述与评论都为空）' : `需求为空（描述与评论都为空），已贴 ${LABELS.failed} 并评论`
    }));

  for (const n of notes) process.stderr.write(`${n}\n`);
  emit({
    status: 'ok',
    say: [
      ready.length ? `就绪 ${ready.length} 张工单` : '没有就绪的工单',
      ...(blocked.length ? [`空壳 ${blocked.length} 张`] : []),
      ...notes
    ].join('，'),
    data: { ready, blocked }
  });
});
