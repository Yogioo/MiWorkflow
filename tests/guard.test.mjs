import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCore, inspect, loadLock } from '../guard.mjs';

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

test('内核护栏：可写面不算内核，Agent 沉淀不必审批', () => {
  const files = Object.keys(computeCore());
  for (const f of files) {
    assert.ok(
      !/^(tasks|scripts|logs|examples)\//.test(f),
      `${f} 在可写面里，不该被当成内核（§16：内容可沉淀）`
    );
  }
});

test('内核护栏：日志不进内核清单（logs/ 是本地运行产物）', () => {
  const files = Object.keys(computeCore());
  assert.equal(files.filter((f) => f.startsWith('logs/')).length, 0);
});
