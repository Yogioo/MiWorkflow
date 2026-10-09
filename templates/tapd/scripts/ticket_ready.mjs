// 工单源接口：列就绪工单。TAPD 实现：只接需求（story），缺陷不处理；入队只看标签——贴了 ready、没贴任何机器标签，不要求处理人。
// 一次 `story list label=<ready>` 拿全部候选（个人令牌每天有配额，别逐个拉）；就绪的按优先级 → 工单号排序。
// 空壳需求（描述与评论都为空）不进 ready：进 blocked，并贴 failed 标签 + 评论请人补充（干跑只进 blocked、不改 TAPD）。
// 只对描述为空的候选走 OpenAPI 读评论（`tapd-cli comment list` 会剥 HTML，只有图片的评论会被当成空）。
// 前后置依赖：只对非空壳的候选调 OpenAPI `stories/get_time_relative_stories`；同一轮里同一个前置只查一次。
// 给了 first 就按优先级 → 工单号扫到第一张可做的为止（dev 只用第一张，不为后面整条队列付钱）；不给就全扫。
// 前置贴了 delivered 或到了结束类状态（见 source.mjs 的 END_STATUSES）才算满足；未满足进 blocked，reason 指出前置。
// 前置不认识（缺陷、别的项目、已删除、接口查不到）一律当挡住，reason 写明，由人解开。依赖挡住的不改 TAPD。
// 入：{ dryRun?, first?, claims? }；AGENTFLOW_DRY_RUN=1 也算干跑
//     first = 只要第一张可做的（按优先级扫到就停）；不给 = 全扫（干跑、人看全貌用）
//     claims = 只列「贴了 afk-claimed 的需求」（工人重启后收拾自己上次没收尾的单用）：一条按标签的列表，
//              每张再读一次评论认出有效接单人（不拉描述、不下图片，比逐张 ticket_view 省得多）
// 出：{ status, say, data: { ready: [...], blocked: [...] } }，id 为字符串；
//     claims 模式出 { claimed: [{ id, ref, title, claim }] }，claim 同 ticket_view 的有效接单人（没有为 null）
import { main, readStdin, emit } from './_lib.mjs';
import { tapdJson, openApi, commentsOf } from './_tapd.mjs';
import { claimWorker } from './_claim.mjs';
import { WORKSPACE_ID, COMMENTER, LABELS, END_STATUSES, priorityOf, knownPriority, refOf } from '../source.mjs';

// TAPD 单页上限 200；满页说明可能还有，提示一句而不是逐页拉
const LIST_LIMIT = 200;
const EMPTY_COMMENT = `需求为空，请补充描述后摘掉 ${LABELS.failed}`;

const labelsOf = (s) => String(s.label ?? '').split('|').map((l) => l.trim()).filter(Boolean);
const blank = (html) => !/<img\b/i.test(String(html ?? '')) &&
  !String(html ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').trim();
const byId = (a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const ws = (s) => String(s.workspace_id || WORKSPACE_ID || '');
const wsArg = (s) => (ws(s) ? [`workspace_id=${ws(s)}`] : []);
const errText = (err) => String(err?.message ?? err);

// 结束类状态：每个项目一轮只取一次。出 Set（状态键与中文名都放进去）
const endCache = new Map();
const kvOf = (data) => {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (x && typeof x === 'object') walk(x);
        else if (x != null && String(x).trim()) out.push([k, String(x).trim()]);
      }
    }
  };
  walk(data);
  return out;
};
function endStatuses(w) {
  if (!endCache.has(w)) {
    endCache.set(w, (async () => {
      try {
        const r = await openApi('/workflows/last_steps', { query: { workspace_id: w || undefined, system: 'story' } });
        const kv = kvOf(r.data);
        if (kv.length) return new Set(kv.flat());
      } catch { /* 取不到就退回 END_STATUSES */ }
      const set = new Set(END_STATUSES);
      try {
        const r = await openApi('/workflows/status_map', { query: { workspace_id: w || undefined, system: 'story' } });
        for (const [k, name] of kvOf(r.data)) if (END_STATUSES.includes(name)) set.add(k);
      } catch { /* 翻不成中文名就直接拿 status 比 */ }
      return set;
    })());
  }
  return endCache.get(w);
}

