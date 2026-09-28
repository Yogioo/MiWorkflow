import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGS = path.join(ROOT, 'logs');
const TASKS = path.join(ROOT, 'tasks');
const SCRIPTS = path.join(ROOT, 'scripts');
const FIXTURE = '__test_fixture';

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
  '  data: args',
  '}));',
  ''
].join('\n');

function setupFixture() {
  mkdirSync(SCRIPTS, { recursive: true });
  writeFileSync(path.join(SCRIPTS, `${FIXTURE}.mjs`), FIXTURE_SRC);
}
function teardownFixture() {
  rmSync(path.join(SCRIPTS, `${FIXTURE}.mjs`), { force: true });
}

// ── 把原则变成护栏（§2.5、§3、§16）──────────────────────────────────────

test('tasks/：仓库不预置任何具体任务', () => {
  const strays = existsSync(TASKS) ? readdirSync(TASKS).filter((f) => f.endsWith('.mjs')) : [];
  assert.deepEqual(strays, [], 'tasks/ 应初始为空，示例只在 examples/（§3、§15）');
});

test('scripts/：仓库不预置任何具体脚本', () => {
  const strays = existsSync(SCRIPTS)
    ? readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs') && f !== `${FIXTURE}.mjs`)
    : [];
  assert.deepEqual(strays, [], 'scripts/ 应初始为空，示例只在 examples/（§3、§15）');
});

test('tasks/ 与 examples/ 的示例不重名，且示例任务能直接复制过去用', () => {
  const examples = readdirSync(path.join(ROOT, 'examples'));
  const taskExamples = examples.filter((f) => f.endsWith('.task.mjs'));
  assert.ok(taskExamples.length > 0, 'examples/ 里应至少有一个任务示例');
  for (const f of taskExamples) {
    const src = readFileSync(path.join(ROOT, 'examples', f), 'utf8');
    // examples/ 与 tasks/ 同在根目录下一层，所以 import 路径复制后不用改（§15）
    assert.match(src, /from '\.\.\/core\.mjs'/, `${f} 必须用 '../core.mjs'，否则复制到 tasks/ 会断`);
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

    const [first] = rows(runId);
    assert.equal(first.primitive, 'script');
    assert.equal(first.say, 'fixture 收到：测试');
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

test('agent：没配外部命令 → 明确 stub，不假装思考', async () => {
  const runId = uniq();
  process.env.AGENTFLOW_TASK = 'unit';
  process.env.AGENTFLOW_RUN_ID = runId;
  delete process.env.AGENTFLOW_AGENT_CMD;

  const { agent } = await import('../core.mjs');
  const r = await agent('写一句结束语');

  assert.equal(r.status, 'ok');
  assert.match(r.reason, /未配置 AGENTFLOW_AGENT_CMD/);
  assert.equal(rows(runId)[0].primitive, 'agent');
  rmSync(logPath(runId), { force: true });
});
