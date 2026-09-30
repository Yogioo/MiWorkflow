// dev（GitHub 工单源）的端到端测试：失败回滚（含备份 ref）。脚手架在 tests/support/github-template.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setup, plan, issue, issueState, labelsOf, comments, cli, gitOut } from './support/github-template.mjs';

test('审查拒绝 → 回滚改动 + afk-failed + 评论', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })] });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'bad.txt', content: 'x' } },
    { choice: 'reject', reason: '方向根本错了' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 1);
  assert.equal(issueState(s, 1).state, 'OPEN', '失败不关单');
  assert.ok(!existsSync(path.join(s.root, 'bad.txt')), '回滚应删掉 Agent 写的文件');
  assert.ok(labelsOf(s, 1).includes('afk-failed'));
  assert.ok(!labelsOf(s, 1).includes('in-progress'), '失败要摘掉 in-progress');
  assert.ok(labelsOf(s, 1).includes('ready-for-agent'), '保留 ready，摘掉 afk-failed 后能重新入队');
  assert.match(comments(issueState(s, 1)), /方向根本错了/);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init', '不该有提交');
  assert.equal(gitOut(['for-each-ref', 'refs/afk-backup'], s.root), '', '没提交要丢时不该造备份 ref');
});

test('回滚要丢掉的提交 → 先备份成 ref 再回滚，评论里带上 ref', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })] });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'bad.txt', content: 'x' }, commit: '#1 做了' },
    { choice: 'reject', reason: '方向根本错了' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 1);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init', 'HEAD 回到起点');
  assert.ok(!existsSync(path.join(s.root, 'bad.txt')), '回滚应删掉 Agent 写的文件');

  const refs = gitOut(['for-each-ref', '--format=%(refname)', 'refs/afk-backup'], s.root).split('\n').filter(Boolean);
  assert.equal(refs.length, 1, '被回滚的提交要有一个备份 ref');
  assert.match(refs[0], /^refs\/afk-backup\//);
  assert.match(gitOut(['log', '-1', '--pretty=%s', refs[0]], s.root), /^#1 做了/, '备份 ref 指着被回滚那笔');
  assert.match(comments(issueState(s, 1)), /afk-backup/, '评论要写明备份 ref，人才能捞回来');
});

test('验证不过、超过 ROUNDS → 回滚 + afk-failed', () => {
  const s = setup({
    issues: [issue(1, { labels: ['ready-for-agent'] })],
    verify: ['node', '-e', 'process.exit(1)'],
    rounds: 1
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'a.txt', content: '1' } },
    { choice: 'clean', reason: '没问题' },
    { choice: 'fixed', reason: '改了' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 1);
  assert.ok(!existsSync(path.join(s.root, 'a.txt')), '回滚');
  assert.ok(labelsOf(s, 1).includes('afk-failed'));
  assert.equal(issueState(s, 1).state, 'OPEN');
});

test('Agent need_human → 回滚 + 把问题贴成评论 + afk-failed', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })] });
  plan(s, [{ status: 'need_human', choice: 'ask', reason: '请补充接口文档' }]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 1);
  assert.ok(labelsOf(s, 1).includes('afk-failed'));
  assert.match(comments(issueState(s, 1)), /请补充接口文档/);
});
