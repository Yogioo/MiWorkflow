// 工单源接口：改工单状态。TAPD 实现：认领（claimed）/ 完成（done）/ 未推送留人处理（unpushed）/ 失败待人看（failed）/ 等合并（merging）。
// 「完成」不关单、不改状态和处理人（属于人和策划的流程）：撤 claimed 与 afk-merging、贴 delivered、评论提交号。
// failed 保留 ready（人摘掉 failed 就重新入队）；unpushed 只评论、保留 claimed；
// released（Agent 连接失败）撤 claimed、不贴 failed、保留 ready，下轮自动重做；
// merging（工人在工位里交了单子分支）摘 claimed、贴 afk-merging，不关单、不改状态——不算交付，依赖它的单仍被挡住；
// requeued（合并失败）摘 afk-merging、贴回 ready，工人在最新主分支上重做。
// 标签多值用 | 分隔（写逗号不报错，TAPD 会把整串建成一个新标签），每次写完经 `story list` 回读，不对就判失败。
// 要发评论却缺评论人时，在动标签之前就报错。
// 评论正文由调用方给整段：comment 在前、commentFile（回帖稿）在后，原样发；两样都没给才用 DEFAULT_COMMENT 的一句话。
// 每段评论开头贴一个状态标记（[miworkflow:done] 等），工单源靠它判定「有效接单」（见 _claim.mjs）。
// 回帖稿里引用的本地图片逐张 `attachment upload-image`，引用换成线上地址（见文件末尾）。
// 认领不是原子操作（读改写），claimed 走「校验 → 抢接单锁 → 锁里再校验 → 先发接单评论再改标签」，抢输的什么都不写。
// 入：{ id, action, commentFile?, comment?, sha?, worker?, cwd?, dryRun? }
// 出：{ status, say, data: { id, ref, did } }（认领没抢到：data 是 { id, ref, claimed: false, reason }），id 为字符串
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { main, readStdin, emit } from './_lib.mjs';
import { tapdJson, openApi } from './_tapd.mjs';
import { claimComment, claimWorker, defaultWorker, machineLabels, projectDirOf, stampComment, withClaimLock } from './_claim.mjs';
import { WORKSPACE_ID, COMMENTER, LABELS, refOf } from '../source.mjs';

const COMMENT_PAGE = 200;

