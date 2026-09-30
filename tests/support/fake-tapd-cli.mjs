// 假的 tapd-cli：以 FAKE_TAPD_STATE 里的 JSON 为后端，经 MIWORKFLOW_TAPD 注入（node 本文件 <参数…>）。
// 状态：{ stories: [{ id, name, label, priority, description, status, owner, workspace_id }],
//         comments: [{ id, entry_type, entry_id, description, author, created }],
//         fail?: { times, message }, calls: [argv…], uploads: [{ file, size }] }
// 故障开关：ignoreUpdate（story update 不落库，测回读校验）、escapeNewlines（comment add 把换行存成字面量 \n）、
// noCommentId（comment add 发成功了但不回评论 id）
// 像真 tapd-cli 一样：连字符写法的参数静默丢掉；comment list 剥 HTML；comment add 出 { ok, id }，JSON 后面还跟几行。
import { readFileSync, writeFileSync } from 'node:fs';

const STATE = process.env.FAKE_TAPD_STATE;
const argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(STATE, 'utf8'));
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const out = (v) => process.stdout.write(JSON.stringify(v));
const die = (m) => { save(); process.stderr.write(m + '\n'); process.exit(1); };

state.calls = (state.calls ?? []).concat([argv]);
if (state.fail?.times > 0) {
  state.fail.times--;
  die(state.fail.message ?? 'network timeout');
}

const [entity, action, ...rest] = argv;
const params = {};
for (const a of rest) {
  const m = /^([A-Za-z_]+)=([\s\S]*)$/.exec(a);
  if (m) params[m[1]] = m[2];
}
const page = (rows) => {
  const limit = Number(params.limit ?? 30);
  const p = Number(params.page ?? 1);
  return rows.slice((p - 1) * limit, p * limit);
};
const stripHtml = (s) => String(s ?? '').replace(/<[^>]+>/g, '');
state.stories ??= [];
state.comments ??= [];

if (entity === 'story' && action === 'list') {
  let rows = state.stories;
  if (params.id) rows = rows.filter((s) => String(s.id) === params.id);
  if (params.owner) rows = rows.filter((s) => String(s.owner ?? '').includes(params.owner));
  if (params.label) rows = rows.filter((s) => String(s.label ?? '').split('|').includes(params.label));
  save(); out({ status: 1, data: page(rows).map((s) => ({ Story: s })), info: 'success' });
} else if (entity === 'story' && action === 'update') {
  const s = state.stories.find((x) => String(x.id) === params.id);
  if (!s) die(`story not found: ${params.id}`);
  if (!state.ignoreUpdate) for (const [k, v] of Object.entries(params)) if (k !== 'id') s[k] = v;
  save(); out({ status: 1, data: { Story: s }, info: 'success' });
} else if (entity === 'attachment' && action === 'upload-image') {
  // 存 state.uploads，给出 /tfl/pictures/<n>.<扩展名>；文件不在就报错
  let size;
  try { size = readFileSync(params.file).length; } catch { die(`读不到 ${params.file}`); }
  state.uploads = (state.uploads ?? []).concat([{ file: params.file, size }]);
  const src = `/tfl/pictures/${state.uploads.length}${params.file.slice(params.file.lastIndexOf('.'))}`;
  save(); out({ status: 1, data: { image_src: src, html_code: `<img src="${src}"/>` }, info: 'success' });
} else if (entity === 'comment' && action === 'add') {
  const c = {
    id: String(state.comments.length + 1),
    entry_type: params.entry_type ?? '',
    entry_id: params.entry_id ?? '',
    description: state.escapeNewlines ? String(params.description ?? '').replace(/\n/g, '\\n') : params.description ?? '',
    author: params.author ?? process.env.TAPD_NPC_ROLE ?? '',
    created: `2026-01-01 00:00:${String(state.comments.length).padStart(2, '0')}`
  };
  state.comments.push(c);
  // 真 tapd-cli 出 { ok, id }（id 取自接口的 data.Comment.id，接口没给就是 null，也不写 /tmp/comment.log）
  const id = state.noCommentId ? null : c.id;
  save(); out({ ok: true, id });
  if (id) process.stdout.write(`\n已写入 /tmp/comment.log\n[COMMENT_CONTENT_START]\n${c.description}\n`);
} else if (entity === 'comment' && action === 'list') {
  const rows = state.comments
    .filter((c) => (!params.entry_type || c.entry_type === params.entry_type) && (!params.entry_id || c.entry_id === params.entry_id))
    .map((c) => ({ Comment: { ...c, description: stripHtml(c.description) } }));
  save(); out({ status: 1, data: page(rows), info: 'success' });
} else if (entity === 'attachment' && action === 'get-image') {
  // 站内路径换假 OpenAPI 上的 /files/<路径>；state.files 里没有的也照给地址，下载时 404
  if (!params.image_path) die('缺 image_path');
  const base = String(process.env.TAPD_API_ENDPOINT ?? '').replace(/\/+$/, '');
  save(); out({ status: 1, data: { Attachment: { download_url: `${base}/files${params.image_path}` } }, info: 'success' });
} else {
  die(`fake tapd-cli 不认：${argv.join(' ')}`);
}
