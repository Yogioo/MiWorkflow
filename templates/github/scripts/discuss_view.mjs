// 工单源接口：读一张讨论单，出规范形状（Core.md §15）。GitHub 实现：spec 与开发单清单在正文的机器区域里，
// AI 记账标记是评论末尾的 HTML 注释；这里把它们翻成规范形状（正文只留人写的、评论正文去掉标记）。
// 入：{ id, repo? }
// 出：{ status, say, data: { id, ref, title, body, spec, labels, comments: [{ id, author, at, text, ai, mark }] } }
import { main, readStdin, emit } from './_lib.mjs';
import { viewIssue, issueNumber, refOf, stripMark, parseMark, humanBodyOf, specOfBody } from './_gh.mjs';

await main(async () => {
  const args = await readStdin();
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const number = issueNumber(args.id);
  const issue = viewIssue(number, args.repo ? ['--repo', args.repo] : []);

  emit({
    status: 'ok',
    say: `读 ${refOf(number)}：${issue.title}`,
    data: {
      id: String(number),
      ref: refOf(number),
      title: issue.title,
      body: humanBodyOf(issue.body),
      spec: specOfBody(issue.body),
      labels: issue.labels,
      comments: issue.comments.map((c) => {
        const mark = parseMark(c.body);
        return { id: c.id, author: c.author, at: c.at, text: stripMark(c.body), ai: mark !== null, mark };
      })
    }
  });
});
