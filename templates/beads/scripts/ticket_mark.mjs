// 工单源接口：改工单状态。beads 实现：认领（claimed）/ 完成关单（done）/ 未推送留人处理（unpushed）/ 失败待人看（failed）/
// Agent 连接失败释放（released：摘认领、不贴失败、保留 ready）。标签取自 source.mjs 的 LABELS；
// 状态跟着标签走：认领改 in_progress，失败 / 释放改回 open，完成 bd close。
// 评论正文由调用方给整段：comment 在前、commentFile（回帖稿）在后，原样发；两样都没给才用 DEFAULT_COMMENT 的一句话。
// 每段评论开头贴一个状态标记（[miworkflow:done] 等），工单源靠它判定「有效接单」（见 _claim.mjs）。
// beads 没有附件：回帖稿里引用的本地图片换成绝对路径，人在本机点得开。评论一律写成文件经 `bd comments add -f` 发。
// 认领不是原子操作（贴标签再改状态），claimed 走「校验 → 抢接单锁 → 锁里再校验 → 发接单评论 + 贴标签改状态」，抢输的什么都不写。
// 入：{ id, action, commentFile?, comment?, sha?, worker?, cwd?, dryRun? }
// 出：{ status, say, data: { id, ref, did } }（认领没抢到：data 是 { id, ref, claimed: false, reason }），id 为字符串
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, readStdin, emit } from './_lib.mjs';
import { runBd, issueId, labelsOf, showIssue, listComments } from './_bd.mjs';
import { claimComment, claimWorker, defaultWorker, machineLabels, projectDirOf, stampComment, withClaimLock } from './_claim.mjs';
import { LABELS, refOf } from '../source.mjs';

const IMAGE_RE = /(!\[[^\]]*\]\(\s*<?)([^)\s>]+)(>?(?:\s+"[^"]*")?\s*\))|(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)(["'][^>]*>)/gi;
const isLocal = (p) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(p) && !path.isAbsolute(p);

const DEFAULT_COMMENT = {
  done: (a) => `提交：${a.sha || '(未记录)'}`,
  unpushed: (a) => `本地提交（未推送）：${a.sha || '(未记录)'}`,
  failed: () => 'afk failed',
  released: () => 'Agent 连接失败，已回滚并释放，下轮重做'
};

await main(async () => {
  const args = await readStdin();
  const { action } = args;
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const id = issueId(args.id);
  const ref = refOf(id);
  if (!['claimed', ...Object.keys(DEFAULT_COMMENT)].includes(action)) {
    throw new Error(`不认识的 action：${action}（claimed / done / unpushed / failed / released）`);
  }
  // 工人名（接单评论里带）：调用方（dev）按 config.mjs 传进来，单独手动跑就用缺省
  const worker = String(args.worker ?? '').trim() || defaultWorker(projectDirOf(args.cwd));

  let body = null;
  if (action === 'claimed') {
    // 先发接单评论、再贴标签改状态（中间挂了也还认得出是谁接的）
    body = claimComment(worker);
  } else {
    // 一段话（comment）在，就有；回帖稿在，就有；两样都空才用 DEFAULT_COMMENT 的一句话——标记都贴在最前面
    const plain = String(args.comment ?? '').trim();
    const reply = args.commentFile ? readReply(args.commentFile) : '';
    body = [stampComment(action, plain || (reply ? '' : DEFAULT_COMMENT[action](args))), reply].filter(Boolean).join('\n\n');
  }

  const add = (label) => ['label', 'add', id, label];
  const remove = (label) => ['label', 'remove', id, label];
  const status = (s) => ['update', id, '--status', s];
  const COMMENT = ['comments', 'add', id, '-f', '<评论>'];
  const plan = {
    claimed: () => [COMMENT, add(LABELS.claimed), status('in_progress')],
    done: () => [COMMENT, add(LABELS.delivered), remove(LABELS.ready), remove(LABELS.claimed),
      ['close', id, '--reason', `afk 已交付：${args.sha || '(未记录提交)'}`]],
    // 本地提交了但没推出去：不关单、不动标签（保留 claimed 提醒人处理），只留一条评论
    unpushed: () => [COMMENT],
    failed: () => [COMMENT, add(LABELS.failed), remove(LABELS.claimed), status('open')],
    // Agent 基础设施故障：摘认领、不贴失败、保留 ready，下轮自动重做
    released: () => [COMMENT, remove(LABELS.claimed), status('open')]
  }[action]();

  const desc = plan.map((a) => `bd ${a.join(' ')}`);
  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会执行 ${desc.length} 条 bd（${action} ${ref}）`, data: { id, ref, did: desc } });
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

  const label = { claimed: `接单（${worker}）`, done: '完成关单', unpushed: '记录未推送', failed: '标记失败', released: '释放（下轮重做）' }[action];
  emit({ status: 'ok', say: `${ref} ${label}`, data: { id, ref, did: desc } });

  // 校验：没有任何机器标签，也没有还有效的接单评论
  function refuse() {
    // 先看接单评论（谁接的报得出来），再看机器标签
    const holder = claimWorker(listComments(id).map((c) => c.text));
    if (holder) return holder === worker ? `已经是我（${worker}）接的单` : `已被 ${holder} 接走`;
    const machine = machineLabels(labelsOf(showIssue(id)));
    if (machine.length) return `已经贴了 ${machine.join('、')}`;
    return null;
  }

  // 没抢到：工单上什么都没写
  function lost(why) {
    emit({ status: 'ok', say: `${ref} 没接单：${why}`, data: { id, ref, claimed: false, reason: why } });
  }

  function runPlan(plan) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-bd-'));
    try {
      for (const argv of plan) {
        if (argv === COMMENT) {
          const file = path.join(tmp, 'comment.md');
          writeFileSync(file, body);
          runBd(['comments', 'add', id, '-f', file]);
          continue;
        }
        try {
          runBd(argv);
        } catch (err) {
          // 摘标签失败不算致命（bd 摘没贴的标签本来不报错，这里兜底别的意外）
          if (argv[0] === 'label' && argv[1] === 'remove' && !err.transient) {
            process.stderr.write(`（摘标签没成功，忽略：${err.message}）\n`);
            continue;
          }
          throw err;
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

// 回帖稿：Markdown，图片放同目录、用相对路径引用。没写（文件不在或是空的）就返回空串，只发 comment 那段话。
function readReply(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  if (!text.trim()) return '';
  const dir = path.dirname(path.resolve(file));
  return text.trim().replace(IMAGE_RE, (m, mdHead, mdSrc, mdTail, imgHead, imgSrc, imgTail) => {
    const src = mdSrc ?? imgSrc;
    if (!isLocal(src)) return m;
    const abs = path.resolve(dir, src).split(path.sep).join('/');
    return mdSrc !== undefined ? `${mdHead}${abs}${mdTail}` : `${imgHead}${abs}${imgTail}`;
  });
}
