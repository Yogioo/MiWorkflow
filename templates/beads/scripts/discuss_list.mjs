// 工单源接口：列要处理的讨论单（beads 实现）。
// 没关、贴了进入标签，且没有阶段标签（discuss:*）或阶段是 grilling / spec；按工单号升序。
// 本地库没有调用额度，不做增量（不交 cursor、不标 changed），任务每张都读。
// 入：{ enter, grilling, spec }
// 出：{ status, say, data: { items: [{ id, ref, title, labels }] } }
import { main, readStdin, emit } from './_lib.mjs';
import { bdJson, labelsOf } from './_bd.mjs';
import { refOf } from '../source.mjs';

await main(async () => {
  const args = await readStdin();
  const enter = args.enter ?? 'agent-discuss';
  const phasesOk = new Set([args.grilling ?? 'discuss:grilling', args.spec ?? 'discuss:spec'].map((l) => l.toLowerCase()));

  const rows = bdJson(['list', '--label', enter, '--limit', '0']) ?? [];
  if (!Array.isArray(rows)) throw new Error('bd list 返回的不是数组');
  const items = rows
    .filter((i) => i?.id && i.status !== 'closed')
    .map((i) => ({ id: String(i.id), ref: refOf(i.id), title: i.title ?? '', labels: labelsOf(i) }))
    .filter((i) => i.labels.some((l) => l.toLowerCase() === enter.toLowerCase()))
    .filter((i) => i.labels.filter((l) => /^discuss:/i.test(l)).every((l) => phasesOk.has(l.toLowerCase())))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  emit({
    status: 'ok',
    say: items.length ? `讨论单 ${items.length} 张：${items.map((i) => i.ref).join('、')}` : '没有讨论单',
    data: { items }
  });
});
