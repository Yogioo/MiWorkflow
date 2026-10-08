// 工单源接口：改工单状态。beads 实现：认领（claimed）/ 完成关单（done）/ 未推送留人处理（unpushed）/ 失败待人看（failed）/
// Agent 连接失败释放（released：摘认领、不贴失败、保留 ready）。标签取自 source.mjs 的 LABELS；
// 状态跟着标签走：认领改 in_progress，失败 / 释放改回 open，完成 bd close。
// 评论正文由调用方给整段：comment 在前、commentFile（回帖稿）在后，原样发；两样都没给才用 DEFAULT_COMMENT 的一句话。
// beads 没有附件：回帖稿里引用的本地图片换成绝对路径，人在本机点得开。评论一律写成文件经 `bd comments add -f` 发。claimed 不发评论。
// 入：{ id, action, commentFile?, comment?, sha?, dryRun? }
// 出：{ status, say, data: { id, ref, did: string[] } }，id 为字符串
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, readStdin, emit } from './_lib.mjs';
import { runBd, issueId } from './_bd.mjs';
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

  let body = null;
  if (action !== 'claimed') {
    const head = String(args.comment ?? '').trim();
    const reply = args.commentFile ? readReply(args.commentFile) : '';
    body = [head, reply].filter(Boolean).join('\n\n') || DEFAULT_COMMENT[action](args);
  }

  const add = (label) => ['label', 'add', id, label];
  const remove = (label) => ['label', 'remove', id, label];
  const status = (s) => ['update', id, '--status', s];
  const COMMENT = ['comments', 'add', id, '-f', '<评论>'];
  const plan = {
    claimed: () => [add(LABELS.claimed), status('in_progress')],
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

  const tmp = body === null ? null : mkdtempSync(path.join(os.tmpdir(), 'miworkflow-bd-'));
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
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  const label = { claimed: '认领', done: '完成关单', unpushed: '记录未推送', failed: '标记失败', released: '释放（下轮重做）' }[action];
  emit({ status: 'ok', say: `${ref} ${label}`, data: { id, ref, did: desc } });
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
