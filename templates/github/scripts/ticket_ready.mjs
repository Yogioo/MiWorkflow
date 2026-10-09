// 工单源接口：列就绪工单。GitHub 实现：贴 ready 标签、没贴任何机器标签；依赖（正文 `- [ ] #N`）都满足（关单或贴 delivered）才算就绪，
// 否则进 blocked 并写明被哪张单挡住。就绪的按 P 优先级 → 工单号排序。标签取自 source.mjs 的 LABELS。
// 入：{ repo?, first?, claims? }
//     claims = 只列「贴了 afk-claimed 的单」（工人重启后收拾自己上次没收尾的单用，一条轻查询不查依赖）
// 出：{ status, say, data: { ready: [{ id, ref, title, priority }], blocked: [{ id, ref, reason }] } }，id 为字符串；
//     claims 模式出 { claimed: [{ id, ref, title }] }
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, hasLabel, priorityFromLabels, parseTaskList, refOf } from './_gh.mjs';
import { LABELS } from '../source.mjs';

const LIST_LIMIT = 1000;

await main(async () => {
  const args = await readStdin();
  const repoArg = args.repo ? ['--repo', args.repo] : [];

  // 认领中的单：一条按标签查的单，不用拉整条队列（也不查依赖）
  if (args.claims) {
    const raw = runGh(['issue', 'list', '--state', 'open', '--label', LABELS.claimed,
      '--limit', String(LIST_LIMIT), '--json', 'number,title,labels', ...repoArg]);
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('gh issue list 返回的不是数组');
    // 假 gh / 旧 gh 可能不按 --label 过滤，这里再过一遍
    const claimed = rows
      .filter((i) => hasLabel(i, LABELS.claimed))
      .map((i) => ({ id: String(i.number), ref: refOf(Number(i.number)), title: i.title || String(i.number) }))
      .sort((a, b) => Number(a.id) - Number(b.id));
    emit({
      status: 'ok',
      say: claimed.length ? `认领中 ${claimed.length} 张工单` : '没有认领中的工单',
      data: { claimed }
    });
    return;
  }

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
  const machine = [LABELS.claimed, LABELS.merging, LABELS.delivered, LABELS.failed];
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
