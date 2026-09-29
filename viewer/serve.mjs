#!/usr/bin/env node
// viewer/serve.mjs — 外部工具，不属于内核（§16）
// 只做这几件事：列 run、按字节切片吐日志、收决定、列任务、起任务。零依赖。
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync
} from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.join(HERE, '..', 'run.mjs');
// 与 core 同一个 HOME（§3）：看的是沉淀那边的日志，不是内核目录
const HOME = path.resolve(process.env.AGENTFLOW_HOME || process.cwd());
const LOGS = path.join(HOME, 'logs');
const TASKS = path.join(HOME, 'tasks');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
// 起任务等于起全权限 Agent：默认只收本机，局域网只能看和审批
const REMOTE_RUN = process.env.MIWORKFLOW_REMOTE_RUN === '1';
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const SAFE_TASK = /^[A-Za-z0-9_-]+$/;
const SAFE_KEY = /^[A-Za-z][\w-]*$/;
const TITLE = /export\s+const\s+title\s*=\s*(['"`])(.*?)\1/;

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

// Agent 过程（§10.1）：logs/<runId>/agent-<n>.events.jsonl，一行一个归一事件。
// 文件可能还没建 / 正在长 / 半行：只吃完整行，读不到就当没有。坏行当 raw，不整段丢。
function sliceEvents(file, from) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return { next: 0, items: [] }; // 步骤还没开始写（含刚建就没了）
  }
  if (from >= buf.length) return { next: buf.length, items: [] };

  const text = buf.subarray(from).toString('utf8');
  const nl = text.lastIndexOf('\n');
  if (nl === -1) return { next: from, items: [] }; // 最后一行没写完，留到下次

  const usable = text.slice(0, nl);
  const consumed = Buffer.byteLength(usable, 'utf8') + 1;
  const items = usable.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { kind: 'raw', payload: line }; }
  });
  return { next: from + consumed, items };
}

// 增量切片：只吃完整行，最后一行没写完就留到下次
function sliceRun(runId, from) {
  const file = path.join(LOGS, `${runId}.jsonl`);
  if (!existsSync(file)) return { next: 0, records: [] }; // 刚起的 run 还没写第一行
  const buf = readFileSync(file);
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

// 正则读 title，不 import：列任务不该执行任务模块
function listTasks() {
  let files;
  try {
    files = readdirSync(TASKS).filter((f) => f.endsWith('.mjs'));
  } catch {
    return [];
  }
  return files.map((f) => {
    const name = f.slice(0, -'.mjs'.length);
    let title = name;
    try {
      title = readFileSync(path.join(TASKS, f), 'utf8').match(TITLE)?.[2] ?? name;
    } catch { /* 读不了就用文件名 */ }
    return { name, title };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

const isLocal = (addr = '') => addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');

// { key: 'v' | true } → ['--key=v', '--flag']；用 --key=value，值以 -- 开头也不会被当成开关
function toArgv(args) {
  if (args == null) return [];
  if (typeof args !== 'object' || Array.isArray(args)) return null;
  const out = [];
  for (const [k, v] of Object.entries(args)) {
    if (!SAFE_KEY.test(k)) return null;
    if (v === true) out.push(`--${k}`);
    else if (typeof v === 'string' || typeof v === 'number') out.push(`--${k}=${v}`);
    else return null;
  }
  return out;
}

// 预先生成 runId 回给页面；审批走同一页面（AGENTFLOW_HUMAN=web）
function startRun(task, argv) {
  const runId = randomUUID();
  mkdirSync(LOGS, { recursive: true });
  const out = openSync(path.join(LOGS, `${runId}.out.log`), 'a');
  const child = spawn(process.execPath, [RUN, task, ...argv], {
    cwd: HOME,
    env: {
      ...process.env,
      AGENTFLOW_HOME: HOME,
      AGENTFLOW_RUN_ID: runId,
      AGENTFLOW_HUMAN: 'web',
      PORT: String(server.address().port)
    },
    stdio: ['ignore', out, out],
    windowsHide: true
  });
  closeSync(out);
  child.on('error', () => {});
  return runId;
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

    // Agent 某一步的过程（只读）：runId 过 SAFE_ID、n 纯数字，拼出的路径必须还在 LOGS 内。
    // 带 from 按字节增量吐 { next, items }；不带 from 吐全量数组（兼容老调用）。
    const me = route.match(/^\/api\/run\/([^/]+)\/events\/([^/]+)$/);
    if (req.method === 'GET' && me) {
      if (!SAFE_ID.test(me[1]) || !/^\d+$/.test(me[2])) return json(res, { error: 'bad_id' }, 400);
      const file = path.join(LOGS, me[1], `agent-${me[2]}.events.jsonl`);
      if (!path.resolve(file).startsWith(path.resolve(LOGS) + path.sep)) {
        return json(res, { error: 'bad_id' }, 400); // 目录穿越（runId 里的 ..）
      }
      const fromParam = url.searchParams.get('from');
      if (fromParam == null) return json(res, sliceEvents(file, 0).items);
      const from = Math.max(0, Number(fromParam) || 0);
      return json(res, sliceEvents(file, from));
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

    if (req.method === 'GET' && route === '/api/tasks') {
      return json(res, listTasks());
    }

    if (req.method === 'POST' && route === '/api/run') {
      if (!REMOTE_RUN && !isLocal(req.socket.remoteAddress)) {
        return json(res, { error: 'local_only' }, 403);
      }
      const { task, args } = await readBody(req);
      if (!SAFE_TASK.test(String(task)) || !existsSync(path.join(TASKS, `${task}.mjs`))) {
        return json(res, { error: 'no_such_task' }, 400);
      }
      const argv = toArgv(args);
      if (!argv) return json(res, { error: 'bad_args' }, 400);
      return json(res, { runId: startRun(task, argv) });
    }

    if (req.method === 'GET' && route === '/health') return json(res, { ok: true });

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    json(res, { error: String(err?.message ?? err) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  const port = server.address().port;
  console.log(`viewer  本机   http://localhost:${port}`);
  const ips = Object.values(networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  for (const ip of ips) console.log(`        内网   http://${ip}:${port}${REMOTE_RUN ? '' : '（只能看和审批）'}`);
  console.log(`        HOME   ${HOME}`);
});
