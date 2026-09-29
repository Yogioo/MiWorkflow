// 列出就绪的 issue：贴 ready 标签、没在跑、没失败、依赖都满足；按 P 优先级 + issue 号排序。
// 入：{ repo?, labels?: { ready, inProgress, failed } }
// 出：{ status, say, data: { issues: [{ number, title, priority }] } }
import { main, readStdin, emit, runGh, hasLabel, priorityFromLabels, parseTaskList } from './_lib.mjs';

const LIST_LIMIT = 1000;

await main(async () => {
  const args = await readStdin();
  const repoArg = args.repo ? ['--repo', args.repo] : [];
  const ready = args.labels?.ready ?? 'ready-for-agent';
  const inProgress = args.labels?.inProgress ?? 'in-progress';
  const failed = args.labels?.failed ?? 'afk-failed';

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

  const openSet = new Set(issues.map((i) => i.number));
  const list = issues
    .filter((i) => hasLabel(i, ready) && !hasLabel(i, failed) && !hasLabel(i, inProgress))
    .filter((i) => parseTaskList(i.body).every((r) => r.checked || !openSet.has(r.number)))
    .sort((a, b) => priorityFromLabels(a.labels) - priorityFromLabels(b.labels) || a.number - b.number)
    .map((i) => ({ number: i.number, title: i.title, priority: priorityFromLabels(i.labels) }));

  emit({
    status: 'ok',
    say: list.length ? `就绪 ${list.length} 个 issue` : '没有就绪的 issue',
    data: { issues: list }
  });
});
