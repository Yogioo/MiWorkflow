// 工单源接口：列要处理的讨论单（GitHub 实现）。
// 打开、贴了进入标签，且没有阶段标签（discuss:*）或阶段是 grilling / spec；按工单号升序。
// 入：{ enter, grilling, spec, repo? }
// 出：{ status, say, data: { items: [{ id, ref, title, labels }] } }
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, labelName, refOf } from './_gh.mjs';

await main(async () => {
  const args = await readStdin();
  const enter = args.enter ?? 'agent-discuss';
  const phasesOk = new Set([args.grilling ?? 'discuss:grilling', args.spec ?? 'discuss:spec'].map((l) => l.toLowerCase()));
  const repoArg = args.repo ? ['--repo', args.repo] : [];

  const raw = runGh([
    'issue', 'list', '--state', 'open', '--label', enter,
    '--json', 'number,title,labels', '--limit', '200', ...repoArg
  ]);
  const items = JSON.parse(raw)
    .map((i) => ({ id: String(i.number), ref: refOf(i.number), title: i.title ?? '', labels: (i.labels ?? []).map(labelName) }))
    .filter((i) => i.labels.some((l) => l.toLowerCase() === enter.toLowerCase()))
    .filter((i) => i.labels.filter((l) => /^discuss:/i.test(l)).every((l) => phasesOk.has(l.toLowerCase())))
    .sort((a, b) => Number(a.id) - Number(b.id));

  emit({
    status: 'ok',
    say: items.length ? `讨论单 ${items.length} 张：${items.map((i) => i.ref).join('、')}` : '没有讨论单',
    data: { items }
  });
});
