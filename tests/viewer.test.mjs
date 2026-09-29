import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('GET /api/run/<id>/events/<n>?from=N：半行留到下次，补全后增量取到新事件', async () => {
  const dir = path.join(HOME, 'logs', 'evt-inc');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'agent-1.events.jsonl');
  // 第三行故意没写完（运行中文件会半行）
  writeFileSync(file, '{"kind":"assistant","text":"a"}\n{"kind":"assistant","text":"b"}\n{"kind":"assist');

  const r1 = await (await fetch(`${base}/api/run/evt-inc/events/1?from=0`)).json();
  assert.deepEqual(r1.items.map((x) => x.text), ['a', 'b'], '半行不算数');

  appendFileSync(file, 'ant","text":"c"}\n');
  const r2 = await (await fetch(`${base}/api/run/evt-inc/events/1?from=${r1.next}`)).json();
  assert.deepEqual(r2.items, [{ kind: 'assistant', text: 'c' }], '从字节偏移续读只吐新增');
  assert.ok(r2.next > r1.next, 'next 往前走');

  const r3 = await (await fetch(`${base}/api/run/evt-inc/events/1?from=${r2.next}`)).json();
  assert.deepEqual(r3, { next: r2.next, items: [] }, '没新内容就吐空，不重复');
});

test('GET /api/run/<id>/events/<n>?from=N：文件不存在 → 空且稳', async () => {
  const res = await fetch(`${base}/api/run/no-such-run/events/9?from=0`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { next: 0, items: [] });
});

// index.html 的渲染逻辑（纯函数，无依赖）：agent 过程渲染成人话，刷屏的原始事件折叠且有上限
const loadPage = () => {
  const code = readFileSync(path.join(ROOT, 'viewer', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = new Map();
  const el = (s) => { if (!els.has(s)) els.set(s, { innerHTML: '', textContent: '', dataset: {} }); return els.get(s); };
  const ctx = {
    document: { addEventListener() {}, querySelector: el, getElementById: el },
    fetch: async () => ({ ok: true, json: async () => [] }),
    setInterval: () => 0,
    localStorage: { store: {}, getItem(k) { return this.store[k] ?? null; }, setItem(k, v) { this.store[k] = String(v); } }
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

test('index.html：默认收缩，手动状态优先于全局默认（§13.6）', () => {
  const ctx = loadPage();
  const isOpen = (seq) => vm.runInContext('isOpen', ctx)({ seq });
  const setExpandAll = (v) => vm.runInContext('setExpandAll', ctx)(v);

  assert.equal(isOpen(1), false, '缺省收缩');

  vm.runInContext('manual', ctx).set(1, true);
  assert.equal(isOpen(1), true, '手动点过就展开');

  vm.runInContext('manual', ctx).set(2, false);
  setExpandAll(true);
  assert.equal(isOpen(2), false, '手动收缩的行不跟默认走');
  assert.equal(isOpen(3), true, '没手动点过的行跟随全局默认');
  assert.equal(ctx.localStorage.store['miworkflow.expand'], '1', '选择落 localStorage');
});

test('index.html：「进行中 / 已结束」只标在 agent 的进行中行上，run 行不误标', () => {
  const ctx = loadPage();
  const render = (recs) => {
    vm.runInContext(`records = ${JSON.stringify(recs)}; renderTimeline();`, ctx);
    return ctx.document.querySelector('#timeline').innerHTML;
  };
  const runningAgent = { seq: 2, primitive: 'agent', status: 'running', say: '干活', events: 'r/agent-1.events.jsonl' };

  let html = render([{ seq: 1, primitive: 'run', status: 'running', say: '▶ 演示' }, runningAgent]);
  const runSeg = html.slice(0, html.indexOf('干活'));
  assert.ok(!runSeg.includes('pill'), `run 的 running 行不该显示「已结束」：${runSeg}`);
  assert.ok(html.includes('进行中'), 'agent 的 running 行显示「进行中」');

  html = render([runningAgent, { seq: 3, primitive: 'agent', status: 'ok', ref: 2, say: '干完了' }]);
  assert.ok(html.includes('已结束'), '被 ref 指回的 agent 行显示「已结束」');
});

test('index.html：过程一次拉回上万条也不炸（events.jsonl 能上 10MB）', async () => {
  const ctx = loadPage();
  const big = Array.from({ length: 100_000 }, (_, i) => ({ kind: 'raw', i }));
  ctx.fetch = async () => ({ ok: true, json: async () => ({ next: 1234, items: big }) });
  vm.runInContext("records = [{ seq: 1, primitive: 'agent', status: 'running', events: 'r/agent-1.events.jsonl' }]", ctx);

  await vm.runInContext('toggleEvents(1)', ctx);
  const st = vm.runInContext('agentEvents.get(1)', ctx);
  assert.equal(st.error, null, '不该因为一次拉太多而报错');
  assert.equal(st.items.length, 100_000, '一次拉回的事件照单全收');
  assert.equal(st.next, 1234, '字节偏移往前走');
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
