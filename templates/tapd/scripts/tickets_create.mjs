// 工单源接口：建开发单（TAPD 实现，Core.md §15）。Agent 只交结构，这里建子需求 / 贴标签 / 写前后置依赖，再回查系统实际状态。
// 入：{ parentId, tickets: [{ key, title, body, priority, review, blockedBy: [key] }] }
// 出：{ status, say, data: { tickets: [{ key, id, ref, title }], problems: string[] } }
//     problems 非空 = 没建好（可能部分建出来了），不写清单、不改阶段，由人处理。
// 依赖只能直连 OpenAPI `stories/save_time_relations` 写（tapd-cli 没封装，表单扁平写法），所以必须由脚本做（TODO F1/F4）。
import { main, readStdin, emit } from './_lib.mjs';
import { tapdJson } from './_tapd.mjs';
import { normalizeTickets, orderTickets, findCycle } from './_tickets.mjs';
import { childrenOf, predecessorsOf, saveRelations, storyOf } from './_discuss.mjs';
import { WORKSPACE_ID, COMMENTER, LABELS, refOf } from '../source.mjs';

// TAPD 的优先级只有 高 / 中 / 低 三档，P0 与 P1 会并成 高（dev 队列按这个排）
const PRIORITY_LABEL = { P0: '高', P1: '高', P2: '中', P3: '低', P4: '低' };
const CHILD_LIMIT = 200;

await main(async () => {
  const args = await readStdin();
  const parentId = String(args.parentId ?? '').trim();
  if (!parentId) throw new Error('缺 parentId');
  const parent = storyOf(parentId);
  const ws = String(parent.workspace_id || WORKSPACE_ID || '');

  const tickets = normalizeTickets(args.tickets);
  const { ordered, problems } = orderTickets(tickets);
  if (problems.length) {
    emit({ status: 'ok', say: `开发单结构有问题，没建：${problems.length} 个`, data: { tickets: [], problems } });
    return;
  }

  // 建单：先建被依赖的，拿到需求号再建依赖它的
  const made = new Map();
  for (const t of ordered) {
    const labels = [LABELS.ready, ...(t.review ? [LABELS.review] : [])];
    const r = tapdJson(['story', 'add', `workspace_id=${ws}`, `name=${t.title}`,
      `description=${t.body || '（Agent 没写正文）'}`, `parent_id=${parentId}`,
      `label=${labels.join('|')}`, `priority_label=${PRIORITY_LABEL[t.priority] ?? '中'}`]);
    const id = String(r.data?.Story?.id ?? '').trim();
    if (!id) throw new Error(`建开发单没拿到需求号：${t.title}`);
    made.set(t.key, id);
  }

  const edges = ordered.flatMap((t) => (t.blockedBy ?? [])
    .map((k) => made.get(k)).filter(Boolean)
    .map((from) => ({ from, to: made.get(t.key) })));
  await saveRelations(ws, edges, COMMENTER);

  // 回查系统实际状态（不信自己刚写的）
  const kids = childrenOf(parentId, ws);
  const check = [];
  if (!kids.length) check.push(`没找到挂在 ${refOf(parentId)} 下的子需求`);
  if (kids.length >= CHILD_LIMIT) check.push(`子需求满 ${CHILD_LIMIT} 条，可能没查全`);
  const ids = new Set(kids.map((k) => k.id));
  const deps = new Map();
  for (const k of kids) {
    if (!k.labels.includes(LABELS.ready)) check.push(`${refOf(k.id)} 没贴 ${LABELS.ready}`);
    let preds;
    try {
      preds = await predecessorsOf(ws, k.id);
    } catch (err) {
      check.push(`${refOf(k.id)} 查前后置依赖失败：${String(err?.message ?? err).split('\n')[0]}`);
      continue;
    }
    deps.set(k.id, preds);
    for (const p of preds) {
      if (p === parentId) check.push(`${refOf(k.id)} 依赖了讨论单 ${refOf(parentId)}，会永远不就绪`);
      else if (!ids.has(p)) check.push(`${refOf(k.id)} 依赖了不在这批里的需求 ${refOf(p)}`);
    }
  }
  const cycle = findCycle(deps);
  if (cycle) check.push(`开发单互相依赖成环：${cycle.map((n) => refOf(n)).join(' → ')}`);

  const out = tickets.map((t) => ({ key: t.key, id: made.get(t.key), ref: refOf(made.get(t.key)), title: t.title }));
  emit({
    status: 'ok',
    say: check.length
      ? `${refOf(parentId)} 建了 ${out.length} 张开发单，回查不通过：${check.length} 个问题`
      : `${refOf(parentId)} 建开发单 ${out.map((t) => t.ref).join('、')}`,
    data: { tickets: out, problems: check }
  });
});
