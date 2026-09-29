import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

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

// ── Agent 过程（§10.1）：viewer 展开某一步读 events.jsonl ──
const events = [
  { kind: 'tool', t: 1, callId: 'c1', phase: 'start', toolName: 'shell', args: { command: 'ls -a' } },
  { kind: 'assistant', t: 2, text: '看完了，开始改' },
  { kind: 'thinking', t: 3, text: '先读文件' },
  { kind: 'tool', t: 4, callId: 'c1', phase: 'done', toolName: 'shell', result: { exit_code: 0, output: 'a b' } },
  { kind: 'error', t: 5, text: '炸了' }
];

function writeEvents(runId, n, list) {
  mkdirSync(path.join(HOME, 'logs', runId), { recursive: true });
  writeFileSync(path.join(HOME, 'logs', runId, `agent-${n}.events.jsonl`),
    list.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('GET /api/run/<id>/events/<n>：返回写进 logs/<runId>/ 的事件', async () => {
  writeEvents('evt-run', 1, events);
  const res = await fetch(`${base}/api/run/evt-run/events/1`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), events);
});

test('GET /api/run/<id>/events/<n>：文件不存在 → []，不报错', async () => {
  const res = await fetch(`${base}/api/run/still-running/events/2`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('GET /api/run/<id>/events/<n>：坏行当 raw，不整段丢', async () => {
  mkdirSync(path.join(HOME, 'logs', 'evt-partial'), { recursive: true });
  writeFileSync(path.join(HOME, 'logs', 'evt-partial', 'agent-3.events.jsonl'),
    '{"kind":"assistant","text":"在"}\nnot json\n');
  const list = await (await fetch(`${base}/api/run/evt-partial/events/3`)).json();
  assert.deepEqual(list[0], { kind: 'assistant', text: '在' });
  assert.equal(list[1].kind, 'raw');
  assert.equal(list[1].payload, 'not json');
});

// index.html 的渲染逻辑（纯函数，无依赖）：agent 过程渲染成人话，刷屏的原始事件折叠且有上限
const loadPage = () => {
  const code = readFileSync(path.join(ROOT, 'viewer', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const el = () => ({ innerHTML: '', textContent: '', dataset: {} });
  const ctx = {
    document: { addEventListener() {}, querySelector: el, getElementById: el },
    fetch: async () => ({ ok: true, json: async () => [] }),
    setInterval: () => 0
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
};

test('index.html：agent 过程渲染成人话，原始 / 流式事件折叠且不刷屏', () => {
  const ctx = loadPage();
  const raw = Array.from({ length: 25000 }, (_, i) => ({ kind: 'raw', t: i, payload: { i } }));
  const out = vm.runInContext('renderEvents', ctx)({
    open: true,
    items: [
      { kind: 'tool', callId: 'c1', phase: 'start', toolName: 'shell', args: { command: 'ls -a' } },
      { kind: 'assistant', text: '看完了' },
      { kind: 'thinking', text: '先读文件' },
      { kind: 'tool', callId: 'c1', phase: 'done', toolName: 'shell', result: { exit_code: 0, output: 'a b' } },
      { kind: 'error', text: '<炸了>' },
      ...raw
    ]
  });
  assert.ok(out.includes('· shell ls -a'), '工具行');
  assert.ok(out.includes('→ exit 0 · a b'), 'start / done 合成一行，带结果摘要');
  assert.ok(out.includes('» 看完了'), 'assistant 行');
  assert.ok(out.includes('… 先读文件'), 'thinking 行');
  assert.ok(out.includes('✖ &lt;炸了&gt;'), 'error 行且转义');
  assert.ok(out.includes('另有 25000 条流式 / 原始事件'), 'outcome / raw 折进 details');
  assert.ok(out.length < 60_000, `原始事件不该整段塞进 HTML（events.jsonl 会上到 10MB）：${out.length}`);
});

test('GET /api/run/<id>/events/<n>：坏 id / 越界路径 → 400', async () => {
  // runId 里的 ..（%2f 绕过 URL 归一）必须被拦，否则会读出 LOGS 外
  assert.equal((await fetch(`${base}/api/run/..%2fevents/1`)).status, 400);
  assert.equal((await fetch(`${base}/api/run/bad%20id/events/1`)).status, 400);
  assert.equal((await fetch(`${base}/api/run/evt-run/events/1a`)).status, 400);
  assert.equal((await fetch(`${base}/api/run/evt-run/events/-1`)).status, 400);
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
