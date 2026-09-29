// 提交 + 推送。提交失败和推送失败分开报：推送失败时本地提交保留（data.committed=true, pushed=false），
// 任务据此「不关单、整轮停下，留给人处理」。
//
// 「工作区已经干净」不当失败（2026-09-29 实遇，TODO B7）：那说明 Agent 自己先提交了。
// 这一轮的目标是「有提交、且推出去」，不是「提交必须由我造」——硬要提交只会 `nothing to commit` 退出码 1，
// 把一个已经做完的 issue 判成 commit_failed。所以：没东西可提交就跳过提交，直接用当前 HEAD 走推送。
// 入：{ message, body?, push?, cwd?, dryRun? }
// 出：{ status, say, data: { committed, pushed, sha, already } }
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
  const already = git(['diff', '--cached', '--name-only'], dir).trim() === '';
  if (!already) {
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
    say: already
      ? `没有新改动要提交（已有人提交过，HEAD ${sha.slice(0, 7)}）${args.push ? '，直接推送' : ''}`
      : `已提交 ${sha.slice(0, 7)}${args.push ? ' 并推送' : ''}`,
    data: { committed: true, pushed: Boolean(args.push), sha, already }
  });
});
