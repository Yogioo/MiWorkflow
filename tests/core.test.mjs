import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 测试用一次性 HOME（§3）：fixture 不落进内核目录。必须在首次 import core 之前定好
const HOME = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-test-'));
process.env.AGENTFLOW_HOME = HOME;
after(() => rmSync(HOME, { recursive: true, force: true }));

const LOGS = path.join(HOME, 'logs');
const SCRIPTS = path.join(HOME, 'scripts');
const FIXTURE = '__test_fixture';
const EXIT1 = '__test_exit1';
const FIXTURE_NAMES = [FIXTURE, EXIT1];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = () => `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const logPath = (runId) => path.join(LOGS, `${runId}.jsonl`);
const rows = (runId) => readFileSync(logPath(runId), 'utf8').split('\n').filter(Boolean).map(JSON.parse);

// 测试自带 fixture，跑完清掉——仓库不预置任何具体实现（§3、§16）
const FIXTURE_SRC = [
  "let raw = '';",
  'for await (const chunk of process.stdin) raw += chunk;',
  'const args = raw ? JSON.parse(raw) : {};',
  'process.stdout.write(JSON.stringify({',
  "  status: 'ok',",
  '  say: `fixture 收到：${args.who ?? \'nobody\'}`,',
  '  data: { ...args, cwd: process.cwd() }',
  '}));',
  ''
].join('\n');

// 嘴上说 ok，退出码却是 1（§6.1：非 0 退出码即失败）
const EXIT1_SRC = [
  "process.stdout.write(JSON.stringify({ status: 'ok', say: '嘴上说成功，退出码却是 1' }));",
  'process.exitCode = 1;',
  ''
].join('\n');

function setupFixture() {
  mkdirSync(SCRIPTS, { recursive: true });
  writeFileSync(path.join(SCRIPTS, `${FIXTURE}.mjs`), FIXTURE_SRC);
  writeFileSync(path.join(SCRIPTS, `${EXIT1}.mjs`), EXIT1_SRC);
}
function teardownFixture() {
  for (const n of FIXTURE_NAMES) rmSync(path.join(SCRIPTS, `${n}.mjs`), { force: true });
}

// 假 Agent：先把 stdin 收完再吐指定输出，模拟一个不守契约的外部命令（§6.2）。
// 子进程 cwd 是 HOME，所以命令里写相对路径，免得临时目录带空格被 split 拆开
function writeFakeAgent(name, body) {
  const file = path.join(HOME, `${name}.mjs`);
  writeFileSync(file, [
    "let raw = '';",
    'for await (const chunk of process.stdin) raw += chunk;',
    body,
    ''
  ].join('\n'));
  return { file, cmd: `node ${name}.mjs` };
}

// ── 把原则变成护栏（§2.5、§3、§16）──────────────────────────────────────

test('内核仓库不放沉淀：根下没有 tasks/、scripts/（§3）', () => {
  for (const dir of ['tasks', 'scripts']) {
    assert.equal(existsSync(path.join(ROOT, dir)), false, `${dir}/ 不该出现在内核仓库：沉淀放 HOME（AGENTFLOW_HOME）`);
  }
});

test('examples/ 是一个 HOME，示例任务不 import 内核（§5、§15）', () => {
  const dir = path.join(ROOT, 'examples', 'tasks');
  const tasks = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(tasks.length > 0, 'examples/tasks/ 里应至少有一个任务示例');
  for (const f of tasks) {
    const src = readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /from\s+['"](miworkflow|[^'"]*core\.mjs)['"]/,
      `${f} 不该 import 内核：原语由 run.mjs 传进来，业务项目里没有 package.json`);
  }
});

// ── 原语 ────────────────────────────────────────────────────────────────

