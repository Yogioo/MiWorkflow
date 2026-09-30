// 工单源接口：列就绪工单。GitHub 实现：贴 ready 标签、没贴任何机器标签；依赖（正文 `- [ ] #N`）都满足（关单或贴 delivered）才算就绪，
// 否则进 blocked 并写明被哪张单挡住。就绪的按 P 优先级 → 工单号排序。标签取自 source.mjs 的 LABELS。
// 入：{ repo? }
// 出：{ status, say, data: { ready: [{ id, ref, title, priority }], blocked: [{ id, ref, reason }] } }，id 为字符串
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, hasLabel, priorityFromLabels, parseTaskList, refOf } from './_gh.mjs';
import { LABELS } from '../source.mjs';

const LIST_LIMIT = 1000;

await main(async () => {
  const args = await readStdin();
  const repoArg = args.repo ? ['--repo', args.repo] : [];

  const raw = runGh([
    'issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT),
    '--json', 'number,title,body,labels', ...repoArg
  ]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('gh issue list 返回的不是数组');

  const issues = parsed.map((i) => ({
    number: Number(i.number),
    title: i.title || String(i.number),
    body: i.body || '',
    labels: Array.isArray(i.labels) ? i.labels : []
  })).filter((i) => Number.isSafeInteger(i.number) && i.number > 0);

  // 依赖满足 = 勾上了，或那张单已经不在打开列表里（关了），或贴了 delivered
  const pending = new Set(issues.filter((i) => !hasLabel(i, LABELS.delivered)).map((i) => i.number));
  const machine = [LABELS.claimed, LABELS.delivered, LABELS.failed];
  const queued = issues
    .filter((i) => hasLabel(i, LABELS.ready) && !machine.some((l) => hasLabel(i, l)))
    .map((i) => ({ ...i, waiting: parseTaskList(i.body).filter((r) => !r.checked && pending.has(r.number)) }));

  const ready = queued
    .filter((i) => !i.waiting.length)
    .sort((a, b) => priorityFromLabels(a.labels) - priorityFromLabels(b.labels) || a.number - b.number)
    .map((i) => ({ id: String(i.number), ref: refOf(i.number), title: i.title, priority: priorityFromLabels(i.labels) }));
  const blocked = queued
    .filter((i) => i.waiting.length)
    .sort((a, b) => a.number - b.number)
    .map((i) => ({
      id: String(i.number),
      ref: refOf(i.number),
      reason: `被 ${i.waiting.map((r) => refOf(r.number)).join('、')} 挡住（未完成）`
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