const IMAGE_EXTS = new Set(['.png', '.gif', '.jpg', '.jpeg', '.bmp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const isLocal = (p) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(p);
const labelsOf = (s) => String(s?.label ?? '').split('|').map((l) => l.trim()).filter(Boolean);
const altOf = (tag) => (/\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '').replace(/[[\]]/g, '');

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
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('缺 id');
  const ref = refOf(id);

  let add = [];
  let remove = [];
  if (action === 'claimed') {
    add = [LABELS.claimed];
  } else if (action === 'done') {
    add = [LABELS.delivered];
    remove = [LABELS.claimed, LABELS.merging];
  } else if (action === 'unpushed') {
    // 只评论、保留 claimed
  } else if (action === 'failed') {
    add = [LABELS.failed];
    remove = [LABELS.claimed, LABELS.merging];
  } else if (action === 'released') {
    remove = [LABELS.claimed];
  } else if (action === 'merging') {
    // 工位交单：摘认领、贴等合并；不关单、状态不改（不算交付）
    add = [LABELS.merging];
    remove = [LABELS.claimed];
  } else if (action === 'requeued') {
    // 合并失败：摘等合并、贴回 ready；工人在最新主分支上重做
    add = [LABELS.ready];
    remove = [LABELS.merging];
  } else {
    throw new Error(`不认识的 action：${action}（claimed / done / unpushed / failed / released / merging / requeued）`);
  }
  const posts = action !== 'claimed';
  // 工人名（接单评论里带）：调用方（dev）按 config.mjs 传进来，单独手动跑就用缺省
  const worker = String(args.worker ?? '').trim() || defaultWorker(projectDirOf(args.cwd));
  // 认领也要发评论（就一行接单标记）；其余动作发状态标记 + 调用方给的整段
  const reply = args.commentFile ? readReply(args.commentFile) : null;
  const head = posts
    ? stampComment(action, String(args.comment ?? '').trim() || (reply ? '' : DEFAULT_COMMENT[action](args)))
    : claimComment(worker);  if (!COMMENTER && !args.dryRun) {
    throw new Error('缺评论人：设 TAPD_NPC_ROLE 或 source.mjs 的 COMMENTER（在改标签之前报错，工单未被改动）');
  }

  const before = readStory(id);
  const workspace = String(before.workspace_id || WORKSPACE_ID || '');
  const wsArg = workspace ? [`workspace_id=${workspace}`] : [];
  const current = labelsOf(before);
  // 目标标签：去掉要摘的、加上要贴的（锁里重读一遍也要用同一套算法）
  const nextLabels = (story) => {
    const cur = labelsOf(story);
    return [...cur.filter((l) => !remove.includes(l)), ...add.filter((l) => !cur.includes(l))];
  };
  const want = nextLabels(before);
  const changed = want.join('|') !== current.join('|');

  const did = [];
  if (changed) did.push(`story update id=${id} label=${want.join('|')}`);
  if (reply) for (const p of reply.refs) did.push(`attachment upload-image ${p}`);
  did.push(`comment add entry_id=${id}（${action === 'claimed' ? '接单标记' : [head && '一段话', reply && '回帖稿'].filter(Boolean).join(' + ')}）`);

  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会执行 ${did.length} 步（${action} ${ref}）`, data: { id, ref, did } });
    return;
  }

  // 校验：没有任何机器标签，也没有还有效的接单评论
  const refuse = async () => {
    // 先看接单评论（谁接的报得出来），再看机器标签
    const holder = claimWorker(await recentComments(workspace, id));
    if (holder) return holder === worker ? `已经是我（${worker}）接的单` : `已被 ${holder} 接走`;
    const machine = machineLabels(labelsOf(readStory(id)));
    if (machine.length) return `已经贴了 ${machine.join('、')}`;
    return null;
  };

  // 没抢到 / 校验不过：工单上什么都没写
  const lost = (why) => emit({ status: 'ok', say: `${ref} 没接单：${why}`, data: { id, ref, claimed: false, reason: why } });

  // 接单评论只有一行标记（认领不带图、不带回帖稿）
  const postClaimComment = async () => {
    const body = hardBreaks(head);
    const r = tapdJson(['comment', 'add', 'entry_type=stories', `entry_id=${id}`, `description=${body}`, `author=${COMMENTER}`, ...wsArg]);
    await verifyComment(workspace, id, String(r.id ?? r.data?.Comment?.id ?? ''), body, 0);
  };

  if (action === 'claimed') {
    // 校验 → 抢接单锁 → 锁里再校验 → 先发接单评论、再改标签（中间挂了也还认得出是谁接的）
    const first = await refuse();
    if (first) {
      lost(first);
      return;
    }
    const locked = await withClaimLock({ cwd: projectDirOf(args.cwd), ref, worker }, async () => {
      const why = await refuse();
      if (why) return { lost: why };
      await postClaimComment();
      const labels = nextLabels(readStory(id));
      if (labels.join('|') !== labelsOf(readStory(id)).join('|')) writeLabels(labels, id, ref, wsArg);
      return {};
    });
    if (!locked.ok) {
      lost(`接单锁在 ${locked.holder} 手里`);
      return;
    }
    if (locked.result.lost) {
      lost(locked.result.lost);
      return;
    }
    emit({ status: 'ok', say: `${ref} 接单（${worker}）`, data: { id, ref, did } });
    return;
  }

  if (changed) {
    writeLabels(want, id, ref, wsArg);
  }

  let warn = '';
  if (posts) {
    let text = '';
    let uploaded = 0;
    if (reply) {
      const up = uploadImages(reply, wsArg);
      text = up.text;
      uploaded = up.uploaded;
      if (up.dropped.length) warn = `回帖稿有 ${up.dropped.length} 张图片未上传：${up.dropped.join('、')}`;
    }
    const body = hardBreaks([head, text.trim()].filter(Boolean).join('\n\n'));
    const r = tapdJson(['comment', 'add', 'entry_type=stories', `entry_id=${id}`, `description=${body}`, `author=${COMMENTER}`, ...wsArg]);
    await verifyComment(workspace, id, String(r.id ?? r.data?.Comment?.id ?? ''), body, uploaded);
  }

  const label = { claimed: `接单（${worker}）`, done: '标记完成（不关单）', unpushed: '记录未推送', failed: '标记失败', released: '释放（下轮重做）', merging: '标记等合并', requeued: '退回就绪队列' }[action];
  emit({ status: 'ok', say: `${ref} ${label}${warn ? `；${warn}` : ''}`, data: { id, ref, did } });
});

// 写标签 + 回读校验：写逗号会被当成一个新标签名，不报错但会建出垃圾标签；锁里也用它
function writeLabels(labels, id, ref, wsArg) {
  tapdJson(['story', 'update', `id=${id}`, `label=${labels.join('|')}`, ...wsArg]);
  const got = labelsOf(readStory(id));
  if (got.join('|') !== labels.join('|')) {
    throw new Error(`${ref} 改标签后回读不一致：想要「${labels.join('|')}」，实际「${got.join('|')}」`);
  }
}

// 这张单最近的评论（接单标记在评论里）：默认只给一页，按创建时间排好序再判定
async function recentComments(workspace, id) {
  const r = await openApi('/comments', {
    query: { workspace_id: workspace || undefined, entry_type: 'stories', entry_id: id, limit: COMMENT_PAGE, order: 'created desc' }
  });
  const rows = (Array.isArray(r.data) ? r.data : []).map((x) => x?.Comment).filter(Boolean);
  return rows
    .sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')))
    .map((c) => String(c.description ?? ''));
}

function readStory(id) {
  const listed = tapdJson(['story', 'list', `id=${id}`, ...(WORKSPACE_ID ? [`workspace_id=${WORKSPACE_ID}`] : [])]);
  const story = (Array.isArray(listed.data) ? listed.data : []).map((r) => r?.Story).find((s) => s && String(s.id) === id);
  if (!story) throw new Error(`找不到 ${refOf(id)}`);
  return story;
}

// 发完经 OpenAPI 回读（`tapd-cli comment list` 会剥 HTML，数不了图）：评论在、没有字面量 \n、图片数量对得上。
// 按评论 id 查：/comments 默认只给一页，老单评论多时新评论不在第一页。
// tapd-cli 出的 id 取自接口的 data.Comment.id，接口没给时是 null（2026-09-30 实遇：评论其实发成功了）：
// 那就按创建时间倒序取这张单上评论人最新的一条
async function verifyComment(workspace, id, commentId, body, uploaded) {
  const base = { workspace_id: workspace || undefined, entry_type: 'stories', entry_id: id };
  const r = await openApi('/comments', { query: commentId ? { ...base, id: commentId } : { ...base, order: 'created desc', limit: 10 } });
  const rows = (Array.isArray(r.data) ? r.data : []).map((x) => x?.Comment).filter(Boolean);
  const c = commentId ? rows.find((x) => String(x.id) === commentId) : rows.find((x) => x.author === COMMENTER);
  if (!c) throw new Error(`${refOf(id)} 评论发出后回读不到（${commentId ? `评论 ${commentId}` : `comment add 没回评论 id，也没找到 ${COMMENTER} 的新评论`}）`);
  const text = String(c.description ?? '');
  if (text.includes('\\n') && !body.includes('\\n')) throw new Error(`${refOf(id)} 评论回读出现字面量 \\n（换行被转义了）`);
  const count = (s) => [...s.matchAll(/<img\b|!\[[^\]]*\]\(/gi)].length;
  const images = count(text);
  const expected = count(body);
  if (images !== expected) throw new Error(`${refOf(id)} 评论回读图片 ${images} 张，应为 ${expected} 张（上传 ${uploaded} 张）`);
}

// tapd-cli 转 HTML 时单个换行并进同一段（2026-09-30 实遇：四行说明挤成一坨）：
// 下一行还是普通文字时行末补两个空格变成 <br>；代码块里、表格行、下一行是列表 / 引用 / 标题 / 表格 / 代码块时不动
function hardBreaks(text) {
  const BLOCK_START = /^\s*(?:[-*+]\s|\d+[.)]\s|>|#{1,6}\s|\||```|~~~)/;
  let fence = false;
  const lines = text.split('\n');
  return lines.map((line, i) => {
    if (/^\s*(?:```|~~~)/.test(line)) { fence = !fence; return line; }
    const next = lines[i + 1];
    if (fence || !line.trim() || !next?.trim() || /^\s*\|/.test(line) || BLOCK_START.test(next)) return line;
    return `${line.replace(/\s+$/, '')}  `;
  }).join('\n');
}

// 回帖稿：Agent 写的 Markdown，图片放同目录、用相对路径引用。没写（文件不在或是空的）就返回 null，退回一句话评论。
function readReply(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  if (!text.trim()) return null;
  const refs = [...new Set([...text.matchAll(IMAGE_RE)].map((m) => m[2] ?? m[3]).filter(isLocal))];
  return { dir: path.dirname(path.resolve(file)), text, refs };
}

// 逐张上传，引用换成 `![alt](<image_src>)`（保留 alt）；格式不对、超限、不在、上传失败的换成占位 + stderr，评论照发
function uploadImages(reply, wsArg) {
  const srcOf = new Map();
  const dropped = [];
  for (const p of reply.refs) {
    const abs = path.resolve(reply.dir, p);
    try {
      if (!IMAGE_EXTS.has(path.extname(p).toLowerCase())) throw new Error('格式不支持（只收 png / gif / jpg / jpeg / bmp）');
      let size;
      try { size = statSync(abs).size; } catch { throw new Error('文件不存在'); }
      if (size >= MAX_IMAGE_BYTES) throw new Error(`超过 5MB（${size} 字节）`);
      const r = tapdJson(['attachment', 'upload-image', `file=${abs}`, ...wsArg]);
      const src = String(r.data?.image_src ?? r.data?.Attachment?.image_src ?? '').trim();
      if (!src) throw new Error('upload-image 没给 image_src');
      srcOf.set(p, src);
    } catch (err) {
      process.stderr.write(`图片未上传 ${p}：${String(err?.message ?? err).split('\n')[0]}\n`);
      dropped.push(p);
    }
  }
  let uploaded = 0;
  const text = reply.text.replace(IMAGE_RE, (m, alt, md, html) => {
    const p = md ?? html;
    if (!isLocal(p)) return m;
    const src = srcOf.get(p);
    if (!src) return `（图片未上传：\`${p}\`）`;
    uploaded++;
    return `![${md !== undefined ? alt : altOf(m)}](${src})`;
  });
  return { text, uploaded, dropped };
}
