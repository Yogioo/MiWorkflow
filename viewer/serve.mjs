#!/usr/bin/env node
// viewer/serve.mjs — 外部工具，不属于内核（§16）
// 只做三件事：列 run、按字节切片吐日志、收决定。零依赖。
import http from 'node:http';
import { readFileSync, readdirSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGS = path.resolve(HERE, '..', 'logs');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function listRuns() {
  let files;
  try {
    files = readdirSync(LOGS).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const out = [];
  for (const f of files) {
    const runId = f.slice(0, -'.jsonl'.length);
    const file = path.join(LOGS, f);
    let lines;
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      continue;
    }
    if (!lines.length) continue;

    let head = {};
    let final = null;
    const pending = new Set();

    for (const line of lines) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.seq === 1) head = r;
      if (r.primitive === 'human') {
        if (r.status === 'pending') pending.add(r.seq);
        else if (r.ref != null) pending.delete(r.ref);
      }
      if (r.primitive === 'run' && r.status !== 'running') final = r.status;
    }

    out.push({
      runId,
      title: head.title ?? head.task ?? runId,
      task: head.task ?? null,
      startedAt: head.at ?? null,
      status: final ?? (pending.size ? 'waiting' : 'running'),
      pending: pending.size,
      mtime: statSync(file).mtimeMs
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// 增量切片：只吃完整行，最后一行没写完就留到下次
function sliceRun(runId, from) {
  const buf = readFileSync(path.join(LOGS, `${runId}.jsonl`));
  if (from >= buf.length) return { next: buf.length, records: [] };

  const text = buf.subarray(from).toString('utf8');
  const nl = text.lastIndexOf('\n');
  if (nl === -1) return { next: from, records: [] };

  const usable = text.slice(0, nl);
  const consumed = Buffer.byteLength(usable, 'utf8') + 1;
  const records = usable.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { primitive: 'raw', say: line }; }
  });
  return { next: from + consumed, records };
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const route = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'GET' && (route === '/' || route === '/index.html')) {
      const html = readFileSync(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }

    if (req.method === 'GET' && route === '/api/runs') {
      return json(res, listRuns());
    }

    const m = route.match(/^\/api\/run\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      if (!SAFE_ID.test(m[1])) return json(res, { error: 'bad_id' }, 400);
      const from = Math.max(0, Number(url.searchParams.get('from') ?? 0) || 0);
      return json(res, sliceRun(m[1], from));
    }

    if (req.method === 'POST' && route === '/api/decide') {
      const { runId, seq, decision } = await readBody(req);
      if (!SAFE_ID.test(String(runId)) || !Number.isInteger(seq) || !['ok', 'skipped'].includes(decision)) {
        return json(res, { error: 'bad_request' }, 400);
      }
      const file = path.join(LOGS, `${runId}.decide.${seq}.json`);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ decision, by: 'web', at: new Date().toISOString() }));
      renameSync(tmp, file); // 原子落地，human() 不会读到半个文件
      return json(res, { ok: true });
    }

    if (req.method === 'GET' && route === '/health') return json(res, { ok: true });

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    json(res, { error: String(err?.message ?? err) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`viewer  本机   http://localhost:${PORT}`);
  const ips = Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  for (const ip of ips) console.log(`        内网   http://${ip}:${PORT}`);
  console.log(`        日志   ${LOGS}`);
});
