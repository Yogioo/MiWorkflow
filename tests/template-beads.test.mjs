// beads 工单源特有的细节（共用契约在 tickets-contract-beads、端到端在 dev-beads）：
// 入队只认 open、优先级 0~4、依赖类型、父单当容器、状态跟着标签走、评论走文件、退避重试、--actor。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, runScript } from './support/github-template.mjs';
import { bdEnv, bdIssue, readBdState, writeBdState } from './support/bd-fakes.mjs';

const READY = ['ready-for-agent'];

function open(issues, opts = {}) {
  const s = setup({ source: 'beads', ...opts });
  s.bdFile = path.join(s.base, 'bd-state.json');
  writeBdState(s.bdFile, { issues });
  Object.assign(s.env, bdEnv(s.bdFile));
  return s;
}
const state = (s) => readBdState(s.bdFile);
const issueOf = (s, id) => state(s).issues.find((i) => i.id === id);
const calls = (s) => state(s).calls;

test('[beads] ticket_ready：只认 open；优先级 0 最急；blocks 前置关单或贴 delivered 才满足，related 不挡；父单有没做完的子单进 blocked', () => {
  const s = open([
    bdIssue('demo-1', { labels: READY, priority: 2 }),
    bdIssue('demo-2', { labels: READY, priority: 0 }),
    bdIssue('demo-3', { labels: READY, status: 'in_progress' }),
    bdIssue('demo-4', { labels: READY, status: 'deferred' }),
    bdIssue('demo-5', { labels: READY, deps: ['demo-gone'] }),
    bdIssue('demo-6', { labels: ['afk-delivered'] }),
    bdIssue('demo-7', { labels: READY, deps: ['demo-6'] }),
    bdIssue('demo-8', { labels: READY, priority: 9, dependencies: [{ depends_on_id: 'demo-1', type: 'related' }] }),
    bdIssue('demo-9', { labels: READY, deps: ['demo-1'] }),
    bdIssue('demo-10', { labels: READY }),
    bdIssue('demo-10.1', { labels: READY, parent: 'demo-10' }),
    bdIssue('demo-11', { labels: READY, status: 'closed' })
  ]);
  const r = runScript(s, 'ticket_ready', {});
  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(r.data.ready.map((t) => [t.id, t.priority]), [
    ['demo-2', 0], ['demo-1', 2], ['demo-5', 2], ['demo-7', 2], ['demo-8', 2], ['demo-10.1', 2]
  ], '优先级 → 工单号（数字按大小）；前置已关（不在 list 里）/ 贴了 delivered 都算满足；不认识的优先级当 2');
  assert.deepEqual(r.data.blocked, [
    { id: 'demo-9', ref: 'demo-9', reason: '被 demo-1 挡住（未完成）' },
    { id: 'demo-10', ref: 'demo-10', reason: '还有子单没做完：demo-10.1' }
  ]);
  assert.deepEqual(calls(s), [['list', '--limit', '0', '--json']], 'bd list 缺省只给 50 条，要 --limit 0');
});

test('[beads] ticket_mark：状态跟着标签走——认领 in_progress，失败 / 释放回 open，完成 bd close 并记提交号', () => {
  const s = open([1, 2, 3].map((k) => bdIssue(`demo-${k}`, { labels: READY })));
  const mark = (id, input) => runScript(s, 'ticket_mark', { id, ...input });

  for (const id of ['demo-1', 'demo-2', 'demo-3']) assert.equal(mark(id, { action: 'claimed' }).status, 'ok');
  assert.deepEqual(['demo-1', 'demo-2', 'demo-3'].map((id) => issueOf(s, id).status), ['in_progress', 'in_progress', 'in_progress']);

  mark('demo-1', { action: 'done', sha: 'abc1234' });
  assert.equal(issueOf(s, 'demo-1').status, 'closed');
  assert.match(issueOf(s, 'demo-1').close_reason, /abc1234/);
  mark('demo-2', { action: 'failed', comment: '挂了' });
  assert.equal(issueOf(s, 'demo-2').status, 'open');
  mark('demo-3', { action: 'released' });
  assert.equal(issueOf(s, 'demo-3').status, 'open');
  assert.deepEqual(issueOf(s, 'demo-3').comments.map((c) => c.text), ['Agent 连接失败，已回滚并释放，下轮重做']);
});

