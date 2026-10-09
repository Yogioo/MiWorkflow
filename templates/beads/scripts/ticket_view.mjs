// 工单源接口：读一张工单，写成工单快照（标题、描述、设计 / 验收标准 / 备注、全部评论的 Markdown）。beads 实现。
// beads 是本地库，正文里的图片不下载，链接原样留着。
// 入：{ id }
// 出：{ status, say, data: { id, ref, title, file, review, labels, claim } }，id 为字符串，file 是快照路径，review 是「要不要审查」，
// labels 是这张单上的标签，claim 是当前有效接单人（评论里还有效的接单标记，没有就是 null；见 scripts/_claim.mjs）。
// 快照放 logs/<runId>/tickets/<id>/ticket.md：被 .gitignore 忽略、回滚不删、跑完可复盘。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { main, readStdin, emit } from './_lib.mjs';
import { showIssue, listComments, hasLabel, issueId, labelsOf } from './_bd.mjs';
import { claimWorker } from './_claim.mjs';
import { LABELS, refOf } from '../source.mjs';

const SECTIONS = [['design', '设计'], ['acceptance_criteria', '验收标准'], ['notes', '备注']];

await main(async () => {
  const args = await readStdin();
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const issue = showIssue(issueId(args.id));
  const comments = listComments(issue.id);
  const id = String(issue.id);
  const ref = refOf(id);
  const title = issue.title || id;

  const home = path.resolve(process.env.AGENTFLOW_HOME || process.cwd());
  const dir = path.join(home, 'logs', process.env.AGENTFLOW_RUN_ID || randomUUID(), 'tickets', id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const text = (v) => String(v ?? '').trim();
  const md = [
    `# ${ref} ${title}`,
    '',
    text(issue.description),
    ...SECTIONS.filter(([k]) => text(issue[k])).map(([k, name]) => `\n## ${name}\n\n${text(issue[k])}`),
    ...comments.map((c) => `\n---\n\n## @${c.author} 评论（${c.at}）\n\n${c.text}`),
    ''
  ].join('\n');
  const file = path.join(dir, 'ticket.md');
  writeFileSync(file, md);

  emit({
    status: 'ok',
    say: `读工单 ${ref}：${title}${comments.length ? `（评论 ${comments.length} 条）` : ''}`,
    data: {
      id,
      ref,
      title,
      file,
      review: hasLabel(issue, LABELS.review),
      labels: labelsOf(issue),
      claim: claimWorker(comments.map((c) => c.text))
    }
  });
});
