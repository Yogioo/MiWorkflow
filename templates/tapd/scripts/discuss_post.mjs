// 工单源接口：写讨论单（TAPD 实现，Core.md §15）。
// 入：{ id, body?, mark?, spec?, setTickets?, addLabel?, removeLabel? }
//   body       → 发一条评论；mark（记账字段）渲染成评论末尾的一行纯文本标记
//   spec       → 发一条带 kind=spec 标记的评论（TAPD 不写需求描述：描述写入不幂等，见 TODO F4.1）；
//                「当前 spec」= 最新那条 kind=spec 的评论
//   setTickets → 忽略：TAPD 的需求树里子需求列表本身就能看进度，不用再写一份
//   addLabel / removeLabel → 改阶段标签（TAPD 写标签用 | 分隔，写完回读校验）
// 出：{ status, say, data: { did: string[] } }
import { main, readStdin, emit } from './_lib.mjs';
import { labelsOf } from './_tapd.mjs';
import { addComment, storyOf, writeLabels } from './_discuss.mjs';
import { refOf } from '../source.mjs';

await main(async () => {
  const args = await readStdin();
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('缺 id');
  const story = storyOf(id);
  const ws = String(story.workspace_id || '');
  const did = [];

  if (args.addLabel || args.removeLabel) {
    const next = [...labelsOf(story).filter((l) => l !== args.removeLabel), ...(args.addLabel ? [args.addLabel] : [])];
    writeLabels(story, next);
    if (args.addLabel) did.push(`贴 ${args.addLabel}`);
    if (args.removeLabel) did.push(`摘 ${args.removeLabel}`);
  }

  // spec 评论在前、回复评论在后：判轮认的是「最后一条 AI 评论」记下的哈希
  if (args.spec !== undefined && args.spec !== null) {
    addComment(ws, id, String(args.spec), { ...args.mark, kind: 'spec' });
    did.push('写 spec 评论');
  }
  if (args.body !== undefined) {
    addComment(ws, id, String(args.body), args.mark);
    did.push('发评论');
  }

  emit({ status: 'ok', say: `${refOf(id)}：${did.join('、') || '无事可做'}`, data: { did } });
});