test('[beads] ticket_mark：评论经 bd comments add -f 发，多行原样；回帖稿里的本地图片换成绝对路径，网址不动', () => {
  const s = open([bdIssue('demo-1', { labels: READY })]);
  const dir = path.join(s.base, 'reply');
  mkdirSync(path.join(dir, 'images'), { recursive: true });
  writeFileSync(path.join(dir, 'reply-1.md'), '改了背包。\n\n![截图](images/1.png)\n<img src="images/2.png" alt="x">\n![外链](https://example.com/a.png)\n');
  const r = runScript(s, 'ticket_mark', { id: 'demo-1', action: 'failed', comment: 'afk failed：原因\n第二行', commentFile: path.join(dir, 'reply-1.md') });
  assert.equal(r.status, 'ok', r.error);
  const [c] = issueOf(s, 'demo-1').comments;
  const abs = (rel) => path.join(dir, rel).split(path.sep).join('/');
  assert.equal(c.text, `afk failed：原因\n第二行\n\n改了背包。\n\n![截图](${abs('images/1.png')})\n<img src="${abs('images/2.png')}" alt="x">\n![外链](https://example.com/a.png)`);
  const add = calls(s).find((a) => a[0] === 'comments');
  assert.deepEqual(add.slice(0, 4), ['comments', 'add', 'demo-1', '-f'], '评论不走命令行参数');
});

test('[beads] ticket_mark dryRun：只列会跑的 bd 命令，不碰库', () => {
  const s = open([bdIssue('demo-1', { labels: READY })]);
  const r = runScript(s, 'ticket_mark', { id: 'demo-1', action: 'done', sha: 'abc', dryRun: true });
  assert.equal(r.status, 'ok', r.error);
  assert.ok(r.data.did.some((d) => d.startsWith('bd close demo-1')), r.data.did.join('\n'));
  assert.deepEqual(calls(s), []);
});

test('[beads] ticket_view：快照带设计 / 验收标准 / 备注与评论；找不到单是普通失败，不算工单系统故障', () => {
  const s = open([bdIssue('demo-1', {
    title: '背包排序', description: '按品质排', design: '改 SortBy', acceptance_criteria: '品质高的在前', notes: '别动存档',
    comments: [{ id: 'c1', author: 'alice', text: '顺便看下性能', created_at: '2026-01-01T00:00:00Z' }]
  })]);
  const r = runScript(s, 'ticket_view', { id: 'demo-1' }, { AGENTFLOW_RUN_ID: 'run-1' });
  assert.equal(r.status, 'ok', r.error);
  const md = readFileSync(r.data.file, 'utf8');
  for (const part of ['# demo-1 背包排序', '按品质排', '## 设计\n\n改 SortBy', '## 验收标准\n\n品质高的在前', '## 备注\n\n别动存档', '## @alice 评论', '顺便看下性能']) {
    assert.ok(md.includes(part), `快照缺「${part}」：\n${md}`);
  }
  assert.ok(md.indexOf('别动存档') < md.indexOf('顺便看下性能'), '评论在正文之后');

  const missing = runScript(s, 'ticket_view', { id: 'demo-404' });
  assert.equal(missing.status, 'failed');
  assert.notEqual(missing.data?.transient, true);
  assert.equal(calls(s).filter((a) => a[1] === 'demo-404').length, 1, '不是暂时故障就不重试');
});

const DISCUSS_LABELS = ['agent-discuss', 'discuss:spec'];
const dev = (key, title, extra = {}) => ({ key, title, body: `${title} 的正文`, priority: 'P2', review: false, blockedBy: [], ...extra });

