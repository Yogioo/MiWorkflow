// 工单源接口：读一张讨论单，出规范形状（Core.md §15）。beads 实现：spec 与开发单清单在描述的机器区域里，
// AI 记账标记是评论末尾的 HTML 注释；这里把它们翻成规范形状（正文只留人写的、评论正文去掉标记）。
// 入：{ id }
// 出：{ status, say, data: { id, ref, title, body, spec, labels, comments: [{ id, author, at, text, ai, mark }] } }
import { main, readStdin, emit } from './_lib.mjs';
import { showIssue, listComments, labelsOf, issueId } from './_bd.mjs';
import { humanBodyOf, specOfBody, parseMark, stripMark } from './_discuss.mjs';
import { refOf } from '../source.mjs';

await main(async () => {
  const args = await readStdin();
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const issue = showIssue(issueId(args.id));
  const id = String(issue.id);

  emit({
    status: 'ok',
    say: `读 ${refOf(id)}：${issue.title ?? ''}`,
    data: {
      id,
      ref: refOf(id),
      title: issue.title ?? '',
      body: humanBodyOf(issue.description),
      spec: specOfBody(issue.description),
      labels: labelsOf(issue),
      comments: listComments(id).map((c) => {
        const mark = parseMark(c.text);
        return { id: c.id, author: c.author, at: c.at, text: stripMark(c.text), ai: mark !== null, mark };
      })
    }
  });
});
