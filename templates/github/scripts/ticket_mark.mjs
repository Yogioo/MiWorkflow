// 工单源接口：改工单状态。GitHub 实现：认领（claimed）/ 完成关单（done）/ 未推送留人处理（unpushed）/ 失败待人看（failed）/
// Agent 连接失败释放（released：摘认领、不贴失败、保留 ready）/ 等合并（merging：工人在工位里交了单子分支，
// 摘认领、贴 afk-merging、不关单——不算交付，依赖它的单仍被挡住）/ 合并失败退回队列（requeued：摘 afk-merging、贴回 ready）。
// 标签取自 source.mjs 的 LABELS；要贴的标签仓库里没有时先 `gh label create` 再贴，建不出来就明确报错。
// 评论正文由调用方给整段：comment 在前、commentFile（回帖稿）在后，原样发；两样都没给才用 DEFAULT_COMMENT 的一句话。
// 每段评论开头贴一个状态标记（[miworkflow:done] 等），工单源靠它判定「有效接单」（见 _claim.mjs）。
// 回帖稿用 gh issue comment --body-file --attach 上传其中引用的本地图片（见文件末尾）。
// 认领不是原子操作（贴标签幂等），claimed 走「校验 → 抢接单锁 → 锁里再校验 → 发接单评论 + 贴标签」，抢输的什么都不写：
// 出参 claimed:false + reason，调用方接着挑下一张。
// 入：{ id, action, commentFile?, comment?, sha?, worker?, cwd?, repo?, dryRun? }
// 出：{ status, say, data: { id, ref, did } }（认领没抢到：data 是 { id, ref, claimed: false, reason }），id 为字符串
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, issueNumber, refOf, viewIssue } from './_gh.mjs';
import { claimComment, claimWorker, defaultWorker, machineLabels, projectDirOf, stampComment, withClaimLock } from './_claim.mjs';
import { LABELS } from '../source.mjs';

const GH_ATTACH_MIN = [2, 99, 0];
const IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const isLocal = (p) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(p);

const DEFAULT_COMMENT = {
  done: (a) => `提交：${a.sha || '(未记录)'}`,
  unpushed: (a) => `本地提交（未推送）：${a.sha || '(未记录)'}`,
  failed: () => 'afk failed',
  released: () => 'Agent 连接失败，已回滚并释放，下轮重做',
  requeued: () => '合并失败，已回到合并前并退回就绪队列，工人在最新主分支上重做',
  merging: (a) => `提交 ${a.sha || '(未记录)'} 在本地分支 ${a.branch || '(未记录)'}，等合并`
};

