// 改 issue 状态：认领（claimed）/ 完成关单（done）/ 失败待人看（failed）。
// 入：{ number, action, comment?, sha?, repo?, labels?: {...}, dryRun? }
// 出：{ status, say, data: { did: string[] } }
import { main, readStdin, emit, runGh } from './_lib.mjs';

await main(async () => {
  const args = await readStdin();
  const { number, action } = args;
  if (!number) throw new Error('缺 number');
  const repoArg = args.repo ? ['--repo', args.repo] : [];
  const ready = args.labels?.ready ?? 'ready-for-agent';
  const inProgress = args.labels?.inProgress ?? 'in-progress';
  const failed = args.labels?.failed ?? 'afk-failed';
  const n = String(number);

  let plan;
  if (action === 'claimed') {
    plan = [
      ['issue', 'edit', n, '--add-label', inProgress, ...repoArg]
    ];
  } else if (action === 'done') {
    plan = [
      ['issue', 'comment', n, '--body', `提交：${args.sha || '(未记录)'}`, ...repoArg],
      ['issue', 'close', n, ...repoArg],
      ['issue', 'edit', n, '--remove-label', ready, ...repoArg],
      ['issue', 'edit', n, '--remove-label', inProgress, ...repoArg]
    ];
  } else if (action === 'failed') {
    plan = [
      ['issue', 'comment', n, '--body', `afk failed：${String(args.comment ?? '').slice(0, 300)}`, ...repoArg],
      ['issue', 'edit', n, '--add-label', failed, ...repoArg],
      ['issue', 'edit', n, '--remove-label', inProgress, ...repoArg]
    ];
  } else {
    throw new Error(`不认识的 action：${action}（claimed / done / failed）`);
  }

  const desc = plan.map((a) => a.join(' '));
  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会执行 ${desc.length} 条 gh（${action} #${number}）`, data: { did: desc } });
    return;
  }

  for (const argv of plan) {
    // 摘一个本来就沒贴的标签时 gh 会报错；摘标签失败不算致命，其它失败照样抛
    const removing = argv.includes('--remove-label');
    try {
      runGh(argv);
    } catch (err) {
      if (!removing) throw err;
      process.stderr.write(`（摘标签没成功，忽略：${err.message}）\n`);
    }
  }

  const label = { claimed: '认领', done: '完成关单', failed: '标记失败' }[action];
  emit({ status: 'ok', say: `#${number} ${label}`, data: { did: desc } });
});
