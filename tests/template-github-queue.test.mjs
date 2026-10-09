// dev（GitHub 工单源）的端到端测试：选队列、脏工作区、--dry-run。脚手架在 tests/support/github-template.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setup, plan, issue, issueState, labelsOf, comments, cli, gitOut, seen } from './support/github-template.mjs';

test('依赖挡住 → 不算就绪，不跑', () => {
  const s = setup({
    issues: [
      issue(1, { title: '前置', body: '先做这个' }),
      issue(2, { title: '被挡', body: '- [ ] #1' , labels: ['ready-for-agent'] })
    ]
  });
  plan(s, []);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /队列空/);
  assert.equal(issueState(s, 2).state, 'OPEN');
});

test('优先级 P0 比 issue 号靠前；--issue 点名不看标签和依赖', () => {
  const s = setup({
    issues: [
      issue(1, { labels: ['ready-for-agent', 'P3'] }),
      issue(9, { labels: ['ready-for-agent', 'P0'] })
    ],
    push: true
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'nine.txt', content: '1' } },
    { choice: 'clean', reason: 'ok' }
  ]);

  const r = cli(s, ['dev', '--max', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 9).state, 'CLOSED', 'P0 先做');
  assert.equal(issueState(s, 1).state, 'OPEN');

  // --issue 点名一个没贴 ready 的
  const s2 = setup({ issues: [issue(7, { labels: [] })], push: true });
  plan(s2, [
    { choice: 'done', reason: '做了', file: { name: 'seven.txt', content: '1' } },
    { choice: 'clean', reason: 'ok' }
  ]);
  const r2 = cli(s2, ['dev', '--issue', '7']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(issueState(s2, 7).state, 'CLOSED');
});

test('工作区不干净 → 整轮不跑', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })], dirty: true });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'x', content: '1' } }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /工作区有未提交改动/);
  assert.equal(issueState(s, 1).state, 'OPEN');
  assert.deepEqual(labelsOf(s, 1), ['ready-for-agent'], '一个 gh 调用都不该发生');
});

test('--dry-run → 只报会做哪个 issue，不叫 Agent、不改盘', () => {
  const s = setup({ issues: [issue(1, { title: '加个文件', labels: ['ready-for-agent'] })] });
  plan(s, []);

  const r = cli(s, ['dev', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /干跑/);
  assert.match(r.stdout, /#1/);
  assert.equal(issueState(s, 1).state, 'OPEN');
  assert.deepEqual(labelsOf(s, 1), ['ready-for-agent']);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init');
  assert.equal(gitOut(['status', '--porcelain'], s.root), '', '干跑不弄脏工作区');
});

test('--dry-run → 被依赖挡住的工单连同原因一起列出', () => {
  const s = setup({
    issues: [
      issue(1, { title: '前置' }),
      issue(2, { title: '被挡', body: '- [ ] #1', labels: ['ready-for-agent'] })
    ]
  });
  plan(s, []);

  const r = cli(s, ['dev', '--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /队列空/);
  assert.match(r.stdout, /被挡住 #2：.*#1/);
});

test('dev：队列空才记退避——外面套 while 反复单跑，第二轮不碰工单系统；--now 放行', () => {
  const s = setup({ issues: [] });
  plan(s, []);

  const first = cli(s, ['dev']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /队列空/, '第一轮照常查');

  const before = seen(s).length;
  const second = cli(s, ['dev']);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /还没到点/, '第二轮被上一轮记下的退避拦住');
  assert.equal(seen(s).length, before, '没到点：连 Agent 都不叫');

  const forced = cli(s, ['dev', '--now']);
  assert.equal(forced.code, 0, forced.stderr);
  assert.doesNotMatch(forced.stdout, /还没到点/, '--now 放行');
  assert.match(forced.stdout, /队列空/);
});

test('dev：上一轮出过事（有失败）就不记退避——下一轮照跑，不被人自己上一轮挡住', () => {
  const s = setup({ issues: [issue(1, { labels: ['ready-for-agent'] })] });
  plan(s, [{ status: 'need_human', choice: 'ask', reason: '要接口文档' }]);

  const bad = cli(s, ['dev']);
  assert.equal(bad.code, 1, '失败轮退出码非 0');

  const next = cli(s, ['dev']);
  assert.doesNotMatch(next.stdout, /还没到点/, '出过事不算「没事干」，不该记退避');
});
