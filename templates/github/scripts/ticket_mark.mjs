// 工单源接口：改工单状态。GitHub 实现：认领（claimed）/ 完成关单（done）/ 未推送留人处理（unpushed）/ 失败待人看（failed）。
// 标签取自 source.mjs 的 LABELS；要贴的标签仓库里没有时先 `gh label create` 再贴，建不出来就明确报错。
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
  const add = (label) => ['issue', 'edit', n, '--add-label', label, ...repoArg];
  const remove = (label) => ['issue', 'edit', n, '--remove-label', label, ...repoArg];

  let plan;
  if (action === 'claimed') {
    plan = [add(LABELS.claimed)];
  } else if (action === 'done') {
    plan = [
      ['issue', 'comment', n, '--body', `提交：${args.sha || '(未记录)'}`, ...repoArg],
      ['issue', 'close', n, ...repoArg],
      add(LABELS.delivered),
      remove(LABELS.ready),
      remove(LABELS.claimed)
    ];
  } else if (action === 'unpushed') {
    // 本地提交了但没推出去：不关单、不动标签（保留 claimed 提醒人处理），只留一条评论
    plan = [
      ['issue', 'comment', n, '--body', `本地提交（未推送）：${args.sha || '(未记录)'}`, ...repoArg]
    ];
  } else if (action === 'failed') {
    plan = [
      ['issue', 'comment', n, '--body', `afk failed：${String(args.comment ?? '').slice(0, 900)}`, ...repoArg],
      add(LABELS.failed),
      remove(LABELS.claimed)
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
    const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
    const adding = at('--add-label');
    try {
      runGh(argv);
    } catch (err) {
      // 摘一个本来就没贴的标签时 gh 会报错；摘标签失败不算致命
      if (at('--remove-label')) {
        process.stderr.write(`（摘标签没成功，忽略：${err.message}）\n`);
        continue;
      }
      if (!adding) throw err;
      // 贴标签失败多半是仓库里还没这个标签：先建再贴一次
      try {
        runGh(['label', 'create', adding, '--description', 'MiWorkflow 机器标签', ...repoArg]);
      } catch (createErr) {
        throw new Error(`贴标签 ${adding} 失败（${err.message}），建标签也失败：${createErr.message}`);
      }
      runGh(argv);
    }
  }

  const label = { claimed: '认领', done: '完成关单', unpushed: '记录未推送', failed: '标记失败' }[action];
  emit({ status: 'ok', say: `${ref} ${label}`, data: { id: n, ref, did: desc } });
});
