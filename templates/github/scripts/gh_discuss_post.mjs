// 讨论单的写操作：贴标签、发评论（都可选，按顺序做）。
// 入：{ number, addLabel?, body?, repo? }
// 出：{ status, say, data: { did: string[] } }
import { main, readStdin, emit, runGh } from './_lib.mjs';

await main(async () => {
  const args = await readStdin();
  if (!args.number) throw new Error('缺 number');
  const repoArg = args.repo ? ['--repo', args.repo] : [];
  const n = String(args.number);
  const did = [];

  if (args.addLabel) {
    runGh(['issue', 'edit', n, '--add-label', args.addLabel, ...repoArg]);
    did.push(`贴 ${args.addLabel}`);
  }
  if (args.body) {
    runGh(['issue', 'comment', n, '--body', String(args.body), ...repoArg]);
    did.push('发评论');
  }

  emit({ status: 'ok', say: `#${n}：${did.join('、') || '无事可做'}`, data: { did } });
});
