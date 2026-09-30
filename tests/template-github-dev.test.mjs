// dev（GitHub 工单源）的端到端测试：开发 → 提交 → 关单的正常路径。脚手架在 tests/support/github-template.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, plan, seen, issue, issueState, labelsOf, comments, cli, gitOut } from './support/github-template.mjs';

const SHARED_PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', '_shared', 'prompts');

test('共用提示词 dev / review / fix 存在且不含 GitHub 专属字样', () => {
  for (const f of ['dev.md', 'review.md', 'fix.md']) {
    const text = readFileSync(path.join(SHARED_PROMPTS, f), 'utf8');
    assert.doesNotMatch(text, /GitHub|\bgh\b|#N|#\d|Closes|issue/i, f);
    assert.match(text, /提交信息用：\{\{commit\}\}/, f);
  }
});

test('GitHub 下三段提示词里的提交信息与兜底提交一致', () => {
  const s = setup({
    issues: [issue(7, { title: '加个文件', labels: ['ready-for-agent'] })],
    verify: ['node', '-e', "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"],
    push: true
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '没问题' },
    { choice: 'fixed', reason: '补上了', file: { name: 'ok.txt', content: '1' } }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  const [dev, review, fix] = seen(s).map((x) => x.goal);
  assert.ok(dev.includes("提交信息用：`#7 加个文件`，正文写一行 `Closes #7`"), dev);
  assert.ok(review.includes('提交信息用：`#7 审查修正：<一句话>`'), review);
  assert.ok(fix.includes('提交信息用：`#7 验证不过修正：<一句话>`'), fix);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), '#7 加个文件');
  assert.equal(gitOut(['log', '-1', '--pretty=%b'], s.root), 'Closes #7');
});

test('成功：认领 → 开发 → 审查 → 提交 → 关单（且推送）', () => {
  const s = setup({ issues: [issue(1, { title: '加个文件', labels: ['ready-for-agent'] })], push: true });
  plan(s, [
    { choice: 'done', reason: '写好 note.txt 了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '看着没问题' }
  ]);

  const r = cli(s, ['dev']);
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

  const r = cli(s, ['dev']);
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

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 1).state, 'CLOSED');
  assert.ok(!/commit_failed/.test(comments(issueState(s, 1))), '不该有 commit_failed 评论');
  assert.equal(gitOut(['rev-list', '--count', 'HEAD'], s.root), '2', 'Agent 那笔就是这一轮的提交，不再造一笔');
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 加个文件/);
  assert.match(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), /^#1 加个文件/, '照样要推送');
});
