// 工单源接口：列就绪工单。beads 实现：状态 open、贴 ready 标签、没贴任何机器标签；
// 依赖（blocks 类前置）与子单都做完（已关单或贴 delivered）才算就绪，否则进 blocked 并写明被谁挡住。
// 就绪的按优先级（0 最急）→ 工单号排序。标签取自 source.mjs 的 LABELS。
// 入：{}；{ claims: true } = 只列「贴了 afk-claimed 的单」（工人重启后收拾自己上次没收尾的单用，一条轻查询 + 每张读评论）
// 出：{ status, say, data: { ready: [{ id, ref, title, priority }], blocked: [{ id, ref, reason }] } }，id 为字符串；
//     claims 模式出 { claimed: [{ id, ref, title, claim }] }，claim 同 ticket_view 的有效接单人（没有为 null）
import { main, readStdin, emit } from './_lib.mjs';
import { bdJson, hasLabel, priorityOf, blockersOf, parentOf, listComments } from './_bd.mjs';
import { claimWorker } from './_claim.mjs';
import { LABELS, refOf } from '../source.mjs';

const byId = (a, b) => a.id.localeCompare(b.id, 'en', { numeric: true });

await main(async () => {
  const args = await readStdin();

  // 认领中的单：一条按标签查的单，不拉整条队列（也不查依赖与子单）
  if (args.claims) {
    const rows = bdJson(['list', '--limit', '0', '--label', LABELS.claimed]) ?? [];
    if (!Array.isArray(rows)) throw new Error('bd list 返回的不是数组');
    const claimed = rows
      .filter((i) => i?.id && hasLabel(i, LABELS.claimed))
      .map((i) => ({
        id: String(i.id), ref: refOf(String(i.id)), title: i.title || String(i.id),
        claim: claimWorker(listComments(String(i.id)).map((c) => c.text))
      }))
      .sort(byId);
    emit({
      status: 'ok',
      say: claimed.length ? `认领中 ${claimed.length} 张工单` : '没有认领中的工单',
      data: { claimed }
    });
    return;
  }

  const parsed = bdJson(['list', '--limit', '0']) ?? [];
  if (!Array.isArray(parsed)) throw new Error('bd list 返回的不是数组');
  const issues = parsed.filter((i) => i?.id).map((i) => ({ ...i, id: String(i.id), title: i.title || String(i.id) }));

  // bd list 只列没关的单：前置不在里面就是关了；在里面但贴了 delivered 也算做完
  const open = new Map(issues.map((i) => [i.id, i]));
  const pending = (id) => open.has(id) && !hasLabel(open.get(id), LABELS.delivered);
  const children = new Map();
  for (const i of issues) {
    const p = parentOf(i);
    if (p) children.set(p, [...(children.get(p) ?? []), i.id]);
  }

  const machine = [LABELS.claimed, LABELS.merging, LABELS.delivered, LABELS.failed];
  const queued = issues
    .filter((i) => i.status === 'open' && hasLabel(i, LABELS.ready) && !machine.some((l) => hasLabel(i, l)))
    .map((i) => ({
      ...i,
      waiting: blockersOf(i).filter(pending),
      kids: (children.get(i.id) ?? []).filter(pending)
    }));

  const ready = queued
    .filter((i) => !i.waiting.length && !i.kids.length)
    .sort((a, b) => priorityOf(a) - priorityOf(b) || byId(a, b))
    .map((i) => ({ id: i.id, ref: refOf(i.id), title: i.title, priority: priorityOf(i) }));
  const blocked = queued
    .filter((i) => i.waiting.length || i.kids.length)
    .sort(byId)
    .map((i) => ({
      id: i.id,
      ref: refOf(i.id),
      reason: [
        i.waiting.length ? `被 ${i.waiting.map(refOf).join('、')} 挡住（未完成）` : '',
        i.kids.length ? `还有子单没做完：${i.kids.map(refOf).join('、')}` : ''
      ].filter(Boolean).join('；')
    }));

  emit({
    status: 'ok',
    say: [
      ready.length ? `就绪 ${ready.length} 张工单` : '没有就绪的工单',
      ...(blocked.length ? [`被挡住 ${blocked.length} 张`] : [])
    ].join('，'),
    data: { ready, blocked }
  });
});