await main(async () => {
  const args = await readStdin();
  const { action } = args;
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const number = issueNumber(args.id);
  const ref = refOf(number);
  const repoArg = args.repo ? ['--repo', args.repo] : [];
  const n = String(number);
  // 工人名（认领评论里带）：调用方（dev）按 config.mjs 传进来，单独手动跑就用缺省
  const worker = String(args.worker ?? '').trim() || defaultWorker(projectDirOf(args.cwd));
  const add = (label) => ['issue', 'edit', n, '--add-label', label, ...repoArg];
  const remove = (label) => ['issue', 'edit', n, '--remove-label', label, ...repoArg];

  if (!['claimed', ...Object.keys(DEFAULT_COMMENT)].includes(action)) {
    throw new Error(`不认识的 action：${action}（claimed / done / unpushed / failed / released / merging / requeued）`);
  }
  let reply = null;
  let comment = null;
  if (action !== 'claimed') {
    // 一段话（comment）在，就有；回帖稿在，就有；两样都空才用 DEFAULT_COMMENT 的一句话——标记都贴在最前面
    const plain = String(args.comment ?? '').trim();
    reply = args.commentFile ? readReply(args.commentFile, stampComment(action, plain)) : null;
    comment = reply
      ? ['issue', 'comment', n, '--body-file', reply.bodyFile, ...reply.attach.flatMap((p) => ['--attach', p]), ...repoArg]
      : ['issue', 'comment', n, '--body', stampComment(action, plain || DEFAULT_COMMENT[action](args)), ...repoArg];
  }

  // 接单：先发接单评论、再贴 afk-claimed（中间挂了也还认得出是谁接的）
  const plan = {
    claimed: () => [['issue', 'comment', n, '--body', claimComment(worker), ...repoArg], add(LABELS.claimed)],
    done: () => [comment, ['issue', 'close', n, ...repoArg], add(LABELS.delivered), remove(LABELS.ready), remove(LABELS.claimed), remove(LABELS.merging)],
    // 本地提交了但没推出去：不关单、不动标签（保留 claimed 提醒人处理），只留一条评论
    unpushed: () => [comment],
    failed: () => [comment, add(LABELS.failed), remove(LABELS.claimed), remove(LABELS.merging)],
    // Agent 基础设施故障：摘认领、不贴失败、保留 ready，下轮自动重做
    released: () => [comment, remove(LABELS.claimed)],
    // 工位交单：摘认领、贴等合并，不关单——不算交付
    merging: () => [comment, remove(LABELS.claimed), add(LABELS.merging)],
    // 合并失败：摘等合并、贴回 ready，工人在最新主分支上重做
    requeued: () => [comment, remove(LABELS.merging), add(LABELS.ready)]
  }[action]();

  const desc = plan.map((a) => a.join(' '));
  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会执行 ${desc.length} 条 gh（${action} ${ref}）`, data: { id: n, ref, did: desc } });
    return;
  }

  if (action === 'claimed') {
    // 校验 → 抢接单锁 → 锁里再校验；抢输 / 校验不过都不碰工单，交回 claimed:false
    const first = refuse();
    if (first) {
      lost(first);
      return;
    }
    const locked = await withClaimLock({ cwd: projectDirOf(args.cwd), ref, worker }, () => {
      const why = refuse();
      if (why) return { why };
      runPlan(plan);
      return {};
    });
    if (!locked.ok) {
      lost(`接单锁在 ${locked.holder} 手里`);
      return;
    }
    if (locked.result.why) {
      lost(locked.result.why);
      return;
    }
  } else {
    runPlan(plan);
  }

  const label = { claimed: `接单（${worker}）`, done: '完成关单', unpushed: '记录未推送', failed: '标记失败', released: '释放（下轮重做）', merging: '标记等合并', requeued: '退回就绪队列' }[action];
  emit({ status: 'ok', say: `${ref} ${label}${reply?.warn ? `；${reply.warn}` : ''}`, data: { id: n, ref, did: desc } });

  // 校验：没有任何机器标签，也没有还有效的接单评论
  function refuse() {
    const issue = viewIssue(number, repoArg);
    // 先看接单评论（谁接的报得出来），再看机器标签
    const holder = claimWorker(issue.comments.map((c) => c.body));
    if (holder) return holder === worker ? `已经是我（${worker}）接的单` : `已被 ${holder} 接走`;
    const machine = machineLabels(issue.labels);
    if (machine.length) return `已经贴了 ${machine.join('、')}`;
    return null;
  }

  // 没抢到：工单上什么都没写
  function lost(why) {
    emit({ status: 'ok', say: `${ref} 没接单：${why}`, data: { id: n, ref, claimed: false, reason: why } });
  }

  function runPlan(plan) {
    for (const argv of plan) {
      const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
      const adding = at('--add-label');
      try {
        // --attach 的相对路径按回帖稿目录解析，gh 才会把正文里同写法的引用原地换成上传后的地址
        runGh(argv, argv.includes('--body-file') ? { cwd: reply.dir } : {});
      } catch (err) {
        // 摘一个本来就没贴的标签时 gh 会报错；摘标签失败不算致命
        if (at('--remove-label')) {
          process.stderr.write(`（摘标签没成功，忽略：${err.message}）\n`);
          continue;
        }
        // 工单系统故障（重试已用完）不是缺标签，别再去建
        if (!adding || err.transient) throw err;
        // 贴标签失败多半是仓库里还没这个标签：先建再贴一次
        try {
          runGh(['label', 'create', adding, '--description', 'MiWorkflow 机器标签', ...repoArg]);
        } catch (createErr) {
          const e = new Error(`贴标签 ${adding} 失败（${err.message}），建标签也失败：${createErr.message}`);
          if (createErr.transient) e.transient = true;
          throw e;
        }
        runGh(argv);
      }
    }
  }
});

// 回帖稿：Markdown，图片放同目录、用相对路径引用。没写（文件不在或是空的）就返回 null，只发 comment 那段话。
// 有本地图片才查 gh 版本；低于 GH_ATTACH_MIN（或图片不在）就把引用换成「（图片未上传：<路径>）」，评论照发。
// 评论正文 = comment 那段话（有的话）+ 空行 + 回帖稿，写成回帖稿同目录的 <名>.comment.md 交给 --body-file。

function readReply(file, head) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  if (!text.trim()) return null;
  const dir = path.dirname(path.resolve(file));

  const refs = [...text.matchAll(IMAGE_RE)].map((m) => m[1] ?? m[2]).filter(isLocal);
  let attach = [];
  let warn = '';
  if (refs.length) {
    const version = ghVersion();
    const okVersion = version && compare(version, GH_ATTACH_MIN) >= 0;
    const missing = new Set(refs.filter((p) => !existsSync(path.resolve(dir, p))));
    const dropped = new Set(okVersion ? missing : refs);
    attach = [...new Set(refs.filter((p) => !dropped.has(p)))];
    if (dropped.size) {
      text = text.replace(IMAGE_RE, (m, a, b) => (dropped.has(a ?? b) ? `（图片未上传：${a ?? b}）` : m));
    }
    if (!okVersion) warn = `gh ${version ? version.join('.') : '版本未知'} 不支持 --attach（要 ≥ ${GH_ATTACH_MIN.join('.')}），图片未上传，请升级 gh`;
    else if (missing.size) warn = `回帖稿引用的图片不存在，未上传：${[...missing].join('、')}`;
  }

  const bodyFile = path.join(dir, `${path.basename(file, path.extname(file))}.comment.md`);
  writeFileSync(bodyFile, [head, text].filter(Boolean).join('\n\n'));
  return { dir, bodyFile, attach, warn };
}

function ghVersion() {
  try {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(runGh(['--version'], { retries: 0 }));
    return m ? m.slice(1).map(Number) : null;
  } catch { return null; }
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
