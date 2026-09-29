// 提交 + 推送。提交失败和推送失败分开报：推送失败时本地提交保留（data.committed=true, pushed=false），
// 任务据此「不关单、整轮停下，留给人处理」。
// 入：{ message, body?, push?, cwd?, dryRun? }
// 出：{ status, say, data: { committed, pushed, sha } }
import { main, readStdin, emit, git } from './_lib.mjs';

await main(async () => {
  const args = await readStdin();
  if (!args.message) throw new Error('缺 message');
  const dir = args.cwd ?? process.cwd();

  if (args.dryRun) {
    emit({
      status: 'ok',
      say: `干跑：会提交「${args.message}」${args.push ? ' 并推送' : ''}`,
      data: { committed: false, pushed: false, sha: null }
    });
    return;
  }

  git(['add', '-A'], dir);
  try {
    git(['commit', '-m', args.message, '-m', args.body ?? ''], dir);
  } catch (err) {
    emit({
      status: 'failed',
      say: '提交失败',
      error: `commit_failed: ${err.message}`,
      data: { committed: false, pushed: false, sha: null }
    });
    return;
  }
  const sha = git(['rev-parse', 'HEAD'], dir).trim();

  if (args.push) {
    try {
      git(['push'], dir);
    } catch (err) {
      emit({
        status: 'failed',
        say: `已本地提交 ${sha.slice(0, 7)}，但推送失败，留给人处理`,
        error: `push_failed: ${err.message}`,
        data: { committed: true, pushed: false, sha }
      });
      return;
    }
  }

  emit({
    status: 'ok',
    say: `已提交 ${sha.slice(0, 7)}${args.push ? ' 并推送' : ''}`,
    data: { committed: true, pushed: Boolean(args.push), sha }
  });
});
