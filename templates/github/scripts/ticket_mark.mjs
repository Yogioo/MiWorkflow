// 工单源接口：改工单状态。GitHub 实现：认领（claimed）/ 完成关单（done）/ 未推送留人处理（unpushed）/ 失败待人看（failed）。
// 标签取自 source.mjs 的 LABELS。
// 入：{ id, action, comment?, sha?, repo?, dryRun? }
// 出：{ status, say, data: { id, ref, did: string[] } }，id 为字符串
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, issueNumber, refOf } from './_gh.mjs';
import { LABELS } from '../source.mjs';

await main(async () => {
  const args = await readStdin();
  const { action } = args;
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const number = issueNumber(args.id);
  const ref = refOf(number);
  const repoArg = args.repo ? ['--repo', args.repo] : [];
  const n = String(number);

  let plan;
  if (action === 'claimed') {
    plan = [
      ['issue', 'edit', n, '--add-label', LABELS.inProgress, ...repoArg]
    ];
  } else if (action === 'done') {
    plan = [
      ['issue', 'comment', n, '--body', `提交：${args.sha || '(未记录)'}`, ...repoArg],
      ['issue', 'close', n, ...repoArg],
      ['issue', 'edit', n, '--remove-label', LABELS.ready, ...repoArg],
      ['issue', 'edit', n, '--remove-label', LABELS.inProgress, ...repoArg]
    ];
  } else if (action === 'unpushed') {
    // 本地提交了但没推出去：不关单、不动标签（保留 in-progress 提醒人处理），只留一条评论
    plan = [
      ['issue', 'comment', n, '--body', `本地提交（未推送）：${args.sha || '(未记录)'}`, ...repoArg]
    ];
  } else if (action === 'failed') {
    plan = [
      ['issue', 'comment', n, '--body', `afk failed：${String(args.comment ?? '').slice(0, 900)}`, ...repoArg],
      ['issue', 'edit', n, '--add-label', LABELS.failed, ...repoArg],
      ['issue', 'edit', n, '--remove-label', LABELS.inProgress, ...repoArg]
    ];
  } else {
    throw new Error(`不认识的 action：${action}（claimed / done / unpushed / failed）`);
  }

  const desc = plan.map((a) => a.join(' '));
  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会执行 ${desc.length} 条 gh（${action} ${ref}）`, data: { id: n, ref, did: desc } });
    return;
  }

  for (const argv of plan) {
    // 摘一个本来就没贴的标签时 gh 会报错；摘标签失败不算致命，其它失败照样抛
    const removing = argv.includes('--remove-label');
    try {
      runGh(argv);
    } catch (err) {
      if (!removing) throw err;
      process.stderr.write(`（摘标签没成功，忽略：${err.message}）\n`);
    }
  }

  const label = { claimed: '认领', done: '完成关单', unpushed: '记录未推送', failed: '标记失败' }[action];
  emit({ status: 'ok', say: `${ref} ${label}`, data: { id: n, ref, did: desc } });
});
