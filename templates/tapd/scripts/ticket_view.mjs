// 工单源接口：读一张需求，写成工单快照（描述 + 全部评论的 Markdown，图片下载到同目录 images/）。TAPD 实现。
// 描述走 `story list id=… with_v_status=1`；评论直接调 OpenAPI（`tapd-cli comment list` 会剥掉 HTML）。
// 图片：`/tfl/...` 站内路径经 `attachment get-image` 换 300 秒有效的 download_url 再下；绝对 URL 直接下。
// 入：{ id }
// 出：{ status, say, data: { id, ref, title, file } }，id 为字符串，file 是快照路径
// 快照放 logs/<runId>/tickets/<id>/ticket.md：被 .gitignore 忽略、回滚不删、跑完可复盘。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { main, readStdin, emit, imageExt } from './_lib.mjs';
import { tapdJson, openApi, htmlToMarkdown, IMG_SRC, imgSrcOf, mask } from './_tapd.mjs';
import { WORKSPACE_ID, refOf } from '../source.mjs';

const MAX_IMAGES = 30;
const COMMENT_PAGE = 200;

await main(async () => {
  const args = await readStdin();
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('缺 id');
  const ref = refOf(id);

  const listed = tapdJson(['story', 'list', `id=${id}`, 'with_v_status=1', ...(WORKSPACE_ID ? [`workspace_id=${WORKSPACE_ID}`] : [])]);
  const story = (Array.isArray(listed.data) ? listed.data : []).map((r) => r?.Story).find((s) => s && String(s.id) === id);
  if (!story) throw new Error(`找不到 ${ref}`);
  const workspace = String(story.workspace_id || WORKSPACE_ID || '');
  const title = String(story.name || id);
  const comments = await commentsOf(workspace, id);

  const home = path.resolve(process.env.AGENTFLOW_HOME || process.cwd());
  const dir = path.join(home, 'logs', process.env.AGENTFLOW_RUN_ID || randomUUID(), 'tickets', id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const htmls = [story.description, ...comments.map((c) => c.description)].map((h) => String(h ?? ''));
  const srcs = [...new Set(htmls.flatMap((h) => [...h.matchAll(IMG_SRC)].map(imgSrcOf)).filter(Boolean))];
  const images = await download(srcs.slice(0, MAX_IMAGES), dir, workspace);
  const skipped = srcs.length - Math.min(srcs.length, MAX_IMAGES);

  const img = (src, alt) => {
    if (!images.has(src)) return `（图片未下载：${src}）`;
    const file = images.get(src);
    return file ? `![${alt}](images/${file})` : `（图片未能下载：${src}）`;
  };
  const md = (html) => htmlToMarkdown(html, { img }) || '（空）';

  const text = [
    `# ${ref} ${title}`,
    '',
    md(story.description),
    ...comments.map((c) => `\n---\n\n## ${c.author || '（未知）'} 评论（${c.created || ''}）\n\n${md(c.description)}`),
    ...(skipped ? [`\n---\n\n> 还有 ${skipped} 张图片未下载（每张工单最多 ${MAX_IMAGES} 张）。`] : []),
    ''
  ].join('\n');
  const file = path.join(dir, 'ticket.md');
  writeFileSync(file, text);

  emit({
    status: 'ok',
    say: `读工单 ${ref}：${title}${srcs.length ? `（图片 ${srcs.length} 张）` : ''}`,
    data: { id, ref, title, file }
  });
});

// 全部评论，按时间从早到晚；翻页取完，不截断
async function commentsOf(workspace, id) {
  const seen = new Map();
  for (let page = 1; ; page++) {
    const r = await openApi('/comments', {
      query: { workspace_id: workspace || undefined, entry_type: 'stories', entry_id: id, limit: COMMENT_PAGE, page }
    });
    const rows = (Array.isArray(r.data) ? r.data : []).map((x) => x?.Comment).filter(Boolean);
    let fresh = 0;
    for (const c of rows) {
      const key = String(c.id ?? `${c.created}|${c.author}|${c.description}`);
      if (!seen.has(key)) { seen.set(key, c); fresh++; }
    }
    if (rows.length < COMMENT_PAGE || !fresh) break;
  }
  return [...seen.values()].sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')));
}

// 图片下载地址：绝对 URL 直接用；`/tfl/...` 站内路径换 download_url；认不出的报错
function imageUrl(src, workspace) {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('//')) return `https:${src}`;
  if (!src.startsWith('/')) throw new Error('认不出这个图片地址');
  const r = tapdJson(['attachment', 'get-image', ...(workspace ? [`workspace_id=${workspace}`] : []), `image_path=${src}`]);
  const att = r.data?.Attachment ?? r.data ?? {};
  const url = String(att.download_url ?? '').trim();
  if (!url) throw new Error('get-image 没给 download_url');
  return url;
}

// 逐张下载到 dir/images/，返回 src → 文件名（失败为 null）；单张失败只在 stderr 记一行，不让整单失败
async function download(srcs, dir, workspace) {
  const out = new Map();
  if (!srcs.length) return out;
  mkdirSync(path.join(dir, 'images'), { recursive: true });
  let n = 0;
  for (const src of srcs) {
    try {
      const res = await fetch(imageUrl(src, workspace), { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const name = `${++n}.${imageExt(buf)}`;
      writeFileSync(path.join(dir, 'images', name), buf);
      out.set(src, name);
    } catch (err) {
      process.stderr.write(`${mask(`图片下载失败 ${src}：${String(err?.message ?? err).split('\n')[0]}`)}\n`);
      out.set(src, null);
    }
  }
  return out;
}
