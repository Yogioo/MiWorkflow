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
// 一直做到被要求停（POST /api/stop 用）
writeFileSync(path.join(HOME, 'tasks', 'wait.mjs'), [
  "export const title = '等停';",
  'export default async function ({ stopping }) {',
  '  for (let i = 0; i < 600 && !stopping(); i++) await new Promise((r) => setTimeout(r, 50));',
  '}',
  ''
].join('\n'));

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
  assert.deepEqual(list, [{ name: 'echo', title: '回显 who' }, { name: 'untitled', title: 'untitled' }, { name: 'wait', title: '等停' }]);
});

test('POST /api/stop：在跑的任务做完手头这一单就停，回 run.mjs stop 的话；没在跑也说一声；坏任务名 400', async () => {
  const { runId } = await (await post(`${base}/api/run`, { task: 'wait' })).json();
  const lock = path.join(HOME, 'logs', 'wait.lock');
  for (let i = 0; i < 100 && !existsSync(lock); i++) await sleep(50);
  assert.ok(existsSync(lock), 'run 没起来');

  const res = await post(`${base}/api/stop`, { task: 'wait' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.message, /已请求停止：wait 做完手头这一单就停/);

  const logFile = path.join(HOME, 'logs', `${runId}.jsonl`);
  let last;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    last = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse).at(-1);
    if (last.primitive === 'run' && last.status !== 'running') break;
  }
  assert.equal(last?.status, 'ok', JSON.stringify(last));
  assert.match(last.say, /收到停止请求/);

  const idle = await (await post(`${base}/api/stop`, { task: 'wait', now: true })).json();
  assert.match(idle.message, /wait 没在跑/);
  assert.equal((await post(`${base}/api/stop`, { task: '../x' })).status, 400);
});