test('script：返回结构里带人话 say', async () => {
  setupFixture();
  try {
    const runId = uniq();
    process.env.AGENTFLOW_TASK = 'unit';
    process.env.AGENTFLOW_RUN_ID = runId;

    const { script } = await import('../core.mjs');
    const r = await script(FIXTURE, { who: '测试' });

    assert.equal(r.status, 'ok');
    assert.match(r.say, /fixture 收到：测试/);
    assert.equal(path.resolve(r.data.cwd).toLowerCase(), HOME.toLowerCase(), '脚本子进程在 HOME 里跑（§3）');

    const [first] = rows(runId);
    assert.equal(first.primitive, 'script');
    assert.equal(first.say, 'fixture 收到：测试');
    assert.deepEqual(first.inputs, { who: '测试' }, '输入信息（args）也记一条，viewer 展开时看（§12）');
    assert.ok('gitSha' in first, '每条记录都带 gitSha（§12）');

    rmSync(logPath(runId), { force: true });
  } finally {
    teardownFixture();
  }
});

test('script：脚本不存在 → failed，不抛异常', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;

  const { script } = await import('../core.mjs');
  const r = await script('__no_such_script');

  assert.equal(r.status, 'failed');
  assert.equal(rows(runId)[0].status, 'failed');
  rmSync(logPath(runId), { force: true });
});

test('human：决定文件把 pending 变成 ok', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  process.env.AGENTFLOW_HUMAN = 'web';
  delete process.env.AGENTFLOW_YES;

  const { human } = await import('../core.mjs');
  const pending = human('测试审批', { timeoutMs: 8000 });

  // 等 pending 记录落盘，取出 seq
  let seq;
  for (let i = 0; i < 60 && seq == null; i++) {
    await sleep(50);
    if (!existsSync(logPath(runId))) continue;
    for (const r of rows(runId)) {
      if (r.primitive === 'human' && r.status === 'pending') seq = r.seq;
    }
  }
  assert.ok(seq, '应写入一条 pending 记录');

  const decideFile = path.join(LOGS, `${runId}.decide.${seq}.json`);
  writeFileSync(decideFile, JSON.stringify({ decision: 'ok', by: 'test' }));

  assert.equal((await pending).status, 'ok');

  const all = rows(runId);
  assert.equal(all.at(-1).status, 'ok');
  assert.equal(all.at(-1).ref, seq, '解决记录要指回 pending 的 seq');
  assert.equal(all[0].say, '⏸ 测试审批', 'pending 记录也带人话 say（§13.1）');

  rmSync(logPath(runId), { force: true });
  rmSync(decideFile, { force: true });
});

test('human：决定文件超时 → failed', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  process.env.AGENTFLOW_HUMAN = 'web';
  delete process.env.AGENTFLOW_YES;

  const { human } = await import('../core.mjs');
  const r = await human('没人搭理我', { timeoutMs: 300 });

  assert.equal(r.status, 'failed');
  assert.equal(rows(runId).at(-1).say, '没人搭理我 → 超时/失败');
  rmSync(logPath(runId), { force: true });
});

test('human：--yes 直接通过，不留 pending', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  process.env.AGENTFLOW_YES = '1';

  const { human } = await import('../core.mjs');
  const r = await human('CI 下的审批');

  assert.equal(r.status, 'ok');
  const all = rows(runId);
  assert.equal(all.length, 1);
  assert.notEqual(all[0].status, 'pending');

  delete process.env.AGENTFLOW_YES;
  rmSync(logPath(runId), { force: true });
});

test('agent：没配外部命令 → 明确 failed，不假装思考', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  delete process.env.AGENTFLOW_AGENT_CMD;
  delete process.env.AGENTFLOW_AGENT;

  const { agent } = await import('../core.mjs');
  const r = await agent('写一句结束语');

  assert.equal(r.status, 'failed');
  assert.equal(r.choice, 'agent_unavailable');
  assert.match(r.reason, /未配置 Agent：设 AGENTFLOW_AGENT/);
  assert.equal(rows(runId)[0].primitive, 'agent');
  assert.equal(rows(runId)[0].status, 'failed');
  rmSync(logPath(runId), { force: true });
});

