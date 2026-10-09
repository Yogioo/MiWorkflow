// ticket_* 契约测试：同样的入参，每家工单源交回同样形状（TODO.md F2 的脚本表）。
// 各家特有的细节（图片、回读、gh 版本……）留在 template-github-tickets / template-tapd 里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './github-template.mjs';
import { claimLockFile } from '../../templates/_shared/scripts/_claim.mjs';

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

  contract('ticket_view：入 { id }，出 { id, ref, title, file, review, labels, claim }；快照在本次运行日志目录下，带正文与评论', {
    tickets: [{ key: 7, title: '读我', body: '正文内容' }, { key: 8, title: '要审', labels: ['needs-review'] }]
  }, (s) => {
    runScript(s, 'ticket_mark', { id: src.id(7), action: 'failed', comment: '上次挂了' });
    const r = runScript(s, 'ticket_view', { id: src.id(7) }, { AGENTFLOW_RUN_ID: 'run-1' });
    assert.equal(r.status, 'ok', r.say);
    assert.deepEqual(Object.keys(r.data).sort(), ['claim', 'file', 'id', 'labels', 'ref', 'review', 'title']);
    assert.deepEqual([r.data.id, r.data.ref, r.data.title, r.data.review], [src.id(7), src.ref(7), '读我', false]);
    assert.deepEqual(r.data.labels, ['afk-failed'], '出参给出机器标签（校验用）');
    assert.equal(r.data.claim, null, '没人接过的单：有效接单人是 null');
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

    const claimed = mark(1, { action: 'claimed', worker: 'wt1' });
    assert.equal(claimed.status, 'ok', claimed.say);
    assert.deepEqual(Object.keys(claimed.data).sort(), ['did', 'id', 'ref']);
    assert.deepEqual([claimed.data.id, claimed.data.ref], [src.id(1), src.ref(1)]);
    assert.deepEqual(view(1).labels, [...READY, 'afk-claimed']);
    assert.deepEqual(view(1).comments, ['[miworkflow:claim worker=wt1]'], '接单评论就是这一行标记，带工人名');

    assert.equal(mark(1, { action: 'done', sha: 'abc123' }).status, 'ok');
    assert.deepEqual(view(1).labels, src.deliveredLabels);
    assert.equal(view(1).closed, src.closes, 'GitHub / beads 关单，TAPD 不关单');
    assert.ok(view(1).comments.some((c) => c.includes('abc123')));

    mark(2, { action: 'claimed', worker: 'wt1' });
    assert.equal(mark(2, { action: 'unpushed', sha: 'def456' }).status, 'ok');
    assert.deepEqual(view(2).labels, [...READY, 'afk-claimed'], 'unpushed 保留认领');
    assert.ok(view(2).comments.some((c) => c.includes('def456')));

    mark(3, { action: 'claimed', worker: 'wt1' });
    assert.equal(mark(3, { action: 'failed', comment: '原因' }).status, 'ok');
    assert.deepEqual(view(3).labels, [...READY, 'afk-failed']);
    assert.ok(view(3).comments.some((c) => c.includes('原因')));

    mark(4, { action: 'claimed', worker: 'wt1' });
    assert.equal(mark(4, { action: 'released', comment: 'Agent 连接失败：socket hang up' }).status, 'ok');
    assert.deepEqual(view(4).labels, READY, 'released 摘认领、不贴失败、保留 ready');
    assert.equal(view(4).closed, false);
    assert.ok(view(4).comments.some((c) => c.includes('Agent 连接失败') && c.includes('socket hang up')));

    const dir = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-contract-'));
    writeFileSync(path.join(dir, 'comment.md'), '背包按品质排序\n\n提交：aaa1111');
    mark(5, { action: 'claimed', worker: 'wt1' });
    assert.equal(mark(5, { action: 'done', sha: 'aaa1111', commentFile: path.join(dir, 'comment.md') }).status, 'ok');
    assert.deepEqual(view(5).comments.at(-1), '[miworkflow:done]\n\n背包按品质排序\n\n提交：aaa1111', '只给 commentFile：评论就是回帖稿原文，最前面加状态标记');
    rmSync(dir, { recursive: true, force: true });

    const nope = mark(3, { action: 'nope' });
    assert.equal(nope.status, 'failed');
    assert.notEqual(nope.data?.transient, true, '参数错不算工单系统故障');
    assert.equal(runScript(s, 'ticket_mark', { action: 'claimed' }).status, 'failed', '缺 id');
  });

  contract('ticket_mark claimed：带工人名发接单评论；已被别人接走 / 锁在别人手里时什么都不写，持有锁的进程死了能接管', {
    tickets: [1, 2, 3].map((key) => ({ key, labels: READY }))
  }, (s, view) => {
    const mark = (key, input) => runScript(s, 'ticket_mark', { id: src.id(key), action: 'claimed', ...input });
    const lock = (key) => claimLockFile(s.root, src.ref(key));

    assert.equal(mark(1, { worker: 'wt1' }).status, 'ok');
    assert.equal(runScript(s, 'ticket_view', { id: src.id(1) }).data.claim, 'wt1', '有效接单人读得出来');

    const other = mark(1, { worker: 'wt2' });
    assert.equal(other.status, 'ok', other.say);
    assert.equal(other.data.claimed, false, '已被接走：没抢到');
    assert.match(other.data.reason, /wt1/);
    assert.deepEqual(view(1).comments, ['[miworkflow:claim worker=wt1]'], '抢输的不往工单上写任何东西');
    assert.deepEqual(view(1).labels, [...READY, 'afk-claimed']);

    // 锁在活着的进程手里（用测试进程自己的 pid）：不碰工单
    writeFileSync(lock(2), JSON.stringify({ pid: process.pid, worker: 'wt9' }));
    const busy = mark(2, { worker: 'wt2' });
    assert.equal(busy.data.claimed, false);
    assert.match(busy.data.reason, /wt9/);
    assert.deepEqual([view(2).comments, view(2).labels], [[], READY]);

    // 持锁进程死了：过期锁被接管，照常接单
    writeFileSync(lock(2), JSON.stringify({ pid: 999999999, worker: 'wt9' }));
    const taken = mark(2, { worker: 'wt2' });
    assert.equal(taken.status, 'ok', taken.say);
    assert.notEqual(taken.data.claimed, false, '过期锁能被接管');
    assert.deepEqual(view(2).comments, ['[miworkflow:claim worker=wt2]']);
    assert.deepEqual(view(2).labels, [...READY, 'afk-claimed']);
    assert.equal(existsSync(lock(2)), false, '接完就放锁');

    // 已经有机器标签的单：不认领（失败 / 交付 / 等合并都算）
    const bad = mark(3, { worker: 'wt1', comment: '' });
    assert.equal(bad.status, 'ok', '先接一张干净的，再拿有标签的试');
    const again = mark(3, { worker: 'wt1' });
    assert.equal(again.data.claimed, false);
    assert.match(again.data.reason, /afk-claimed|已经是我/);
  });

  contract('ticket_view claim：接单之后跟着释放 / 完成 / 失败就不算有效，unpushed 还算这个人占着', {
    tickets: [1, 2, 3, 4].map((key) => ({ key, labels: READY }))
  }, (s) => {
    const mark = (key, action, extra = {}) => runScript(s, 'ticket_mark', { id: src.id(key), action, ...extra });
    const claim = (key) => runScript(s, 'ticket_view', { id: src.id(key) }).data.claim;

    mark(1, 'claimed', { worker: 'wt1' });
    assert.equal(claim(1), 'wt1');
    mark(1, 'released', { comment: '重启了' });
    assert.equal(claim(1), null, '释放之后不算有效接单');

    mark(2, 'claimed', { worker: 'wt1' });
    mark(2, 'failed', { comment: '挂了' });
    assert.equal(claim(2), null, '失败之后不算有效接单');

    mark(3, 'claimed', { worker: 'wt1' });
    mark(3, 'unpushed', { sha: 'abc1234' });
    assert.equal(claim(3), 'wt1', 'unpushed：工单还归这个人（本地提交等人处理）');

    mark(4, 'claimed', { worker: 'wt1' });
    mark(4, 'done', { sha: 'abc1234' });
    assert.equal(claim(4), null, '完成之后不算有效接单');
  });

  contract('ticket_ready claims:true：只列认领中的单（工人重启后收拾自己没收尾的单用）', {
    tickets: [
      { key: 1, labels: READY },
      { key: 2, labels: READY },
      { key: 3, labels: ['afk-claimed'] }
    ]
  }, (s) => {
    runScript(s, 'ticket_mark', { id: src.id(1), action: 'claimed', worker: 'wt1' });
    const r = runScript(s, 'ticket_ready', { claims: true });
    assert.equal(r.status, 'ok', r.say);
    assert.deepEqual(Object.keys(r.data), ['claimed']);
    assert.deepEqual(r.data.claimed.map((t) => [t.id, t.ref, t.title]), [
      [src.id(1), src.ref(1), 'issue 1'],
      [src.id(3), src.ref(3), 'issue 3']
    ]);
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
