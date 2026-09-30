// 工单源接口：读一张讨论单，出规范形状（Core.md §15）。TAPD 实现。
// 正文 = 需求描述（HTML → Markdown）；spec 不在描述里（描述写入不幂等，见 TODO F4.1），
// 而是「最新一条带 kind=spec 标记的 AI 评论」；那条评论不出现在 comments 里（内容已经从 spec 给出）。
// AI 标记是评论末尾一行纯文本（TAPD 会剥掉 HTML 注释）。
// 入：{ id }
// 出：{ status, say, data: { id, ref, title, body, spec, labels, comments: [{ id, author, at, text, ai, mark }] } }
import { main, readStdin, emit } from './_lib.mjs';
import { commentsOf, labelsOf } from './_tapd.mjs';
import { md, parseMark, stripMark, storyOf } from './_discuss.mjs';
import { refOf } from '../source.mjs';

await main(async () => {
  const args = await readStdin();
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('缺 id');

  const story = storyOf(id);
  const ws = String(story.workspace_id || '');
  const comments = (await commentsOf(ws, id)).map((c) => {
    const text = md(c.description);
    const mark = parseMark(text);
    return {
      id: String(c.id ?? ''),
      author: c.author ?? '',
      at: c.created ?? '',
      text: stripMark(text),
      ai: mark !== null,
      mark: mark ? { hash: mark.hash, ...(mark.seen !== undefined ? { seen: mark.seen } : {}), ...(mark.cli ? { cli: mark.cli } : {}), ...(mark.session ? { session: mark.session } : {}), ...(mark.body ? { body: mark.body } : {}) } : null,
      kind: mark?.kind ?? null
    };
  });

  const specComment = comments.filter((c) => c.ai && c.kind === 'spec').at(-1) ?? null;

  emit({
    status: 'ok',
    say: `读 ${refOf(id)}：${story.name || id}`,
    data: {
      id,
      ref: refOf(id),
      title: story.name || id,
      body: md(story.description),
      spec: specComment ? specComment.text : null,
      labels: labelsOf(story),
      comments: comments.filter((c) => c.kind !== 'spec').map(({ kind, ...c }) => c)
    }
  });
});
