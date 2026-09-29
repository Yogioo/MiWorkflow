// 把工作区恢复到某个 sha：reset --hard + clean -fd。
// logs/ 被 .workflow/.gitignore 忽略，clean -fd 不碰它。
// 入：{ sha, cwd?, dryRun? }
import { main, readStdin, emit, git } from './_lib.mjs';

await main(async () => {
  const args = await readStdin();
  if (!args.sha) throw new Error('缺 sha');
  const dir = args.cwd ?? process.cwd();

  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会回滚到 ${args.sha.slice(0, 7)}`, data: { sha: args.sha } });
    return;
  }

  git(['reset', '--hard', args.sha], dir);
  git(['clean', '-fd'], dir);
  emit({ status: 'ok', say: `已回滚到 ${args.sha.slice(0, 7)}`, data: { sha: args.sha } });
});
