// 工单源接口：改工单状态。GitHub 实现：认领（claimed）/ 完成关单（done）/ 未推送留人处理（unpushed）/ 失败待人看（failed）/
// Agent 连接失败释放（released：摘认领、不贴失败、保留 ready）。
// 标签取自 source.mjs 的 LABELS；要贴的标签仓库里没有时先 `gh label create` 再贴，建不出来就明确报错。
// 入：{ id, action, commentFile?, comment?, sha?, repo?, dryRun? }；commentFile 是回帖稿（failed 时跟在 comment 那句话后面发，
// 用 gh issue comment --body-file --attach 上传其中引用的本地图片，见文件末尾）
// 出：{ status, say, data: { id, ref, did: string[] } }，id 为字符串
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, issueNumber, refOf } from './_gh.mjs';
import { LABELS } from '../source.mjs';

const GH_ATTACH_MIN = [2, 99, 0];
const IMAGE_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const isLocal = (p) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(p);

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
  let reply = null;
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
    const head = `afk failed：${String(args.comment ?? '').slice(0, 900)}`;
    reply = args.commentFile ? readReply(args.commentFile, head) : null;
    plan = [
      reply
        ? ['issue', 'comment', n, '--body-file', reply.bodyFile, ...reply.attach.flatMap((p) => ['--attach', p]), ...repoArg]
        : ['issue', 'comment', n, '--body', head, ...repoArg],
      add(LABELS.failed),
      remove(LABELS.claimed)
    ];
  } else if (action === 'released') {
    // Agent 基础设施故障：摘认领、不贴失败、保留 ready，下轮自动重做
    plan = [
      ['issue', 'comment', n, '--body', releasedComment(args.comment), ...repoArg],
      remove(LABELS.claimed)
    ];
  } else {
    throw new Error(`不认识的 action：${action}（claimed / done / unpushed / failed / released）`);
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

  const label = { claimed: '认领', done: '完成关单', unpushed: '记录未推送', failed: '标记失败', released: '释放（下轮重做）' }[action];
  emit({ status: 'ok', say: `${ref} ${label}${reply?.warn ? `；${reply.warn}` : ''}`, data: { id: n, ref, did: desc } });
});

function releasedComment(comment) {
  return `Agent 连接失败，已回滚并释放，下轮重做：${String(comment ?? '').slice(0, 900)}`;
}

// 回帖稿：Agent 写的 Markdown，图片放同目录、用相对路径引用。没写（文件不在或是空的）就返回 null，退回一句话评论。
// 有本地图片才查 gh 版本；低于 GH_ATTACH_MIN（或图片不在）就把引用换成「（图片未上传：<路径>）」，评论照发。
// 评论正文 = 原来那句话 + 空行 + 回帖稿，写成回帖稿同目录的 <名>.comment.md 交给 --body-file。

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
  writeFileSync(bodyFile, `${head}\n\n${text}`);
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