test('agent：外部命令输出合契约 → 原样透传', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;

  const fake = writeFakeAgent('__test_agent_ok', [
    "process.stdout.write(JSON.stringify({ status: 'need_human', choice: 'ask_human', reason: '这事得人来拍板' }));"
  ].join('\n'));
  try {
    const { agent } = await import('../core.mjs');
    const r = await agent('随便干点什么', { cmd: fake.cmd });

    assert.equal(r.status, 'need_human');
    assert.equal(r.choice, 'ask_human');
    const all = rows(runId);
    assert.equal(all.at(-1).say, '这事得人来拍板', 'say 取 reason（§13.1）');
    assert.equal(all[0].status, 'running', '开跑前先写 running 行（§13.1）');
  } finally {
    rmSync(fake.file, { force: true });
    rmSync(logPath(runId), { force: true });
  }
});

test('agent：先写带 events 的 running 行，结束后写带 ref 的终态行（§13.1、§13.5）', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;

  const fake = writeFakeAgent('__test_agent_slow', [
    'await new Promise((r) => setTimeout(r, 400));',
    "process.stdout.write(JSON.stringify({ status: 'ok', choice: 'done', reason: '干完了' }));"
  ].join('\n'));
  try {
    const { agent } = await import('../core.mjs');
    const p = agent('把登录接口接好', { cmd: fake.cmd });

    // 卡住时：running 行已经落盘，且带 events，viewer 据此先把过程按钮亮出来
    let running;
    for (let i = 0; i < 60; i++) {
      await sleep(25);
      running = rows(runId).find((r) => r.primitive === 'agent' && r.status === 'running');
      if (running) break;
    }
    assert.ok(running, '动作结束前就应出现 running 行');
    assert.match(running.events, new RegExp(`^${runId}/agent-\\d+\\.events\\.jsonl$`), 'running 行提前带 events');
    assert.equal(running.say, 'Agent', 'running 的 say 取短名（没给 label 就回落 Agent），不把提示词当节点名（§13.1）');
    assert.equal(running.goal, '把登录接口接好', '提示词全文记在 goal 字段，viewer 展开「输入」时看（§12）');

    const r = await p;
    assert.equal(r.status, 'ok');
    const done = rows(runId).find((x) => x.primitive === 'agent' && x.status === 'ok');
    assert.ok(done, '结束后应写终态行');
    assert.equal(done.ref, running.seq, '终态行 ref 指回 running 行');
    assert.equal(done.events, running.events, '终态行沿用同一条过程文件');
    assert.equal(done.say, '干完了');
  } finally {
    rmSync(fake.file, { force: true });
    rmSync(logPath(runId), { force: true });
  }
});

test('agent：label 当节点名，goal 留全文（§13.1、§13.6）', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  const fake = writeFakeAgent('__test_agent_label', "process.stdout.write(JSON.stringify({ status: 'ok', choice: 'done', reason: '改完了' }));");
  try {
    const { agent } = await import('../core.mjs');
    await agent('一段很长的提示词\n第二行', { cmd: fake.cmd, label: '开发Agent' });
    const all = rows(runId).filter((r) => r.primitive === 'agent');
    assert.ok(all.every((r) => r.label === '开发Agent'), 'running / 终态两行都带 label');
    const running = all.find((r) => r.status === 'running');
    assert.equal(running.say, '开发Agent', '节点名是短名');
    assert.equal(running.goal, '一段很长的提示词\n第二行', '提示词全文进 goal');
    assert.equal(running.say.includes('一段很长'), false, 'say 不含提示词');
  } finally {
    rmSync(fake.file, { force: true });
    rmSync(logPath(runId), { force: true });
  }
});

