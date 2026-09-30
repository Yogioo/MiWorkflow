// ticket_* 契约测试：同样的入参，每家工单源交回同样形状（TODO.md F2 的脚本表）。
// 各家特有的细节（图片、回读、gh 版本……）留在 template-github-tickets / template-tapd 里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './github-template.mjs';

const READY = ['ready-for-agent'];

export function defineTicketContract(src) {
  const contract = (name, opts, fn) => test(`[${src.name}] ${name}`, async () => {
    const s = await src.open(opts);
    try {
      await fn(s, (key) => src.view(s, key));
    } finally {
      await s.close();
    }
  });

  contract('ticket_ready：入 {}，出 { ready: [{ id, ref, title, priority }], blocked: [{ id, ref, reason }] }', {
    tickets: [
      { key: 1, title: '一', labels: READY },
      { key: 2, title: '二', labels: READY },
      { key: 3, title: '没排队' },
      { key: 4, title: '被挡住', labels: READY, deps: [3] },
      { key: 5, title: '认领中', labels: [...READY, 'afk-claimed'] },
      { key: 6, title: '失败过', labels: [...READY, 'afk-failed'] }
    ]
  }, (s) => {
    const r = runScript(s, 'ticket_ready', {});
    assert.equal(r.status, 'ok', r.say);
    assert.deepEqual(r.data.ready.map((t) => t.id), [src.id(1), src.id(2)], '按工单号排序、带机器标签的不入队');
    for (const t of r.data.ready) {
      assert.deepEqual(Object.keys(t).sort(), ['id', 'priority', 'ref', 'title']);
      assert.equal(typeof t.id, 'string');
      assert.equal(typeof t.priority, 'number');
    }
    assert.deepEqual(r.data.ready.map((t) => [t.ref, t.title]), [[src.ref(1), '一'], [src.ref(2), '二']]);
    assert.deepEqual(r.data.blocked.map((t) => [t.id, t.ref]), [[src.id(4), src.ref(4)]]);
    assert.ok(r.data.blocked[0].reason.includes(src.ref(3)), r.data.blocked[0].reason);
  });

  contract('ticket_view：入 { id }，出 { id, ref, title, file, review }；快照在本次运行日志目录下，带正文与评论', {
    tickets: [{ key: 7, title: '读我', body: '正文内容' }, { key: 8, title: '要审', labels: ['needs-review'] }]
  }, (s) => {
    runScript(s, 'ticket_mark', { id: src.id(7), action: 'failed', comment: '上次挂了' });
    const r = runScript(s, 'ticket_view', { id: src.id(7) }, { AGENTFLOW_RUN_ID: 'run-1' });
    assert.equal(r.status, 'ok', r.say);
    assert.deepEqual(Object.keys(r.data).sort(), ['file', 'id', 'ref', 'review', 'title']);
    assert.deepEqual([r.data.id, r.data.ref, r.data.title, r.data.review], [src.id(7), src.ref(7), '读我', false]);
    assert.match(r.data.file, new RegExp(`[\\\\/]logs[\\\\/]run-1[\\\\/]tickets[\\\\/]${src.id(7)}[\\\\/]ticket\\.md$`));
    const md = readFileSync(r.data.file, 'utf8');
    assert.ok(md.includes('读我') && md.includes('正文内容') && md.includes('上次挂了'), md);
    assert.equal(runScript(s, 'ticket_view', {}).status, 'failed', '缺 id');

    const review = runScript(s, 'ticket_view', { id: src.id(8) });
    assert.equal(review.status, 'ok', review.say);
    assert.equal(review.data.review, true, '贴了要审查标签就该是 true');
  });

  contract('ticket_mark：入 { id, action, comment?, commentFile?, sha? }，出 { did, id, ref }；五种 action 的机器标签一致', {
    tickets: [1, 2, 3, 4, 5].map((key) => ({ key, labels: READY }))
  }, (s, view) => {
    const mark = (key, input) => runScript(s, 'ticket_mark', { id: src.id(key), ...input });

    const claimed = mark(1, { action: 'claimed' });
    assert.equal(claimed.status, 'ok', claimed.say);
    assert.deepEqual(Object.keys(claimed.data).sort(), ['did', 'id', 'ref']);
    assert.deepEqual([claimed.data.id, claimed.data.ref], [src.id(1), src.ref(1)]);
    assert.deepEqual(view(1).labels, [...READY, 'afk-claimed']);

    assert.equal(mark(1, { action: 'done', sha: 'abc123' }).status, 'ok');
    assert.deepEqual(view(1).labels, src.deliveredLabels);
    assert.equal(view(1).closed, src.name === 'github', 'GitHub 关单，TAPD 不关单');
    assert.ok(view(1).comments.some((c) => c.includes('abc123')));

    mark(2, { action: 'claimed' });
    assert.equal(mark(2, { action: 'unpushed', sha: 'def456' }).status, 'ok');
    assert.deepEqual(view(2).labels, [...READY, 'afk-claimed'], 'unpushed 保留认领');
    assert.ok(view(2).comments.some((c) => c.includes('def456')));

    mark(3, { action: 'claimed' });
    assert.equal(mark(3, { action: 'failed', comment: '原因' }).status, 'ok');
    assert.deepEqual(view(3).labels, [...READY, 'afk-failed']);
    assert.ok(view(3).comments.some((c) => c.includes('原因')));

    mark(4, { action: 'claimed' });
    assert.equal(mark(4, { action: 'released', comment: 'Agent 连接失败：socket hang up' }).status, 'ok');
    assert.deepEqual(view(4).labels, READY, 'released 摘认领、不贴失败、保留 ready');
    assert.equal(view(4).closed, false);
    assert.ok(view(4).comments.some((c) => c.includes('Agent 连接失败') && c.includes('socket hang up')));

    const dir = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-contract-'));
    writeFileSync(path.join(dir, 'comment.md'), '背包按品质排序\n\n提交：aaa1111');
    mark(5, { action: 'claimed' });
    assert.equal(mark(5, { action: 'done', sha: 'aaa1111', commentFile: path.join(dir, 'comment.md') }).status, 'ok');
    assert.deepEqual(view(5).comments, ['背包按品质排序\n\n提交：aaa1111'], '只给 commentFile：评论就是回帖稿原文，不加开头');
    rmSync(dir, { recursive: true, force: true });

    const nope = mark(3, { action: 'nope' });
    assert.equal(nope.status, 'failed');
    assert.notEqual(nope.data?.transient, true, '参数错不算工单系统故障');
    assert.equal(runScript(s, 'ticket_mark', { action: 'claimed' }).status, 'failed', '缺 id');
  });

  contract('工单系统一直 5xx：ticket_ready / ticket_view / ticket_mark 出 failed + data.transient', {
    tickets: [{ key: 1, labels: READY }]
  }, (s) => {
    src.down(s);
    for (const [name, input] of [
      ['ticket_ready', {}],
      ['ticket_view', { id: src.id(1) }],
      ['ticket_mark', { id: src.id(1), action: 'claimed' }],
      ['ticket_mark', { id: src.id(1), action: 'done', sha: 'abc1234' }]
    ]) {
      const r = runScript(s, name, input);
      assert.equal(r.status, 'failed', `${name} ${JSON.stringify(input)}`);
      assert.equal(r.data?.transient, true, `${name}：${r.error}`);
    }
  });
}
