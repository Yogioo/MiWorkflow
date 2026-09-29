import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from '../guard.mjs';

// 端到端：真起一个 run.mjs，HOME 指向 examples/（§3、§15）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLES = path.join(ROOT, 'examples');

function runTask(task) {
  const runId = `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const env = { ...process.env, AGENTFLOW_HOME: EXAMPLES, AGENTFLOW_RUN_ID: runId };
  for (const k of ['AGENTFLOW_AGENT_CMD', 'AGENTFLOW_DRY_RUN', 'AGENTFLOW_TASK']) delete env[k];
  const r = spawnSync(process.execPath, [path.join(ROOT, 'run.mjs'), task, '--yes'], { cwd: ROOT, env, encoding: 'utf8' });
  const logFile = path.join(EXAMPLES, 'logs', `${runId}.jsonl`);
  let rows = [];
  try {
    rows = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  } catch { /* 拒跑或找不到任务时没有日志 */ }
  rmSync(logFile, { force: true });
  return { code: r.status, stderr: r.stderr, rows };
}

// 内核未审批时 run.mjs 按设计拒跑，跑通类用例测不了；那时 guard 测试已经是红的
const kernelClean = () => inspect().ok;

test('run：examples/ 作为 HOME 端到端跑通 demo', (t) => {
  if (!kernelClean()) return t.skip('内核未审批，run.mjs 会拒跑');
  const r = runTask('demo');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.rows.at(-1).primitive, 'run');
  assert.equal(r.rows.at(-1).status, 'ok');
  assert.ok(r.rows.some((x) => x.primitive === 'script' && x.status === 'ok'), 'HOME 里的 scripts/hello.mjs 应被调到');
});

test('run：HOME 里没有这个任务 → 报错并说清在哪找', (t) => {
  if (!kernelClean()) return t.skip('内核未审批，run.mjs 会拒跑');
  const r = runTask('__no_such_task');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /task not found/);
  assert.ok(r.stderr.includes(path.join(EXAMPLES, 'tasks')), '报错里要带上找的目录');
});

test('run：内核被改而未审批 → 拒跑（§14.1）', (t) => {
  if (kernelClean()) return t.skip('内核已审批，拒跑分支测不到');
  const r = runTask('demo');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /拒跑/);
  assert.equal(r.rows.length, 0, '拒跑时不该留下任何 trace');
});
