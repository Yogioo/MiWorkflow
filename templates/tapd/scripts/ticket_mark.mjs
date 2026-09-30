// 工单源接口：改工单状态。TAPD 实现：认领（claimed）/ 完成（done）/ 未推送留人处理（unpushed）/ 失败待人看（failed）。
// 「完成」不关单、不改状态和处理人（属于人和策划的流程）：撤 claimed、贴 delivered、评论提交号。
// failed 保留 ready（人摘掉 failed 就重新入队）；unpushed 只评论、保留 claimed。
// 标签多值用 | 分隔（写逗号不报错，TAPD 会把整串建成一个新标签），每次写完经 `story list` 回读，不对就判失败。
// 要发评论却缺评论人时，在动标签之前就报错。
// 入：{ id, action, commentFile?, comment?, sha?, dryRun? }；commentFile 是回帖稿（跟在那句话后面发，
// 其中引用的本地图片逐张 `attachment upload-image`，引用换成线上地址，见文件末尾）；没有回帖稿时只发 comment 那句话
// 出：{ status, say, data: { id, ref, did: string[] } }，id 为字符串
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { main, readStdin, emit } from './_lib.mjs';
import { tapdJson, openApi } from './_tapd.mjs';
import { WORKSPACE_ID, COMMENTER, LABELS, refOf } from '../source.mjs';

const IMAGE_EXTS = new Set(['.png', '.gif', '.jpg', '.jpeg', '.bmp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_RE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const isLocal = (p) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(p);
const labelsOf = (s) => String(s?.label ?? '').split('|').map((l) => l.trim()).filter(Boolean);
const altOf = (tag) => (/\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '').replace(/[[\]]/g, '');

await main(async () => {
  const args = await readStdin();
  const { action } = args;
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('缺 id');
  const ref = refOf(id);

  let add = [];
  let remove = [];
  let head = null;
  if (action === 'claimed') {
    add = [LABELS.claimed];
  } else if (action === 'done') {
    add = [LABELS.delivered];
    remove = [LABELS.claimed];
    head = `提交：${args.sha || '(未记录)'}`;
  } else if (action === 'unpushed') {
    head = `本地提交（未推送）：${args.sha || '(未记录)'}`;
  } else if (action === 'failed') {
    add = [LABELS.failed];
    remove = [LABELS.claimed];
    head = `afk failed：${String(args.comment ?? '').slice(0, 900)}`;
  } else {
    throw new Error(`不认识的 action：${action}（claimed / done / unpushed / failed）`);
  }
  if (head !== null && !COMMENTER && !args.dryRun) {
    throw new Error('缺评论人：设 TAPD_NPC_ROLE 或 source.mjs 的 COMMENTER（在改标签之前报错，工单未被改动）');
  }

  const before = readStory(id);
  const workspace = String(before.workspace_id || WORKSPACE_ID || '');
  const wsArg = workspace ? [`workspace_id=${workspace}`] : [];
  const current = labelsOf(before);
  const want = [...current.filter((l) => !remove.includes(l)), ...add.filter((l) => !current.includes(l))];
  const changed = want.join('|') !== current.join('|');
  const reply = head !== null && args.commentFile ? readReply(args.commentFile) : null;

  const did = [];
  if (changed) did.push(`story update id=${id} label=${want.join('|')}`);
  if (reply) for (const p of reply.refs) did.push(`attachment upload-image ${p}`);
  if (head !== null) did.push(`comment add entry_id=${id}（${reply ? '一句话 + 回帖稿' : '一句话'}）`);

  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会执行 ${did.length} 步（${action} ${ref}）`, data: { id, ref, did } });
    return;
  }

  if (changed) {
    tapdJson(['story', 'update', `id=${id}`, `label=${want.join('|')}`, ...wsArg]);
    const got = labelsOf(readStory(id));
    if (got.join('|') !== want.join('|')) {
      throw new Error(`${ref} 改标签后回读不一致：想要「${want.join('|')}」，实际「${got.join('|')}」`);
    }
  }

  let warn = '';
  if (head !== null) {
    let body = head;
    let uploaded = 0;
    if (reply) {
      const up = uploadImages(reply, wsArg);
      body = `${head}\n\n${up.text}`;
      uploaded = up.uploaded;
      if (up.dropped.length) warn = `回帖稿有 ${up.dropped.length} 张图片未上传：${up.dropped.join('、')}`;
    }
    const r = tapdJson(['comment', 'add', 'entry_type=stories', `entry_id=${id}`, `description=${body}`, `author=${COMMENTER}`, ...wsArg]);
    await verifyComment(workspace, id, String(r.data?.Comment?.id ?? ''), body, uploaded);
  }

  const label = { claimed: '认领', done: '标记完成（不关单）', unpushed: '记录未推送', failed: '标记失败' }[action];
  emit({ status: 'ok', say: `${ref} ${label}${warn ? `；${warn}` : ''}`, data: { id, ref, did } });
});

function readStory(id) {
  const listed = tapdJson(['story', 'list', `id=${id}`, ...(WORKSPACE_ID ? [`workspace_id=${WORKSPACE_ID}`] : [])]);
  const story = (Array.isArray(listed.data) ? listed.data : []).map((r) => r?.Story).find((s) => s && String(s.id) === id);
  if (!story) throw new Error(`找不到 ${refOf(id)}`);
  return story;
}

// 发完经 OpenAPI 回读（`tapd-cli comment list` 会剥 HTML，数不了图）：评论在、没有字面量 \n、图片数量对得上。
// 按评论 id 查：/comments 默认只给一页，老单评论多时新评论不在第一页
async function verifyComment(workspace, id, commentId, body, uploaded) {
  if (!commentId) throw new Error(`${refOf(id)} comment add 没回评论 id，无法回读`);
  const r = await openApi('/comments', { query: { workspace_id: workspace || undefined, id: commentId, entry_type: 'stories', entry_id: id } });
  const rows = (Array.isArray(r.data) ? r.data : []).map((x) => x?.Comment).filter(Boolean);
  const c = rows.find((x) => String(x.id) === commentId);
  if (!c) throw new Error(`${refOf(id)} 评论发出后回读不到（评论 ${commentId}）`);
  const text = String(c.description ?? '');
  if (text.includes('\\n') && !body.includes('\\n')) throw new Error(`${refOf(id)} 评论回读出现字面量 \\n（换行被转义了）`);
  const count = (s) => [...s.matchAll(/<img\b|!\[[^\]]*\]\(/gi)].length;
  const images = count(text);
  const expected = count(body);
  if (images !== expected) throw new Error(`${refOf(id)} 评论回读图片 ${images} 张，应为 ${expected} 张（上传 ${uploaded} 张）`);
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
