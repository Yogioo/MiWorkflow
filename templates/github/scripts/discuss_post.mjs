// 工单源接口：写讨论单（GitHub 实现，Core.md §15）。
// 入：{ id, body?, mark?, spec?, setTickets?, addLabel?, removeLabel?, repo? }
//   body       → 发一条评论；mark（记账字段）渲染成评论末尾的 HTML 注释
//   spec       → 写进正文的 spec 区域（null = 删掉那一段）；人写的原文留在上面
//   setTickets → 写进正文的开发单区域（null = 删掉那一段）
//   addLabel / removeLabel → 贴 / 摘阶段标签；仓库里没有这个标签就先建
// 出：{ status, say, data: { did: string[] } }
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, runGhWithLabels, issueNumber, refOf, withRegions, renderMark } from './_gh.mjs';

await main(async () => {
  const args = await readStdin();
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const number = issueNumber(args.id);
  const ref = refOf(number);
  const n = String(number);
  const repoArg = args.repo ? ['--repo', args.repo] : [];
  const did = [];

  if (args.addLabel) {
    runGhWithLabels(['issue', 'edit', n, '--add-label', args.addLabel, ...repoArg]);
    did.push(`贴 ${args.addLabel}`);
  }
  if (args.removeLabel) {
    runGh(['issue', 'edit', n, '--remove-label', args.removeLabel, ...repoArg]);
    did.push(`摘 ${args.removeLabel}`);
  }

  // 正文区域：要改才先读当前正文。spec / 清单之外的原文原样保留
  if (args.spec !== undefined || args.setTickets !== undefined) {
    const cur = JSON.parse(runGh(['issue', 'view', n, '--json', 'body', ...repoArg])).body ?? '';
    const next = withRegions(cur, { spec: args.spec, tickets: args.setTickets });
    runGh(['issue', 'edit', n, '--body', next, ...repoArg]);
    if (args.spec !== undefined) did.push(args.spec === null ? '去掉 spec 区域' : '写 spec 区域');
    if (args.setTickets !== undefined) did.push(args.setTickets === null ? '去掉开发单区域' : '写开发单区域');
  }

  if (args.body !== undefined) {
    const text = [String(args.body).trim(), args.mark ? renderMark(args.mark) : null].filter(Boolean).join('\n\n');
    runGh(['issue', 'comment', n, '--body', text, ...repoArg]);
    did.push('发评论');
  }

  emit({ status: 'ok', say: `${ref}：${did.join('、') || '无事可做'}`, data: { did } });
});
