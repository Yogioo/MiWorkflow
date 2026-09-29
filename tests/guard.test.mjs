import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { computeCore, inspect, loadLock, ROOT } from '../guard.mjs';

// ── 把「不改内核」从约定变成机制（§14.1、§17 路线 9）────────────────────
//
// 这一条是墙：改了内核而没跑 approve 重新固化，node --test 就红。
// 而「测试通过」是进化闭环的第 3 步，所以未审批的内核改动卡在门口。

function hint(diff) {
  const parts = [];
  if (diff.changed.length) parts.push(`改了 ${diff.changed.join('、')}`);
  if (diff.added.length) parts.push(`新增 ${diff.added.join('、')}`);
  if (diff.removed.length) parts.push(`删除 ${diff.removed.join('、')}`);
  return parts.join('；');
}

test('内核护栏：core.lock.json 存在，且带人写的理由', () => {
  const lock = loadLock();
  assert.ok(lock, '缺 core.lock.json —— 内核从未被审批。请在终端跑：node guard.mjs approve --reason "..."');
  assert.equal(lock.approvedBy, 'human', '内核固化必须署名 human（§14.1）');
  assert.ok(lock.reason && lock.reason.trim(), '固化记录必须带理由，理由就是审计线索');
  assert.ok(lock.files?.['core.mjs'], '内核清单必须含 core.mjs');
  assert.ok(lock.files?.['run.mjs'], '内核清单必须含 run.mjs（唯一入口）');
  assert.ok(lock.files?.['guard.mjs'], '护栏自己也算内核，不能改自己绕过去');
});

test('内核护栏：内核与固化记录一致', () => {
  const r = inspect();
  if (r.reason === 'no_lock') assert.fail('缺 core.lock.json：node guard.mjs approve --reason "..."');
  assert.equal(
    r.reason,
    'clean',
    `内核被改动但未审批：${hint(r.diff)}\n请在终端跑：node guard.mjs approve --reason "为什么改内核"`
  );
});

test('内核护栏：可写面不算内核', () => {
  const files = Object.keys(computeCore());
  for (const f of files) {
    assert.ok(!/^(logs|examples)\//.test(f), `${f} 在可写面里，不该被当成内核（§14.1）`);
  }
});

// 业务仓库经 npm 装内核（git 依赖也是先 pack 再解包，§3），装进去的那份必须一个内核文件都不少，
// 否则 guard 在那边判脏、run.mjs 拒跑
test('内核护栏：内核清单里的文件都会被 npm pack 带上', (t) => {
  const r = spawnSync('npm pack --dry-run --json', { cwd: ROOT, encoding: 'utf8', shell: true });
  if (r.status !== 0) return t.skip(`npm pack 跑不起来：${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
  const packed = new Set(JSON.parse(r.stdout)[0].files.map((f) => f.path));
  const missing = Object.keys(computeCore()).filter((f) => !packed.has(f));
  assert.deepEqual(missing, [], `这些内核文件不会进 npm 包：${missing.join('、')}`);
});

test('内核护栏：日志不进内核清单（logs/ 是本地运行产物）', () => {
  const files = Object.keys(computeCore());
  assert.equal(files.filter((f) => f.startsWith('logs/')).length, 0);
});
