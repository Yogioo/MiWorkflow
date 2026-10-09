// 提交 + 推送。提交失败和推送失败分开报：推送失败时本地提交保留（data.committed=true, pushed=false），
// 任务据此「不关单、整轮停下，留给人处理」。
//
// 提交权在工作流：给了 baseSha 时这一轮只留一笔提交——base 之后 Agent 自己做的提交先 `reset --soft` 回 base，
// 连同工作区改动按 message 重新提交成一笔；没有改动可提交判失败（Agent 报完成却什么都没改）。
// 走正常 git commit，项目的 pre-commit 等钩子照跑、不绕过。提交后回读：标题必须与 message 逐字一致、
// 不许带 AI 署名（钩子或全局配置加进来的 Co-authored-by / Made-with 等），不合规判失败（committed=false），交给调用方回滚。
//
// 不给 baseSha（旧用法）：工作区已经干净不当失败，直接用当前 HEAD 走推送（2026-09-29 实遇，TODO B7）。
// 给 branch（工位用法）：提交后把这一笔挂到本地单子分支上（同名分支直接覆盖），交给 merge 合入；推不推由 push 单独决定。
// 入：{ message, body?, push?, cwd?, baseSha?, branch?, dryRun? }
// 出：{ status, say, data: { committed, pushed, sha, already, squashed } }
import { main, readStdin, emit, git } from './_lib.mjs';

const AI_TRAILER = /^(?:Co-authored-by|Made-with|Generated-by|Generated-with)\s*:.*$/im;

await main(async () => {
  const args = await readStdin();
  if (!args.message) throw new Error('缺 message');
  if (/[\r\n]/.test(args.message)) throw new Error('message 只能是一行（正文放 body）');
  const dir = args.cwd ?? process.cwd();

  if (args.dryRun) {
    emit({
      status: 'ok',
      say: `干跑：会提交「${args.message}」${args.push ? ' 并推送' : ''}`,
      data: { committed: false, pushed: false, sha: null }
    });
    return;
  }

  let squashed = 0;
  if (args.baseSha) {
    const base = git(['rev-parse', args.baseSha], dir).trim();
    if (git(['rev-parse', 'HEAD'], dir).trim() !== base) {
      squashed = Number(git(['rev-list', '--count', `${base}..HEAD`], dir).trim()) || 0;
      git(['reset', '--soft', base], dir);
    }
  }

  git(['add', '-A'], dir);
  const already = git(['diff', '--cached', '--name-only'], dir).trim() === '';
  if (already && args.baseSha) {
    emit({
      status: 'failed',
      say: '没有改动可提交',
      error: 'nothing_to_commit: 相对起点没有任何改动',
      data: { committed: false, pushed: false, sha: null }
    });
    return;
  }
  if (!already) {
    try {
      git(['commit', '-m', args.message, ...(args.body ? ['-m', args.body] : [])], dir);
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

  if (!already) {
    const full = git(['log', '-1', '--format=%B'], dir);
    const subject = full.split('\n')[0].trim();
    const problems = [];
    if (subject !== args.message.trim()) problems.push(`标题被改成了「${subject}」`);
    const sig = AI_TRAILER.exec(full);
    if (sig) problems.push(`带了 AI 署名「${sig[0].trim()}」`);
    if (problems.length) {
      emit({
        status: 'failed',
        say: `提交 ${sha.slice(0, 7)} 不合规`,
        error: `commit_rejected: ${problems.join('；')}（多半是 git 钩子或全局配置加的，查 prepare-commit-msg / commit-msg 钩子与 commit.template）`,
        data: { committed: false, pushed: false, sha, rejected: true }
      });
      return;
    }
  }

  // 单子分支：工位做完把这一笔交出去（一张单一个分支，各自从最新主分支拉出；上次没合成留下的同名分支直接覆盖）
  if (args.branch) git(['branch', '-f', args.branch, sha], dir);

  if (args.push) {
    try {
      git(['push'], dir);
    } catch (err) {
      emit({
        status: 'failed',
        say: `已本地提交 ${sha.slice(0, 7)}，但推送失败，留给人处理`,
        error: `push_failed: ${err.message}`,
        data: { committed: true, pushed: false, sha, squashed }
      });
      return;
    }
  }

  emit({
    status: 'ok',
    say: already
      ? `没有新改动要提交（已有人提交过，HEAD ${sha.slice(0, 7)}）${args.push ? '，直接推送' : ''}`
      : `已提交 ${sha.slice(0, 7)}${squashed ? `（压掉 Agent 自己的 ${squashed} 笔）` : ''}${args.push ? ' 并推送' : ''}`,
    data: { committed: true, pushed: Boolean(args.push), sha, already, squashed }
  });
});
