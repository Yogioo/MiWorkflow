// 把工作区恢复到某个 sha：reset --hard + clean -fd。
// 但 reset --hard 会把 <sha> 之后的**所有**提交一起丢掉——包括不属于本轮、人提交的（2026-09-29 实遇，TODO B7）。
// 所以回滚前先把要丢掉的提交存成一个 ref：仓库回到起点，提交一根没丢，人按 ref 就能捞回来。
// refs/ 是仓库里的东西，clean -fd 不碰；找回：`git log <备份 ref>` 或 `git show <备份 ref>`。
// logs/ 被 .workflow/.gitignore 忽略，clean -fd 也不碰它。
// diffFile：回滚前把 <sha> 到工作区的全部改动（含 Agent 的提交、新建的文件）存成一份 patch，给后来的人 / Agent 参考；没改动就不写。
// 入：{ sha, cwd?, prefix?, diffFile?, dryRun? }
// 出：{ status, say, data: { sha, backup, lost, diff } }（diff：写了就是 diffFile，没写是 null）
import { mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { main, readStdin, emit, git } from './_lib.mjs';

await main(async () => {
  const args = await readStdin();
  if (!args.sha) throw new Error('缺 sha');
  const dir = args.cwd ?? process.cwd();

  const base = git(['rev-parse', args.sha], dir).trim();
  const head = git(['rev-parse', 'HEAD'], dir).trim();
  const lost = head === base
    ? []
    : git(['log', '--format=%h %s', `${base}..${head}`], dir).split('\n').filter(Boolean);

  if (args.dryRun) {
    emit({
      status: 'ok',
      say: `干跑：会回滚到 ${base.slice(0, 7)}${lost.length ? `（要丢 ${lost.length} 笔提交，会先备份）` : ''}`,
      data: { sha: base, backup: null, lost, diff: null }
    });
    return;
  }

  let diff = null;
  if (args.diffFile) {
    const file = path.resolve(dir, args.diffFile);
    mkdirSync(path.dirname(file), { recursive: true });
    git(['add', '-A', '-N'], dir); // 新建的文件也进 diff；随后 reset --hard 会把暂存区一起复原
    git(['diff', '--binary', `--output=${file}`, base], dir); // 直接落盘，大 diff 不过 stdout 缓冲
    if (statSync(file).size > 0) diff = file;
    else rmSync(file);
  }

  let backup = null;
  if (lost.length) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15); // 20260929T134846
    backup = `refs/${args.prefix ?? 'afk-backup'}/${stamp}-${head.slice(0, 7)}`;
    git(['update-ref', backup, head], dir);
  }

  git(['reset', '--hard', base], dir);
  git(['clean', '-fd'], dir);

  emit({
    status: 'ok',
    say: lost.length
      ? `已回滚到 ${base.slice(0, 7)}；回滚掉的 ${lost.length} 笔提交备份在 ${backup}`
      : `已回滚到 ${base.slice(0, 7)}`,
    data: { sha: base, backup, lost, diff }
  });
});
