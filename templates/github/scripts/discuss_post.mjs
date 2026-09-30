// 讨论单的写操作：改正文、贴 / 摘标签、发评论（都可选，按顺序做）。
// 入：{ number, setBody?, addLabel?, removeLabel?, body?, repo? }
// 出：{ status, say, data: { did: string[] } }
import { main, readStdin, emit } from './_lib.mjs';
import { runGh } from './_gh.mjs';

await main(async () => {
  const args = await readStdin();
  if (!args.number) throw new Error('缺 number');
  const repoArg = args.repo ? ['--repo', args.repo] : [];
  const n = String(args.number);
  const did = [];

  if (typeof args.setBody === 'string') {
    runGh(['issue', 'edit', n, '--body', args.setBody, ...repoArg]);
    did.push('改正文');
  }
  if (args.addLabel) {
    runGh(['issue', 'edit', n, '--add-label', args.addLabel, ...repoArg]);
    did.push(`贴 ${args.addLabel}`);
  }
  if (args.removeLabel) {
    runGh(['issue', 'edit', n, '--remove-label', args.removeLabel, ...repoArg]);
    did.push(`摘 ${args.removeLabel}`);
  }
  if (args.body) {
    runGh(['issue', 'comment', n, '--body', String(args.body), ...repoArg]);
    did.push('发评论');
  }

  emit({ status: 'ok', say: `#${n}：${did.join('、') || '无事可做'}`, data: { did } });
});
