// 工单源接口：写讨论单（beads 实现，Core.md §15）。
// 入：{ id, body?, mark?, spec?, setTickets?, addLabel?, removeLabel? }
//   body       → 发一条评论；mark（记账字段）渲染成评论末尾的 HTML 注释
//   spec       → 写进描述的 spec 区域（null = 删掉那一段）；人写的原文留在上面
//   setTickets → 写进描述的开发单区域（null = 删掉那一段）
//   addLabel / removeLabel → 贴 / 摘阶段标签（beads 的标签不用预建）
// 出：{ status, say, data: { did: string[] } }
import { main, readStdin, emit } from './_lib.mjs';
import { runBd, showIssue, issueId } from './_bd.mjs';
import { withRegions, renderMark, withTextFile, addComment } from './_discuss.mjs';
import { refOf } from '../source.mjs';

await main(async () => {
  const args = await readStdin();
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const id = issueId(args.id);
  const did = [];

  if (args.addLabel) {
    runBd(['label', 'add', id, args.addLabel]);
    did.push(`贴 ${args.addLabel}`);
  }
  if (args.removeLabel) {
    runBd(['label', 'remove', id, args.removeLabel]);
    did.push(`摘 ${args.removeLabel}`);
  }

  // 描述区域：要改才先读当前描述。spec / 清单之外的原文原样保留
  if (args.spec !== undefined || args.setTickets !== undefined) {
    const next = withRegions(showIssue(id).description ?? '', { spec: args.spec, tickets: args.setTickets });
    withTextFile(next, (file) => runBd(['update', id, '--body-file', file, ...(next.trim() ? [] : ['--allow-empty-description'])]));
    if (args.spec !== undefined) did.push(args.spec === null ? '去掉 spec 区域' : '写 spec 区域');
    if (args.setTickets !== undefined) did.push(args.setTickets === null ? '去掉开发单区域' : '写开发单区域');
  }

  if (args.body !== undefined) {
    addComment(id, [String(args.body).trim(), args.mark ? renderMark(args.mark) : null].filter(Boolean).join('\n\n'));
    did.push('发评论');
  }

  emit({ status: 'ok', say: `${refOf(id)}：${did.join('、') || '无事可做'}`, data: { did } });
});
