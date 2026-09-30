// dev（GitHub 工单源）的端到端测试：推送 / PUSH=false / 不发布的收尾。脚手架在 tests/support/github-template.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setup, plan, issue, issueState, labelsOf, comments, cli, gitOut } from './support/github-template.mjs';

test('推送失败 → 不关单、整轮停下、本地提交保留', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })], remoteAhead: true });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '没问题' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 1, '推送失败应让整轮失败');
  assert.equal(issueState(s, 1).state, 'OPEN', '不关单');
  assert.ok(!labelsOf(s, 1).includes('afk-failed'), '推送失败不是 issue 失败，不贴 afk-failed');
  assert.ok(labelsOf(s, 1).includes('afk-claimed'), '留着 afk-claimed 提醒人处理');
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 /, '本地提交要保留');
  assert.match(r.stdout, /推送失败/);
});

test('PUSH=false → 本地提交保留、不关单、整轮停、退出码 1', () => {
  const s = setup({
    issues: [
      issue(1, { labels: ['ready-for-agent'] }),
      issue(2, { labels: ['ready-for-agent'] })
    ],
    push: false
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '没问题' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 1, '没发布就不算做完，整轮失败');
  assert.equal(issueState(s, 1).state, 'OPEN', '不关单');
  assert.ok(!labelsOf(s, 1).includes('afk-failed'), '故意不推不是 issue 失败，不贴 afk-failed');
  assert.ok(labelsOf(s, 1).includes('afk-claimed'), '留着 afk-claimed 提醒人处理');
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 /, '本地提交要保留');
  assert.match(comments(issueState(s, 1)), /本地提交（未推送）：/);
  assert.match(r.stdout, /未推送/);
  // 整轮停下：不再动下一个 issue
  assert.equal(issueState(s, 2).state, 'OPEN');
  assert.deepEqual(labelsOf(s, 2), ['ready-for-agent'], '排队中的 issue 不该被认领');
});

test('Agent no_change → 不重试、afk-failed、等人判断', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })] });
  plan(s, [{ choice: 'no_change', reason: '已经满足，无需改动' }]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 1);
  assert.ok(labelsOf(s, 1).includes('afk-failed'));
  assert.match(comments(issueState(s, 1)), /已经满足/);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init');
});