test('index.html：在跑的 run 上有「做完这单停 / 立刻强关」，强关先确认', () => {
  const html = readFileSync(path.join(ROOT, 'viewer', 'index.html'), 'utf8');
  assert.match(html, /做完这单停/);
  assert.match(html, /立刻强关/);
  assert.match(html, /\/api\/stop/);
  assert.match(html, /if \(now && !confirm\(/);
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
  assert.equal((await post(`${base}/api/run`, { task: 'echo', args: { every: '5m' } })).status, 400);
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
    document: {
      addEventListener(type, fn) { (this._h ??= {})[type] = fn; },
      querySelector: el,
      getElementById: el
    },
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

test('index.html：并行工具调用里没返回的那条标出来，步骤结束后改标「没返回」', () => {
  const ctx = loadPage();
  const render = vm.runInContext('renderEvents', ctx);
  const t0 = Date.now() - 13 * 60_000;
  const items = [
    { kind: 'tool', callId: 'b', phase: 'start', t: t0, toolName: 'bash', args: { command: 'find / -name x' } },
    { kind: 'tool', callId: 'u', phase: 'start', t: t0, toolName: 'run_tests', args: {} },
    { kind: 'tool', callId: 'u', phase: 'done', t: t0 + 1000, toolName: 'run_tests', result: { text: 'started' } }
  ];
  const live = render({ open: true, items, done: false });
  const bash = live.split('</div>').find((s) => s.includes('find / -name x'));
  assert.match(bash, /进行中 · 已 13 分/, '还在等的那条带「进行中」和已等多久');
  const tests = live.split('</div>').find((s) => s.includes('run_tests'));
  assert.ok(!tests.includes('进行中'), '返回了的不标');
  assert.match(render({ open: true, items, done: true }), /没返回/, '步骤已结束还没 done 的标「没返回」');
});

test('index.html：步骤进行中，过程底部一行说清此刻在跑命令还是在等模型', () => {
  const ctx = loadPage();
  const render = vm.runInContext('renderEvents', ctx);
  const t0 = Date.now() - 42_000;
  const start = { kind: 'tool', callId: 'b', phase: 'start', t: t0, toolName: 'bash', args: { command: 'dotnet build' } };
  const done = { kind: 'tool', callId: 'b', phase: 'done', t: t0, toolName: 'bash', result: { text: 'ok' } };
  const raw = { kind: 'raw', t: Date.now() - 7_000, payload: {} };

  assert.match(render({ open: true, items: [start, raw], done: false }), /evt-now[^>]*>在跑 bash dotnet build · 已 42 秒/);
  assert.match(render({ open: true, items: [start, done, raw], done: false }), /evt-now[^>]*>等模型中 · 距上次动作 7 秒/);
  assert.ok(!render({ open: true, items: [start, done, raw], done: true }).includes('evt-now'), '步骤结束就不显示');
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
  const runningAgent = { seq: 2, primitive: 'agent', status: 'running', label: '干活', say: '干活', events: 'r/agent-1.events.jsonl' };

  let html = render([{ seq: 1, primitive: 'run', status: 'running', say: '▶ 演示' }, runningAgent]);
  const runSeg = html.slice(0, html.indexOf('干活'));
  assert.ok(!runSeg.includes('pill'), `run 的 running 行不该显示「已结束」：${runSeg}`);
  assert.ok(html.includes('进行中'), 'agent 的 running 行显示「进行中」');

  html = render([runningAgent, { seq: 3, primitive: 'agent', status: 'ok', ref: 2, say: '干完了' }]);
  assert.ok(html.includes('已结束'), '被 ref 指回的 agent 行显示「已结束」');
});

test('index.html：展开任何一行都有输入 / 输出 / 执行三段（§13.6）', () => {
  const ctx = loadPage();
  const run = (code) => vm.runInContext(code, ctx);
  const render = (recs) => {
    run(`records = ${JSON.stringify(recs)}; renderTimeline();`);
    return ctx.document.querySelector('#timeline').innerHTML;
  };
  run('setExpandAll(true)');
  const html = render([
    { seq: 1, primitive: 'run', status: 'ok', title: '开发', say: '✔ 开发 完成', task: 'dev', inputs: { max: '1' } },
    { seq: 2, primitive: 'script', name: 'git_state', status: 'ok', say: '工作区干净', inputs: { cwd: 'x' } },
    { seq: 3, primitive: 'agent', name: 'agent', label: '开发Agent', status: 'running', goal: '一段提示词', events: 'r/agent-1.events.jsonl' },
    { seq: 4, primitive: 'agent', name: 'agent', label: '开发Agent', status: 'ok', ref: 3, say: '干完了', choice: 'done' }
  ]);

  assert.equal((html.match(/class="sec-h"/g) || []).length, 12, '4 行 × 三段');
  assert.ok(html.includes('一段提示词'), 'agent 的提示词在展开的「输入」里');
  assert.ok(html.includes('工作区干净'), 'script 的输出在「输出」里');
  assert.ok(html.includes('任务：dev'), 'run 行的输入带任务名');

  // 节点名是短名，不能是提示词（§13.6）
  const says = [...html.matchAll(/<div class="say">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
  const agentSay = says.find((s) => s.includes('开发Agent'));
  assert.ok(agentSay, 'agent 行的节点名取 label');
  assert.ok(!agentSay.includes('一段提示词'), '提示词不当节点名');
});

test('index.html：运行记录能按任务筛，点开关落 localStorage（§13.6）', () => {
  const ctx = loadPage();
  const run = (code) => vm.runInContext(code, ctx);
  run(`runs = [
    { runId: 'a', task: 'discuss', title: '讨论单', status: 'ok', startedAt: null },
    { runId: 'b', task: 'dev', title: '开发单', status: 'ok', startedAt: null }
  ]; renderFilter(); renderRuns();`);

  const chips = ctx.document.querySelector('#filter').innerHTML;
  assert.ok(chips.includes('data-ftask="discuss"') && chips.includes('data-ftask="dev"'), '每个任务一个开关');
  assert.ok(chips.includes('全部'), '总是有「全部」');

  // 点 dev 开关：只留 dev，选择落 localStorage
  const click = (ftask) => ctx.document._h.click({ target: { closest: (s) => (s === 'button[data-ftask]' ? { dataset: { ftask } } : null) } });
  click('dev');
  const shown = ctx.document.querySelector('#runs').innerHTML;
  assert.ok(shown.includes('开发单') && !shown.includes('讨论单'), '只看选中的任务');
  assert.equal(ctx.localStorage.store['miworkflow.runFilter'], '["dev"]', '选择落 localStorage，刷新后还在');

  // 再点一次取消：空集 = 全部
  click('dev');
  assert.ok(ctx.document.querySelector('#runs').innerHTML.includes('讨论单'), '取消筛选后又全出来了');
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

test('POST /api/run、/api/stop：非本机请求 → 403', async (t) => {
  const ip = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!ip) return t.skip('本机没有非回环 IPv4');
  const port = new URL(base).port;
  const res = await post(`http://${ip}:${port}/api/run`, { task: 'echo', args: { who: '网页' } });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'local_only' });
  const stop = await post(`http://${ip}:${port}/api/stop`, { task: 'echo', now: true });
  assert.equal(stop.status, 403, '强关也只收本机');
});
