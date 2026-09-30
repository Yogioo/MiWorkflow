// 工单源接口：读一张工单（正文 + 全部评论拼成给 Agent 看的文本）。GitHub 实现。
// 入：{ id, repo? }
// 出：{ status, say, data: { id, ref, title, text } }，id 为字符串
import { main, readStdin, emit } from './_lib.mjs';
import { viewIssue, issueNumber, refOf } from './_gh.mjs';

await main(async () => {
  const args = await readStdin();
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const issue = viewIssue(issueNumber(args.id), args.repo ? ['--repo', args.repo] : []);
  const ref = refOf(issue.number);
  emit({
    status: 'ok',
    say: `读工单 ${ref}：${issue.title}`,
    data: { id: String(issue.number), ref, title: issue.title, text: issue.text }
  });
});
