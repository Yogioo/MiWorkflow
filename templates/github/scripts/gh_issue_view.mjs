// 读一个 issue：正文 + 全部评论（按时间，不截断），拼成一段给 Agent 看的文本。
// 入：{ number, repo? }
// 出：{ status, say, data: { number, title, body, comments, text, labels } }
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, labelName, commentAuthor } from './_gh.mjs';

await main(async () => {
  const args = await readStdin();
  if (!args.number) throw new Error('缺 number');
  const repoArg = args.repo ? ['--repo', args.repo] : [];

  const raw = runGh([
    'issue', 'view', String(args.number),
    '--json', 'number,title,body,labels,comments', ...repoArg
  ]);
  const issue = JSON.parse(raw);

  const comments = (issue.comments ?? []).map((c) => ({
    author: commentAuthor(c),
    at: c.createdAt ?? '',
    body: c.body ?? ''
  }));

  // 人补充的说明、上次失败留下的评论，执行端都要能看到
  const text = [
    `# #${issue.number} ${issue.title}`,
    '',
    issue.body ?? '',
    ...comments.map((c) => `\n---\n@${c.author} 评论（${c.at}）：\n${c.body}`)
  ].join('\n');

  emit({
    status: 'ok',
    say: `读 issue #${issue.number}：${issue.title}`,
    data: {
      number: Number(issue.number),
      title: issue.title ?? '',
      body: issue.body ?? '',
      comments,
      text,
      labels: (issue.labels ?? []).map(labelName)
    }
  });
});
