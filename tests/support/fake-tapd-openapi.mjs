// 假的 TAPD OpenAPI：本地 HTTP 服务，以状态 JSON 文件为后端（与假 tapd-cli 共用同一份）。
// 用法：node 本文件 <状态文件> <令牌>；起好后 stdout 打一行 `listening <端口>`。
// 独立进程跑：被测脚本常用 spawnSync 起，同进程的服务会被堵住。
// 每个请求记一行 { method, url, auth } 到 <状态文件>.openapi.jsonl。
import http from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [stateFile, token] = process.argv.slice(2);
const send = (res, code, v) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(v));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  appendFileSync(`${stateFile}.openapi.jsonl`, JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null }) + '\n');
  // 图片下载地址（get-image 换出来的，自带签名、不要令牌）：state.files[路径] 为 base64
  if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
    const b64 = JSON.parse(readFileSync(stateFile, 'utf8')).files?.[url.pathname.slice('/files'.length)];
    if (b64 === undefined) return send(res, 404, { status: 0, info: 'no such file' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(Buffer.from(b64, 'base64'));
  }
  if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { status: 0, info: 'unauthorized' });

  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  const q = Object.fromEntries(url.searchParams);
  if (req.method === 'GET' && url.pathname === '/comments') {
    const rows = (state.comments ?? [])
      .filter((c) => (!q.id || String(c.id) === q.id) && (!q.entry_type || c.entry_type === q.entry_type) && (!q.entry_id || c.entry_id === q.entry_id))
      .sort((a, b) => String(a.created).localeCompare(String(b.created)) * (q.order === 'created desc' ? -1 : 1));
    const limit = Number(q.limit ?? 30);
    const page = Number(q.page ?? 1);
    return send(res, 200, { status: 1, data: rows.slice((page - 1) * limit, page * limit).map((c) => ({ Comment: c })), info: 'success' });
  }
  // 前后置依赖：state.relations = [{ workitem_id, dst_workitem_id, src_field, dst_field }]
  if (req.method === 'GET' && url.pathname === '/stories/get_time_relative_stories') {
    if ((state.fail ?? []).includes('relations')) return send(res, 500, { status: 0, info: 'boom' });
    const rows = (state.relations ?? []).filter((r) => r.workitem_id === q.story_id || r.dst_workitem_id === q.story_id);
    return send(res, 200, { status: 1, data: rows.map((r) => ({ WorkitemTimeRelation: r })), info: 'success' });
  }
  // 写依赖：只认表单扁平写法（`relations[0][workitem_id]` 等），JSON body 报 422（真接口如此，TODO F4.1）
  if (req.method === 'POST' && url.pathname === '/stories/save_time_relations') {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (!/^application\/x-www-form-urlencoded/.test(req.headers['content-type'] ?? '')) {
        return send(res, 422, { status: 422, info: 'invalid or empty parameter relations or relation_ids' });
      }
      const form = new URLSearchParams(raw);
      const made = [];
      for (let i = 0; ; i++) {
        const from = form.get(`relations[${i}][workitem_id]`);
        if (!from) break;
        made.push({
          id: String(1152360842001000000 + (state.relations?.length ?? 0) + i + 1),
          workspace_id: form.get('workspace_id') ?? '', workitem_type: 'story', workitem_id: from,
          src_field: form.get(`relations[${i}][src_field]`) ?? '',
          dst_workspace_id: form.get('workspace_id') ?? '', dst_workitem_type: 'story',
          dst_workitem_id: form.get(`relations[${i}][dst_workitem_id]`) ?? '',
          dst_field: form.get(`relations[${i}][dst_field]`) ?? '', relation_type: 'after', lag_time: '0'
        });
      }
      const next = JSON.parse(readFileSync(stateFile, 'utf8'));
      next.relations = [...(next.relations ?? []), ...made];
      writeFileSync(stateFile, JSON.stringify(next, null, 2));
      send(res, 200, { status: 1, data: null, info: 'success' });
    });
    return;
  }
  // 工作流结束状态：state.lastSteps = { 状态键: 中文名 }；没给就当接口不可用
  if (req.method === 'GET' && url.pathname === '/workflows/last_steps') {
    if (!state.lastSteps) return send(res, 200, { status: 0, info: 'no permission' });
    return send(res, 200, { status: 1, data: state.lastSteps, info: 'success' });
  }
  if (req.method === 'GET' && url.pathname === '/workflows/status_map') {
    return send(res, 200, { status: 1, data: state.statusMap ?? {}, info: 'success' });
  }
  if (req.method === 'GET' && url.pathname === '/stories') {
    const rows = (state.stories ?? []).filter((s) => !q.id || String(s.id) === q.id);
    return send(res, 200, { status: 1, data: rows.map((s) => ({ Story: s })), info: 'success' });
  }
  send(res, 404, { status: 0, info: `fake openapi 不认：${req.method} ${url.pathname}` });
});

server.listen(0, '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`));
