// 工单源接口 ticket_ready / ticket_view / ticket_mark 的契约测试（GitHub 实现，假 gh）。脚手架在 tests/support/github-template.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, issue, issueState, labelsOf, comments, runScript } from './support/github-template.mjs';

const keys = (o) => Object.keys(o).sort();

test('ticket_ready：入 {}，出 ready / blocked；工单号是字符串，引用是 #N；按优先级 → 工单号排序', () => {
  const s = setup({
    issues: [
      issue(1, { title: '前置' }),
      issue(3, { title: '低优先', labels: ['ready-for-agent', 'P3'] }),
      issue(5, { title: '被挡', body: '- [ ] #1\n- [x] #2', labels: ['ready-for-agent'] }),
      issue(8, { title: '在跑', labels: ['ready-for-agent', 'in-progress'] }),
      issue(9, { title: '高优先', labels: ['ready-for-agent', 'P0'] }),
      issue(10, { title: '依赖已关', body: '- [ ] #4', labels: ['ready-for-agent'] })
    ]
  });

  const r = runScript(s, 'ticket_ready', {});
  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(keys(r.data), ['blocked', 'ready']);
  assert.deepEqual(r.data.ready, [
    { id: '9', ref: '#9', title: '高优先', priority: 0 },
    { id: '10', ref: '#10', title: '依赖已关', priority: 2 },
    { id: '3', ref: '#3', title: '低优先', priority: 3 }
  ]);
  assert.equal(r.data.blocked.length, 1);
  const [b] = r.data.blocked;
  assert.deepEqual(keys(b), ['id', 'reason', 'ref']);
  assert.equal(b.id, '5');
  assert.equal(b.ref, '#5');
  assert.match(b.reason, /#1/, 'reason 写明被哪张单挡住');
  assert.doesNotMatch(b.reason, /#2/, '勾上的依赖不算');
});

test('ticket_view：入 { id }，出 { id, ref, title, text }；text 带正文与全部评论', () => {
  const s = setup({ issues: [issue(7, { title: '读我', body: '正文内容' })] });
  runScript(s, 'ticket_mark', { id: '7', action: 'failed', comment: '上次挂了' });

  const r = runScript(s, 'ticket_view', { id: '7' });
  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(keys(r.data), ['id', 'ref', 'text', 'title']);
  assert.equal(r.data.id, '7');
  assert.equal(r.data.ref, '#7');
  assert.equal(r.data.title, '读我');
  assert.match(r.data.text, /正文内容/);
  assert.match(r.data.text, /上次挂了/);

  assert.equal(runScript(s, 'ticket_view', {}).status, 'failed', '缺 id');
  assert.equal(runScript(s, 'ticket_view', { id: 'abc' }).status, 'failed', '工单号不对');
});

test('ticket_mark：入 { id, action, comment?, sha? }；四种 action 按 GitHub 规则落标签 / 评论 / 关单', () => {
  const s = setup({ issues: [1, 2, 3].map((n) => issue(n, { labels: ['ready-for-agent'] })) });

  const claimed = runScript(s, 'ticket_mark', { id: '1', action: 'claimed' });
  assert.equal(claimed.status, 'ok', claimed.error);
  assert.equal(claimed.data.id, '1');
  assert.equal(claimed.data.ref, '#1');
  assert.deepEqual(labelsOf(s, 1), ['ready-for-agent', 'in-progress']);

  assert.equal(runScript(s, 'ticket_mark', { id: '1', action: 'done', sha: 'abc123' }).status, 'ok');
  assert.equal(issueState(s, 1).state, 'CLOSED');
  assert.deepEqual(labelsOf(s, 1), []);
  assert.match(comments(issueState(s, 1)), /提交：abc123/);

  runScript(s, 'ticket_mark', { id: '2', action: 'claimed' });
  assert.equal(runScript(s, 'ticket_mark', { id: '2', action: 'unpushed', sha: 'def456' }).status, 'ok');
  assert.equal(issueState(s, 2).state, 'OPEN');
  assert.deepEqual(labelsOf(s, 2), ['ready-for-agent', 'in-progress'], '未推送不动标签');
  assert.match(comments(issueState(s, 2)), /未推送.*def456/);

  runScript(s, 'ticket_mark', { id: '3', action: 'claimed' });
  assert.equal(runScript(s, 'ticket_mark', { id: '3', action: 'failed', comment: '原因' }).status, 'ok');
  assert.deepEqual(labelsOf(s, 3), ['ready-for-agent', 'afk-failed']);
  assert.match(comments(issueState(s, 3)), /afk failed：原因/);

  assert.equal(runScript(s, 'ticket_mark', { id: '3', action: 'nope' }).status, 'failed');
  assert.equal(runScript(s, 'ticket_mark', { action: 'claimed' }).status, 'failed', '缺 id');
});
