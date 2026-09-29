// 看 git 状态：当前 sha、工作区是否干净、相对某个 sha 改了哪些文件（信 git，不信 Agent 自报）。
// 入：{ cwd?, baseSha? }
// 出：{ status, say, data: { sha, root, clean, changed } }
import { main, readStdin, emit, git } from './_lib.mjs';

await main(async () => {
  const args = await readStdin();
  const dir = args.cwd ?? process.cwd();

  const sha = git(['rev-parse', 'HEAD'], dir).trim();
  const root = git(['rev-parse', '--show-toplevel'], dir).trim();
  const clean = git(['status', '--porcelain'], dir).trim() === '';

  let changed = [];
  if (args.baseSha) {
    const tracked = git(['diff', '--name-only', args.baseSha], dir).split('\n').filter(Boolean);
    const untracked = git(['ls-files', '--others', '--exclude-standard'], dir).split('\n').filter(Boolean);
    changed = [...new Set([...tracked, ...untracked])];
  }

  emit({
    status: 'ok',
    say: clean
      ? `工作区干净（${sha.slice(0, 7)}）`
      : `工作区有未提交改动（${sha.slice(0, 7)}）`,
    data: { sha, root, clean, changed }
  });
});
