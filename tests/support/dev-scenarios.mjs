// 开发流程端到端场景：同一套场景对每家假工单源各跑一遍（tests/dev-<工单源>.test.mjs 各注册一次）。
// 断言只在「完成」的含义上按工单源分支，其余共用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { plan, seen, cli, gitOut } from './github-template.mjs';

const READY = ['ready-for-agent'];
const DONE_STEPS = (file = 'note.txt') => [
  { choice: 'done', reason: '做完', file: { name: file, content: 'hi' } },
  { choice: 'clean', reason: '没问题' }
];

export function defineDevScenarios(src) {
  const scenario = (name, opts, fn) => test(`[${src.name}] ${name}`, async () => {
    const s = await src.open(opts);
    try {
      await fn(s, (key) => src.view(s, key));
    } finally {
      await s.close();
    }
  });

  const assertDelivered = (t) => {
    assert.equal(t.closed, src.name === 'github', 'GitHub 关单，TAPD 不关单');
    if (src.name === 'tapd') assert.equal(t.status, 'open', 'TAPD 完成不改状态');
    assert.deepEqual(t.labels, src.deliveredLabels);
  };
  const assertFailed = (t) => {
    assert.equal(t.closed, false, '失败不关单');
    assert.ok(t.labels.includes('afk-failed'));
    assert.ok(!t.labels.includes('afk-claimed'), '失败要摘掉 afk-claimed');
    assert.ok(t.labels.includes('ready-for-agent'), '保留 ready');
  };

  scenario('成功完成：开发 → 审查 → 验证 → 提交 → 推送 → 标记完成', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true
  }, (s, view) => {
    plan(s, DONE_STEPS());
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assertDelivered(view(1));
    const sha = gitOut(['rev-parse', 'HEAD'], s.root);
    assert.ok(view(1).comments.some((c) => c.includes(sha.slice(0, 7))), '完成评论带提交号');
    assert.ok(existsSync(path.join(s.root, 'note.txt')));
    const subject = gitOut(['log', '-1', '--pretty=%s'], s.root);
    assert.ok(subject.startsWith(src.commitPrefix(1)) && subject.endsWith('加个文件'), subject);
    assert.equal(gitOut(['status', '--porcelain'], s.root), '');
    assert.equal(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), subject, '远端也拿到');
    for (const c of seen(s)) assert.match(c.ticket, new RegExp(`[\\\\/]tickets[\\\\/]${src.id(1)}[\\\\/]ticket\\.md$`));
  });

  scenario('审查拒绝 → 回滚 + afk-failed + 评论', { tickets: [{ key: 1, labels: READY }] }, (s, view) => {
    plan(s, [
      { choice: 'done', reason: '做完', file: { name: 'bad.txt', content: 'x' } },
      { choice: 'reject', reason: '改错了地方' }
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assertFailed(view(1));
    assert.ok(view(1).comments.some((c) => c.includes('改错了地方')));
    assert.ok(!existsSync(path.join(s.root, 'bad.txt')), '回滚删掉 Agent 写的文件');
    assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init');
    assert.equal(gitOut(['for-each-ref', 'refs/afk-backup'], s.root), '', '没提交要丢时不造备份 ref');
  });

  scenario('验证超过 ROUNDS → 回滚 + afk-failed', {
    tickets: [{ key: 1, labels: READY }], verify: ['node', '-e', 'process.exit(1)'], rounds: 1
  }, (s, view) => {
    plan(s, [...DONE_STEPS('a.txt'), { choice: 'fixed', reason: '修了' }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assertFailed(view(1));
    assert.ok(!existsSync(path.join(s.root, 'a.txt')));
  });

  scenario('Agent need_human → 回滚 + 评论带问题 + afk-failed', { tickets: [{ key: 1, labels: READY }] }, (s, view) => {
    plan(s, [{ status: 'need_human', choice: 'ask', reason: '请补充接口文档' }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assertFailed(view(1));
    assert.ok(view(1).comments.some((c) => c.includes('请补充接口文档')));
  });

  scenario('Agent no_change → 按失败处理、不提交', { tickets: [{ key: 1, labels: READY }] }, (s, view) => {
    plan(s, [{ choice: 'no_change', reason: '已经满足，无需改动' }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assertFailed(view(1));
    assert.ok(view(1).comments.some((c) => c.includes('已经满足')));
    assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init');
  });

  scenario('推送失败 → 不标完成、不算失败，留 afk-claimed 等人', {
    tickets: [{ key: 1, labels: READY }], remoteAhead: true
  }, (s, view) => {
    plan(s, DONE_STEPS());
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    const t = view(1);
    assert.equal(t.closed, false);
    assert.ok(!t.labels.includes('afk-delivered') && !t.labels.includes('afk-failed'));
    assert.ok(t.labels.includes('afk-claimed'));
    assert.ok(gitOut(['log', '-1', '--pretty=%s'], s.root).startsWith(src.commitPrefix(1)), '本地提交保留');
  });

  scenario('PUSH = false → 本地提交、评论未推送、整轮停下', {
    tickets: [{ key: 1, labels: READY }, { key: 2, labels: READY }], push: false
  }, (s, view) => {
    plan(s, DONE_STEPS());
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    const t = view(1);
    assert.equal(t.closed, false);
    assert.ok(!t.labels.includes('afk-failed'));
    assert.ok(t.labels.includes('afk-claimed'));
    assert.ok(t.comments.some((c) => c.includes('未推送')));
    assert.ok(gitOut(['log', '-1', '--pretty=%s'], s.root).startsWith(src.commitPrefix(1)));
    assert.deepEqual(view(2).labels, READY, '排队的工单不碰');
  });

  scenario('依赖挡住 → 不认领、不调 Agent；--dry-run 列出挡住原因', {
    tickets: [{ key: 1, title: '前置' }, { key: 2, title: '后续', labels: READY, deps: [1] }]
  }, (s, view) => {
    plan(s, []);
    const dry = cli(s, ['dev', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.ok(dry.stdout.includes(src.ref(2)) && dry.stdout.includes(src.ref(1)), dry.stdout);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen(s), []);
    assert.deepEqual(view(2).labels, READY);
  });

  scenario('点名 --issue：不看 ready 标签照样做', { tickets: [{ key: 7 }, { key: 8, labels: READY }], push: true }, (s, view) => {
    plan(s, DONE_STEPS('seven.txt'));
    const r = cli(s, ['dev', '--issue', src.id(7)]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(view(7).closed, src.name === 'github');
    assert.ok(view(7).labels.includes('afk-delivered'));
    assert.deepEqual(view(8).labels, READY, '没点名的不碰');
  });

  scenario('工作区不干净 → 不动工单', { tickets: [{ key: 1, labels: READY }], dirty: true }, (s, view) => {
    plan(s, DONE_STEPS('x'));
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.deepEqual(seen(s), []);
    assert.deepEqual(view(1).labels, READY);
    assert.deepEqual(view(1).comments, []);
  });

  scenario('回滚要丢掉提交 → 先备份成 ref，评论写明', { tickets: [{ key: 1, labels: READY }] }, (s, view) => {
    plan(s, [
      { choice: 'done', reason: '做完', file: { name: 'bad.txt', content: 'x' }, commit: `${src.commitPrefix(1)}坏提交` },
      { choice: 'reject', reason: '改错了地方' }
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init');
    const refs = gitOut(['for-each-ref', '--format=%(refname)', 'refs/afk-backup'], s.root).split('\n').filter(Boolean);
    assert.equal(refs.length, 1);
    assert.ok(gitOut(['log', '-1', '--pretty=%s', refs[0]], s.root).endsWith('坏提交'));
    assert.ok(view(1).comments.some((c) => c.includes('afk-backup')));
  });

  scenario('回帖稿带进失败评论：一句话在前、回帖稿在后', { tickets: [{ key: 1, labels: READY }] }, (s, view) => {
    plan(s, [{ status: 'need_human', choice: 'ask', reason: '要接口文档', reply: '## 问题\n\n接口文档在哪？' }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    const last = seen(s).at(-1);
    assert.equal(path.basename(last.reply), 'reply-1.md');
    assert.equal(path.dirname(last.reply), path.dirname(last.ticket));
    const [c] = view(1).comments;
    assert.ok(c.indexOf('要接口文档') >= 0 && c.indexOf('要接口文档') < c.indexOf('## 问题'), c);
    assert.ok(c.includes('接口文档在哪？'), c);
  });
}