test('[beads] tickets_create：子单带 --no-inherit-labels 不继承讨论单的标签；P0~P4 落成 0~4；正文经文件传', () => {
  const s = open([bdIssue('demo-1', { labels: DISCUSS_LABELS })]);
  const r = runScript(s, 'tickets_create', {
    parentId: 'demo-1',
    tickets: [dev('a', '做甲', { priority: 'P0', body: '多行\n"正文"' }), dev('b', '做乙', { priority: 'P4', review: true, blockedBy: ['a'] })]
  });
  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(r.data.problems, []);
  assert.deepEqual(r.data.tickets.map((t) => [t.key, t.id, t.ref]), [['a', 'demo-2', 'demo-2'], ['b', 'demo-3', 'demo-3']]);
  const [a, b] = ['demo-2', 'demo-3'].map((id) => issueOf(s, id));
  assert.deepEqual([a.labels, a.priority, a.parent, a.description], [['ready-for-agent'], 0, 'demo-1', '多行\n"正文"']);
  assert.deepEqual([b.labels, b.priority], [['ready-for-agent', 'needs-review'], 4]);
  assert.deepEqual(b.dependencies.filter((d) => d.type === 'blocks').map((d) => d.depends_on_id), ['demo-2']);
  assert.ok(calls(s).filter((c) => c[0] === 'create').every((c) => c.includes('--no-inherit-labels') && c.includes('--body-file')));
});

test('[beads] tickets_create：子单还是继承了讨论单的标签 → 回查报出来，不当成功', () => {
  const s = open([bdIssue('demo-1', { labels: DISCUSS_LABELS })]);
  const st = state(s);
  st.alwaysInherit = true;
  writeFileSync(s.bdFile, JSON.stringify(st));
  const r = runScript(s, 'tickets_create', { parentId: 'demo-1', tickets: [dev('a', '做甲')] });
  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(r.data.problems, ['demo-2 继承了讨论单的标签：agent-discuss、discuss:spec']);
});

test('[beads] discuss_view / discuss_post：spec 写进描述的标记区域、原文不动；只认评论末尾的标记，人引用在中间的不算 AI', () => {
  const s = open([bdIssue('demo-1', { labels: ['agent-discuss'], description: '人写的原文' })]);
  const post = runScript(s, 'discuss_post', { id: 'demo-1', spec: '## 规格', body: '已写好 spec', mark: { hash: 'ab12', seen: 0, body: 'cd34' } });
  assert.equal(post.status, 'ok', post.error);
  assert.equal(issueOf(s, 'demo-1').description, '人写的原文\n\n<!-- miworkflow:spec:begin -->\n## 规格\n<!-- miworkflow:spec:end -->');
  const ai = issueOf(s, 'demo-1').comments[0].text;
  const st = state(s);
  st.issues[0].comments.push({ id: 'h1', author: 'alice', text: `> ${ai}\n\n我补一句`, created_at: '' });
  writeFileSync(s.bdFile, JSON.stringify(st));

  const v = runScript(s, 'discuss_view', { id: 'demo-1' });
  assert.equal(v.status, 'ok', v.error);
  assert.deepEqual([v.data.body, v.data.spec], ['人写的原文', '## 规格']);
  assert.deepEqual(v.data.comments.map((c) => [c.text, c.ai, c.mark]), [
    ['已写好 spec', true, { hash: 'ab12', seen: 0, body: 'cd34' }],
    [`> ${ai}\n\n我补一句`, false, null]
  ]);
});

test('[beads] 库被锁：退避重试后照常成功；ACTOR 非空时每条命令带 --actor', () => {
  const s = open([bdIssue('demo-1', { labels: READY })]);
  const src = path.join(s.home, 'source.mjs');
  writeFileSync(src, readFileSync(src, 'utf8').replace("export const ACTOR = '';", "export const ACTOR = 'miworkflow';"));
  const st = state(s);
  st.fail = { times: 2, message: 'Error: database is locked' };
  writeFileSync(s.bdFile, JSON.stringify(st));

  const r = runScript(s, 'ticket_mark', { id: 'demo-1', action: 'released', comment: '放回去' });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(calls(s)[0][0], '--actor');
  assert.ok(calls(s).every((a) => a[0] === '--actor' && a[1] === 'miworkflow'));
  assert.equal(issueOf(s, 'demo-1').comments[0].author, 'miworkflow');
});
