// 工单源接口：读一张工单，写成工单快照（正文 + 全部评论的 Markdown，图片下载到同目录 images/）。GitHub 实现。
// 入：{ id, repo? }
// 出：{ status, say, data: { id, ref, title, file } }，id 为字符串，file 是快照路径
// 快照放 logs/<runId>/tickets/<id>/ticket.md：被 .gitignore 忽略、回滚不删、跑完可复盘。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { main, readStdin, emit, imageExt } from './_lib.mjs';
import { viewIssue, issueNumber, refOf, ghToken, fetchImpl, downloadImage, anyNeedsToken } from './_gh.mjs';

const MAX_IMAGES = 30;
// Markdown 图片 ![alt](url "title") 或 HTML <img src="url">
const IMG = /!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;

await main(async () => {
  const args = await readStdin();
  if (args.id === undefined || args.id === null || args.id === '') throw new Error('缺 id');
  const issue = viewIssue(issueNumber(args.id), args.repo ? ['--repo', args.repo] : []);
  const id = String(issue.number);
  const ref = refOf(issue.number);

  const home = path.resolve(process.env.AGENTFLOW_HOME || process.cwd());
  const dir = path.join(home, 'logs', process.env.AGENTFLOW_RUN_ID || randomUUID(), 'tickets', id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const texts = [issue.body, ...issue.comments.map((c) => c.body)];
  const urls = [...new Set(texts.flatMap((t) => [...t.matchAll(IMG)].map((m) => m[2] ?? m[3])))];
  const images = await download(urls.slice(0, MAX_IMAGES), dir);
  const skipped = urls.length - Math.min(urls.length, MAX_IMAGES);

  const rewrite = (text) => text.replace(IMG, (whole, alt, mdUrl, htmlUrl) => {
    const url = mdUrl ?? htmlUrl;
    if (!images.has(url)) return whole;
    const file = images.get(url);
    const label = alt ?? /\balt\s*=\s*["']([^"']*)["']/i.exec(whole)?.[1] ?? '';
    return file ? `![${label}](images/${file})` : `（图片未能下载：${url}）`;
  });

  const md = [
    `# ${ref} ${issue.title}`,
    '',
    rewrite(issue.body),
    ...issue.comments.map((c) => `\n---\n\n## @${c.author} 评论（${c.at}）\n\n${rewrite(c.body)}`),
    ...(skipped ? [`\n---\n\n> 还有 ${skipped} 张图片未下载（每张工单最多 ${MAX_IMAGES} 张），上文保留原链接。`] : []),
    ''
  ].join('\n');
  const file = path.join(dir, 'ticket.md');
  writeFileSync(file, md);

  emit({
    status: 'ok',
    say: `读工单 ${ref}：${issue.title}${urls.length ? `（图片 ${urls.length} 张）` : ''}`,
    data: { id, ref, title: issue.title, file }
  });
});

// 逐张下载到 dir/images/，返回 url → 文件名（下载失败为 null）；单张失败只在 stderr 记一行，不让整单失败
async function download(urls, dir) {
  const out = new Map();
  if (!urls.length) return out;
  mkdirSync(path.join(dir, 'images'), { recursive: true });

  let token = '';
  if (anyNeedsToken(urls)) {
    try { token = ghToken(); } catch (err) { console.error(`取不到 gh 令牌，图片不带鉴权下载：${err.message.split('\n')[0]}`); }
  }
  const mask = (s) => (token ? String(s).replaceAll(token, '***') : String(s));
  const doFetch = await fetchImpl();

  let n = 0;
  for (const url of urls) {
    try {
      const buf = await downloadImage(url, { token, fetch: doFetch });
      const name = `${++n}.${imageExt(buf)}`;
      writeFileSync(path.join(dir, 'images', name), buf);
      out.set(url, name);
    } catch (err) {
      console.error(mask(`图片下载失败 ${url}：${err?.message ?? err}`));
      out.set(url, null);
    }
  }
  return out;
}