test('agent：输出顶层 session 透传给任务、记进终态行，形状任意都不影响契约（§10）', async () => {
  const cases = [
    { out: { status: 'ok', choice: 'done', reason: '', session: 's-1' }, status: 'ok', session: 's-1' },
    { out: { status: 'ok', choice: 'done', reason: '', session: { id: 7, n: [1] } }, status: 'ok', session: { id: 7, n: [1] } },
    { out: { choice: 'done', session: 's-2' }, status: 'failed', session: 's-2' }
  ];
  for (const [i, c] of cases.entries()) {
    const runId = uniq();
    process.env.AGENTFLOW_TASK = 'unit';
    process.env.AGENTFLOW_RUN_ID = runId;
    const fake = writeFakeAgent(`__test_agent_session_${i}`, `process.stdout.write(${JSON.stringify(JSON.stringify(c.out))});`);
    try {
      const { agent } = await import('../core.mjs');
      const r = await agent('续着干', { cmd: fake.cmd });
      assert.equal(r.status, c.status, JSON.stringify(r));
      if (c.status === 'failed') assert.equal(r.choice, 'agent_bad_output', 'session 不能替缺了的 status 兜底');
      assert.deepEqual(r.session, c.session);
      assert.deepEqual(rows(runId).at(-1).session, c.session);
    } finally {
      rmSync(fake.file, { force: true });
      rmSync(logPath(runId), { force: true });
    }
  }
});

test('agent：输出没有 session → 返回值与日志都不带 session（§10）', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  const fake = writeFakeAgent('__test_agent_nosession', "process.stdout.write(JSON.stringify({ status: 'ok', choice: 'done', reason: '' }));");
  try {
    const { agent } = await import('../core.mjs');
    const r = await agent('随便', { cmd: fake.cmd });
    assert.deepEqual(Object.keys(r), ['status', 'choice', 'reason', 'data']);
    assert.ok(!('session' in rows(runId).at(-1)));
  } finally {
    rmSync(fake.file, { force: true });
    rmSync(logPath(runId), { force: true });
  }
});

test('agent：输出缺 status / choice → failed，不补默认值（§6.2）', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;

  const fake = writeFakeAgent('__test_agent_bad', "process.stdout.write(JSON.stringify({}));");
  try {
    const { agent } = await import('../core.mjs');
    const r = await agent('随便干点什么', { cmd: fake.cmd });

    assert.equal(r.status, 'failed');
    assert.equal(r.choice, 'agent_bad_output');
    assert.equal(rows(runId).at(-1).status, 'failed');
  } finally {
    rmSync(fake.file, { force: true });
    rmSync(logPath(runId), { force: true });
  }
});

test('script：dryRun 注入 args，脚本据此干跑（§6.1）', async () => {
  setupFixture();
  try {
    const runId = uniq();
    process.env.AGENTFLOW_TASK = 'unit';
    process.env.AGENTFLOW_RUN_ID = runId;

    const { script } = await import('../core.mjs');

    const viaOpts = await script(FIXTURE, { who: '干跑' }, { dryRun: true });
    assert.equal(viaOpts.status, 'ok');
    assert.equal(viaOpts.data.dryRun, true);
    assert.equal(viaOpts.data.who, '干跑');

    process.env.AGENTFLOW_DRY_RUN = '1';
    const viaEnv = await script(FIXTURE, { who: '环境变量' });
    assert.equal(viaEnv.data.dryRun, true, '--dry-run 落到 env 后同样生效');
    delete process.env.AGENTFLOW_DRY_RUN;

    const normal = await script(FIXTURE, { who: '正常跑' });
    assert.equal(normal.data.dryRun, undefined, '不干跑时不该多塞字段');

    rmSync(logPath(runId), { force: true });
  } finally {
    teardownFixture();
  }
});

test('script：stdout 合法 JSON 但退出码非 0 → failed（§6.1）', async () => {
  setupFixture();
  try {
    const runId = uniq();
    process.env.AGENTFLOW_TASK = 'unit';
    process.env.AGENTFLOW_RUN_ID = runId;

    const { script } = await import('../core.mjs');
    const r = await script(EXIT1);

    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'exit_1');
    assert.equal(rows(runId).at(-1).status, 'failed');

    rmSync(logPath(runId), { force: true });
  } finally {
    teardownFixture();
  }
});