// get_time_relative_stories 的真实返回（2026-09-30 真项目实测，见 TODO F4 Step 0）：
//   data: [{ WorkitemTimeRelation: { id, workspace_id, workitem_type, workitem_id,
//            src_field, dst_workspace_id, dst_workitem_type, dst_workitem_id, dst_field,
//            relation_type, lag_time } }]
// 可能包一层（测试的假接口用 { TimeRelation: … }）；本单是 dst 的那些行，workitem_id 就是前置，
// 前置所在项目是 workspace_id（不是 src_workspace_id）。
const unwrap = (row) => {
  const vals = row && typeof row === 'object' ? Object.values(row) : [];
  return vals.length === 1 && vals[0] && typeof vals[0] === 'object' && !Array.isArray(vals[0]) ? vals[0] : row;
};
function predecessorsOf(data, id) {
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data).flat() : [];
  const out = [];
  for (const r of rows.map(unwrap)) {
    if (!r || typeof r !== 'object' || String(r.dst_workitem_id ?? '').trim() !== id) continue;
    const pred = String(r.workitem_id ?? '').trim();
    if (!pred) continue;
    const type = String(r.workitem_type ?? r.src_workitem_type ?? r.entity_type ?? '').trim();
    const w = String(r.workspace_id ?? r.src_workspace_id ?? '').trim();
    out.push({ id: pred, type, workspace: w });
  }
  return out;
}

// 前置满不满足：同一轮里同一个前置只查一次。出 null（满足）或未满足的原因
const predCache = new Map();
function checkPredecessor(p, w) {
  const key = `${w}:${p.id}`;
  if (!predCache.has(key)) {
    predCache.set(key, (async () => {
      const ref = refOf(p.id);
      if (p.type && !/^stor(y|ies)$/i.test(p.type)) return `前置 ${p.id} 不是需求（${p.type}）`;
      if (p.workspace && w && p.workspace !== w) return `前置 ${ref} 在别的项目（${p.workspace}）`;
      let s;
      try {
        const r = await openApi('/stories', { query: { workspace_id: w || undefined, id: p.id } });
        s = (Array.isArray(r.data) ? r.data : []).map((x) => x?.Story).find((x) => x && String(x.id).trim() === p.id);
      } catch (err) {
        return `前置 ${ref} 查询失败：${errText(err)}`;
      }
      if (!s) return `前置 ${ref} 查不到（缺陷、别的项目或已删除）`;
      if (labelsOf(s).includes(LABELS.delivered)) return null;
      const status = String(s.status ?? '').trim();
      if ((await endStatuses(w)).has(status) || (s.v_status && (await endStatuses(w)).has(String(s.v_status).trim()))) return null;
      return `前置 ${ref}「${s.name || p.id}」未完成（状态 ${s.v_status || status || '空'}，未贴 ${LABELS.delivered}）`;
    })());
  }
  return predCache.get(key);
}

// 出 null（依赖都满足）或挡住的原因
async function dependencyBlock(s) {
  const w = ws(s);
  let preds;
  try {
    const r = await openApi('/stories/get_time_relative_stories', { query: { workspace_id: w || undefined, story_id: s.id } });
    preds = predecessorsOf(r.data, s.id);
  } catch (err) {
    return `查前后置依赖失败，当作挡住：${errText(err)}`;
  }
  const reasons = [];
  for (const p of preds) {
    const why = await checkPredecessor(p, w);
    if (why) reasons.push(why);
  }
  return reasons.length ? `依赖未满足：${reasons.join('；')}` : null;
}

