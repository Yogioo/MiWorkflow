// 假的 TAPD OpenAPI：本地 HTTP 服务，以状态 JSON 文件为后端（与假 tapd-cli 共用同一份）。
// 用法：node 本文件 <状态文件> <令牌>；起好后 stdout 打一行 `listening <端口>`。
// 独立进程跑：被测脚本常用 spawnSync 起，同进程的服务会被堵住。
// 每个请求记一行 { method, url, auth } 到 <状态文件>.openapi.jsonl。
import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

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
      .filter((c) => (!q.entry_type || c.entry_type === q.entry_type) && (!q.entry_id || c.entry_id === q.entry_id))
      .sort((a, b) => String(a.created).localeCompare(String(b.created)));
    return send(res, 200, { status: 1, data: rows.map((c) => ({ Comment: c })), info: 'success' });
  }
  if (req.method === 'GET' && url.pathname === '/stories') {
    const rows = (state.stories ?? []).filter((s) => !q.id || String(s.id) === q.id);
    return send(res, 200, { status: 1, data: rows.map((s) => ({ Story: s })), info: 'success' });
  }
  send(res, 404, { status: 0, info: `fake openapi 不认：${req.method} ${url.pathname}` });
});

server.listen(0, '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`));
