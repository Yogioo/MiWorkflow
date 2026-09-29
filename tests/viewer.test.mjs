import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// viewer 的任务列表与运行按钮（§13.6）：真起 serve.mjs，HOME 是临时目录
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-viewer-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(path.join(HOME, 'tasks'));
writeFileSync(path.join(HOME, 'tasks', 'echo.mjs'), [
  "export const title = '回显 who';",
  'export default async function ({ args }) {',
  "  if (args.who !== '网页') throw new Error(`args 不对：${JSON.stringify(args)}`);",
  '}',
  ''
].join('\n'));
writeFileSync(path.join(HOME, 'tasks', 'untitled.mjs'), 'export default async function () {}\n');

let server;
let base;

before(async () => {
  const env = { ...process.env, AGENTFLOW_HOME: HOME, PORT: '0', HOST: '0.0.0.0' };
  delete env.MIWORKFLOW_REMOTE_RUN;
  server = spawn(process.execPath, [path.join(ROOT, 'viewer', 'serve.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !base; i++) {
    await sleep(50);
    const m = out.match(/localhost:(\d+)/);
    if (m) base = `http://127.0.0.1:${m[1]}`;
  }
  assert.ok(base, `viewer 没起来：${out}`);
});

after(() => {
  server?.kill();
  rmSync(HOME, { recursive: true, force: true });
});

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});

test('GET /api/tasks：列任务与 title，没 title 就用文件名', async () => {
  const list = await (await fetch(`${base}/api/tasks`)).json();
  assert.deepEqual(list, [{ name: 'echo', title: '回显 who' }, { name: 'untitled', title: 'untitled' }]);
});

test('POST /api/run：本机起任务，参数传进去，输出落 out.log', async () => {
  const res = await post(`${base}/api/run`, { task: 'echo', args: { who: '网页' } });
  assert.equal(res.status, 200);
  const { runId } = await res.json();
  assert.match(runId, /^[\w-]+$/);

  const logFile = path.join(HOME, 'logs', `${runId}.jsonl`);
  let last;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (!existsSync(logFile)) continue;
    last = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse).at(-1);
    if (last.primitive === 'run' && last.status !== 'running') break;
  }
  assert.equal(last?.status, 'ok', JSON.stringify(last));
  assert.ok(existsSync(path.join(HOME, 'logs', `${runId}.out.log`)));
});

test('POST /api/run：没有的任务、坏参数 → 400', async () => {
  assert.equal((await post(`${base}/api/run`, { task: '../x' })).status, 400);
  assert.equal((await post(`${base}/api/run`, { task: 'nope' })).status, 400);
  assert.equal((await post(`${base}/api/run`, { task: 'echo', args: { who: { a: 1 } } })).status, 400);
});

test('GET /api/run/<id>：日志还没生成 → 空，不报错', async () => {
  const res = await fetch(`${base}/api/run/not-yet`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { next: 0, records: [] });
});

test('POST /api/run：非本机请求 → 403', async (t) => {
  const ip = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!ip) return t.skip('本机没有非回环 IPv4');
  const port = new URL(base).port;
  const res = await post(`http://${ip}:${port}/api/run`, { task: 'echo', args: { who: '网页' } });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'local_only' });
});