await main(async () => {
  const args = await readStdin();

  // 认领中的需求：一条按标签查的单，不用拉整条队列（也不查依赖与空壳）；接单人只看评论
  if (args.claims) {
    const listed = tapdJson(['story', 'list', `label=${LABELS.claimed}`, `limit=${LIST_LIMIT}`,
      ...(WORKSPACE_ID ? [`workspace_id=${WORKSPACE_ID}`] : [])]);
    const stories = (Array.isArray(listed.data) ? listed.data : [])
      .map((r) => r?.Story)
      .filter((s) => s && labelsOf(s).includes(LABELS.claimed))
      .map((s) => ({ ...s, id: String(s.id).trim() }))
      .sort(byId);
    const claimed = [];
    for (const s of stories) {
      const comments = await commentsOf(ws(s), s.id);
      claimed.push({ id: s.id, ref: refOf(s.id), title: String(s.name || s.id), claim: claimWorker(comments.map((c) => c.description)) });
    }
    emit({
      status: 'ok',
      say: claimed.length ? `认领中 ${claimed.length} 张工单` : '没有认领中的工单',
      data: { claimed }
    });
    return;
  }

  const dryRun = Boolean(args.dryRun) || process.env.AGENTFLOW_DRY_RUN === '1';
  const notes = [];

  const listed = tapdJson([
    'story', 'list', `label=${LABELS.ready}`, `limit=${LIST_LIMIT}`,
    ...(WORKSPACE_ID ? [`workspace_id=${WORKSPACE_ID}`] : [])
  ]);
  const rows = Array.isArray(listed.data) ? listed.data : [];
  if (rows.length >= LIST_LIMIT) notes.push(`候选满 ${LIST_LIMIT} 条，可能没列全`);

  const machine = [LABELS.claimed, LABELS.merging, LABELS.delivered, LABELS.failed];
  // 先按优先级 → 工单号排：懒扫描（first）要按这个顺序扫，扫到的第一张就是 dev 会挑的那张
  const candidates = rows
    .map((r) => r?.Story)
    .filter((s) => s && s.id != null && String(s.id).trim())
    .map((s) => ({ ...s, id: String(s.id).trim(), labels: labelsOf(s) }))
    .filter((s) => s.labels.includes(LABELS.ready) && !machine.some((l) => s.labels.includes(l)))
    .sort((a, b) => priorityOf(a.priority_label || a.priority) - priorityOf(b.priority_label || b.priority) || byId(a, b));

  // 逐个候选看：描述空的要先读评论才知道是不是空壳（只有图片的评论不算空）；不空的直接查依赖。
  // first：拿到第一张可做的就停，后面的候选一张都不看（也不查依赖）。
  const first = Boolean(args.first);
  const empty = [];
  const depBlocked = [];
  const passed = [];
  let scanned = 0;
  for (const s of candidates) {
    scanned++;
    if (blank(s.description)) {
      const r = await openApi('/comments', { query: { workspace_id: ws(s) || undefined, entry_type: 'stories', entry_id: s.id } });
      const comments = (Array.isArray(r.data) ? r.data : []).map((c) => c?.Comment?.description);
      if (comments.every(blank)) { empty.push(s); continue; }
    }
    const why = await dependencyBlock(s);
    if (why) depBlocked.push({ id: s.id, ref: refOf(s.id), reason: why });
    else {
      passed.push(s);
      if (first) break;
    }
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

  const rest = candidates.length - scanned;      // 懒扫描没看的候选数（全扫时为 0）
  const unknown = [];
  const ready = passed
    .map((s) => {
      const raw = s.priority_label || s.priority;
      if (!knownPriority(raw)) unknown.push(`${refOf(s.id)}「${String(raw).trim()}」`);
      return { id: s.id, ref: refOf(s.id), title: s.name || s.id, priority: priorityOf(raw) };
    })
    .sort((a, b) => a.priority - b.priority || byId(a, b));
  if (unknown.length) notes.push(`不认识的优先级按 2 处理：${unknown.join('、')}`);

  const blocked = [
    ...empty.map((s) => ({
      id: s.id,
      ref: refOf(s.id),
      reason: dryRun ? '需求为空（描述与评论都为空）' : `需求为空（描述与评论都为空），已贴 ${LABELS.failed} 并评论`
    })),
    ...depBlocked
  ].sort(byId);

  for (const n of notes) process.stderr.write(`${n}\n`);
  emit({
    status: 'ok',
    say: [
      ready.length ? `就绪 ${ready.length} 张工单` : '没有就绪的工单',
      ...(empty.length ? [`空壳 ${empty.length} 张`] : []),
      ...(depBlocked.length ? [`依赖挡住 ${depBlocked.length} 张`] : []),
      ...(rest > 0 ? [`后面还有 ${rest} 张没看`] : []),
      ...notes
    ].join('，'),
    data: { ready, blocked }
  });
});
