// github_dev 模板的端到端测试：开发 → 提交 → 关单的正常路径。脚手架在 tests/support/github-template.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setup, plan, issue, issueState, labelsOf, comments, cli, gitOut } from './support/github-template.mjs';

test('成功：认领 → 开发 → 审查 → 提交 → 关单（且推送）', () => {
  const s = setup({ issues: [issue(1, { title: '加个文件', labels: ['ready-for-agent'] })], push: true });
  plan(s, [
    { choice: 'done', reason: '写好 note.txt 了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '看着没问题' }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 1).state, 'CLOSED');
  assert.deepEqual(labelsOf(s, 1), [], 'ready 与 in-progress 都要摘掉');
  assert.match(comments(issueState(s, 1)), /提交：/);
  assert.ok(existsSync(path.join(s.root, 'note.txt')));
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 加个文件/);
  assert.equal(gitOut(['status', '--porcelain'], s.root), '', '提交后工作区应干净');
  // 远端也拿到了这个提交
  assert.match(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), /^#1 加个文件/);
});

test('验证配了且能过 → 正常提交关单', () => {
  const s = setup({
    issues: [issue(2, { labels: ['ready-for-agent'] })],
    verify: ['node', '-e', 'process.exit(0)'],
    push: true
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'ok.txt', content: '1' } },
    { choice: 'clean', reason: '没问题' }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 2).state, 'CLOSED');
});

test('Agent 自己先提交了 → 不判失败，照常推送关单', () => {
  const s = setup({ issues: [issue(1, { title: '加个文件', labels: ['ready-for-agent'] })], push: true });
  plan(s, [
    {
      choice: 'done',
      reason: '写好并提交了',
      file: { name: 'note.txt', content: 'hi' },
      commit: '#1 加个文件'
    },
    { choice: 'clean', reason: '看着没问题' }
  ]);

  const r = cli(s, ['github_dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 1).state, 'CLOSED');
  assert.ok(!/commit_failed/.test(comments(issueState(s, 1))), '不该有 commit_failed 评论');
  assert.equal(gitOut(['rev-list', '--count', 'HEAD'], s.root), '2', 'Agent 那笔就是这一轮的提交，不再造一笔');
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 加个文件/);
  assert.match(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), /^#1 加个文件/, '照样要推送');
});
