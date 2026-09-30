// 讨论流程读一个 issue：正文 + 全部评论（按时间，不截断），拼成一段给 Agent 看的文本。
// 入：{ number, repo? }
// 出：{ status, say, data: { number, title, body, comments, text, labels } }
import { main, readStdin, emit } from './_lib.mjs';
import { viewIssue } from './_gh.mjs';

await main(async () => {
  const args = await readStdin();
  if (!args.number) throw new Error('缺 number');
  const issue = viewIssue(args.number, args.repo ? ['--repo', args.repo] : []);
  emit({ status: 'ok', say: `读 issue #${issue.number}：${issue.title}`, data: issue });
});
