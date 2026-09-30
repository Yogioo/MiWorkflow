// 列要处理的讨论单：打开、贴了进入标签，且没有阶段标签（discuss:*）或阶段是 grilling / spec。
// 入：{ enter, grilling, spec, repo? }
// 出：{ status, say, data: { issues: [{ number, title, labels }] } }，按 issue 号升序
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, labelName } from './_gh.mjs';

await main(async () => {
  const args = await readStdin();
  const enter = args.enter ?? 'agent-discuss';
  const grilling = args.grilling ?? 'discuss:grilling';
  const spec = args.spec ?? 'discuss:spec';
  const phasesOk = new Set([grilling, spec].map((l) => l.toLowerCase()));
  const repoArg = args.repo ? ['--repo', args.repo] : [];

  const raw = runGh([
    'issue', 'list', '--state', 'open', '--label', enter,
    '--json', 'number,title,labels', '--limit', '200', ...repoArg
  ]);
  const issues = JSON.parse(raw)
    .map((i) => ({ number: Number(i.number), title: i.title ?? '', labels: (i.labels ?? []).map(labelName) }))
    .filter((i) => i.labels.some((l) => l.toLowerCase() === enter.toLowerCase()))
    .filter((i) => {
      const phases = i.labels.filter((l) => /^discuss:/i.test(l));
      return phases.every((l) => phasesOk.has(l.toLowerCase()));
    })
    .sort((a, b) => a.number - b.number);

  emit({
    status: 'ok',
    say: issues.length ? `讨论单 ${issues.length} 张：${issues.map((i) => `#${i.number}`).join('、')}` : '没有讨论单',
    data: { issues }
  });
});
