// github_discuss 模板的端到端测试：进入、带标记追问、哈希判轮、竞态补发、改正文、失败不重试、--max、/spec。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, plan, issue, issueState, labelsOf, readState, seen, cli } from './support/github-template.mjs';

const MARK = /<!-- miworkflow:discuss hash=[0-9a-f]+ seen=\d+ -->/;
const ask = (comment) => ({ choice: 'ask', data: { comment } });
const edit = (s, fn) => { const st = readState(s); fn(st); writeFileSync(s.stateFile, JSON.stringify(st)); };
const reply = (s, num, body) => edit(s, (st) => st.issues.find((i) => i.number === num).comments.push({ author: 'human', at: '', body }));
const bodies = (s, num) => issueState(s, num).comments.map((c) => c.body);
const run = (s, argv = []) => { const r = cli(s, ['github_discuss', ...argv]); assert.equal(r.code, 0, r.stderr); return r; };

test('进入：只挑 agent-discuss 且无阶段或 grilling / spec；首轮贴 discuss:grilling、评论带标记；哈希不变不重复', () => {
  const s = setup({ issues: [
    issue(1, { labels: ['agent-discuss'] }),
    issue(2, { labels: ['agent-discuss', 'discuss:tickets'] }),
    issue(3, { labels: [] })
  ] });
  plan(s, [ask('1. 问题一？推荐：A')]);
  run(s);
  assert.deepEqual(labelsOf(s, 1), ['agent-discuss', 'discuss:grilling']);
  assert.equal(bodies(s, 1).length, 1);
  assert.match(bodies(s, 1)[0], /问题一/);
  assert.match(bodies(s, 1)[0], MARK);
  assert.equal(bodies(s, 2).length, 0);
  assert.equal(bodies(s, 3).length, 0);

  plan(s, []);
  run(s);
  assert.equal(bodies(s, 1).length, 1, 'AI 自己的评论不触发下一轮');

  reply(s, 1, '同意 1');
  plan(s, [ask('2. 测试从哪下手？')]);
  run(s);
  assert.equal(bodies(s, 1).length, 3);
  assert.match(bodies(s, 1)[2], /测试/);

  reply(s, 1, `> ${bodies(s, 1)[2]}\n\n引用一下，再补一句`);
  plan(s, [ask('3. 引用后接着问')]);
  run(s);
  assert.equal(bodies(s, 1).length, 5, '人引用 AI 评论（标记在中间）仍算人的内容');
});

test('AI 思考期间人补发的评论，下一次运行会被处理；改正文也触发', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'] })] });
  plan(s, [{ ...ask('第一轮'), ghComment: '补一句' }]);
  run(s);
  assert.equal(bodies(s, 1).length, 2);

  plan(s, [ask('第二轮')]);
  run(s);
  assert.equal(bodies(s, 1).length, 3);
  assert.match(bodies(s, 1)[2], /第二轮/);

  plan(s, []);
  run(s);
  assert.equal(bodies(s, 1).length, 3);

  edit(s, (st) => { st.issues[0].body = '改过的正文'; });
  plan(s, [ask('第三轮')]);
  run(s);
  assert.equal(bodies(s, 1).length, 4);
  assert.match(bodies(s, 1)[3], /第三轮/);
});

test('一轮失败 → 带标记的失败评论，不贴 afk-failed，不自动重试；回复即重试', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'] })] });
  plan(s, [{ choice: 'ask', data: {} }]);
  run(s);
  assert.equal(bodies(s, 1).length, 1);
  assert.match(bodies(s, 1)[0], /输出不合契约/);
  assert.match(bodies(s, 1)[0], /回复任意内容重试/);
  assert.match(bodies(s, 1)[0], MARK);
  assert.ok(!labelsOf(s, 1).includes('afk-failed'));

  plan(s, []);
  run(s);
  assert.equal(bodies(s, 1).length, 1, '不自动重试');

  plan(s, [{ status: 'failed', choice: 'ask', reason: '超时' }]);
  reply(s, 1, '再来');
  run(s);
  assert.match(bodies(s, 1)[2], /超时/);
});

test('--max 限处理张数，逐张按号处理', () => {
  const s = setup({ issues: [1, 2, 3].map((n) => issue(n, { labels: ['agent-discuss'] })) });
  plan(s, [ask('a'), ask('b')]);
  run(s, ['--max', '2']);
  assert.equal(bodies(s, 1).length, 1);
  assert.equal(bodies(s, 2).length, 1);
  assert.equal(bodies(s, 3).length, 0);
});

const says = (s) => readdirSync(path.join(s.home, 'logs')).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => readFileSync(path.join(s.home, 'logs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l).say ?? ''));

test('续会话：标记记下 cli 与会话号，下一轮续上只喂增量（新评论、正文变化）', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'], body: '原始正文' })] });
  plan(s, [{ ...ask('第一问'), session: 'S1' }]);
  run(s);
  assert.match(bodies(s, 1)[0], /<!-- miworkflow:discuss hash=[0-9a-f]+ seen=\d+ cli=cmd session=S1 body=[0-9a-f]+ -->$/);
  assert.equal(seen(s)[0].session, undefined);
  assert.match(seen(s)[0].goal, /原始正文/);

  reply(s, 1, '人的新回复');
  plan(s, [{ ...ask('第二问'), session: 'S1' }]);
  run(s);
  const second = seen(s)[1];
  assert.equal(second.session, 'S1');
  assert.match(second.goal, /人的新回复/);
  assert.doesNotMatch(second.goal, /原始正文|第一问/, '只喂增量');
  assert.equal(second.issue, undefined, 'inputs 也不带完整正文');

  edit(s, (st) => { st.issues[0].body = '改过的正文'; });
  plan(s, [{ ...ask('第三问'), session: 'S1' }]);
  run(s);
  const third = seen(s)[2];
  assert.equal(third.session, 'S1');
  assert.match(third.goal, /正文改成了：\n改过的正文/);
  assert.doesNotMatch(third.goal, /人的新回复/);
});

test('续会话返回 session_not_found → 改为重放完整正文 + 全部评论，say 写明「续不上，改为重放」', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'], body: '原始正文' })] });
  plan(s, [{ ...ask('第一问'), session: 'S1' }]);
  run(s);
  reply(s, 1, '人的新回复');
  plan(s, [{ status: 'failed', choice: 'session_not_found', reason: 'cmd 续不上会话 S1' }, { ...ask('重放后的追问'), session: 'S2' }]);
  run(s);
  const [, resumed, replay] = seen(s);
  assert.equal(resumed.session, 'S1');
  assert.equal(replay.session, undefined);
  assert.match(replay.goal, /原始正文/);
  assert.match(replay.goal, /第一问/);
  assert.match(replay.goal, /人的新回复/);
  assert.match(replay.issue, /原始正文/);
  assert.ok(says(s).some((x) => x.includes('续不上，改为重放')));
  assert.match(bodies(s, 1)[2], /重放后的追问[\s\S]*session=S2/);
});

test('标记里没有会话号（上一轮 CLI 不交回）→ 直接重放', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'], body: '原始正文' })] });
  plan(s, [ask('第一问')]);
  run(s);
  assert.match(bodies(s, 1)[0], MARK);
  reply(s, 1, '人的新回复');
  plan(s, [ask('第二问')]);
  run(s);
  const second = seen(s)[1];
  assert.equal(second.session, undefined);
  assert.match(second.goal, /原始正文/);
  assert.match(second.goal, /第一问/);
  assert.match(second.goal, /人的新回复/);
});

const specOut = (spec) => ({ choice: 'spec', data: { spec } });
const bodyOf = (s, num) => issueState(s, num).body;
const SPEC_AREA = /<!-- miworkflow:spec:begin -->\n([\s\S]*)\n<!-- miworkflow:spec:end -->$/;

test('/spec：spec 写进正文标记区域、原文保留在上面；阶段改 discuss:spec；不贴 ready-for-agent；AI 写 spec 不触发自己', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'], body: '人写的原文' })] });
  plan(s, [ask('1. 问题一？')]);
  run(s);
  reply(s, 1, '/spec');
  plan(s, [specOut('## Problem Statement\n第一版')]);
  run(s);
  assert.match(seen(s)[1].goal, /Problem Statement/);
  assert.match(seen(s)[1].goal, /人写的原文/);
  const body = bodyOf(s, 1);
  assert.ok(body.startsWith('人写的原文\n\n'), body);
  assert.equal(SPEC_AREA.exec(body)[1], '## Problem Statement\n第一版');
  assert.deepEqual(labelsOf(s, 1), ['agent-discuss', 'discuss:spec']);
  assert.ok(!labelsOf(s, 1).includes('ready-for-agent'));
  assert.match(bodies(s, 1)[2], /spec 区域[\s\S]*<!-- miworkflow:discuss hash=/);

  plan(s, []);
  run(s);
  assert.equal(bodies(s, 1).length, 3, 'AI 写 spec 不触发它自己');
  assert.equal(seen(s).length, 2);
});

test('spec 阶段评论改 spec：只替换 spec 区域，不动原文；再次 /spec 同样；人改原文仍触发', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'], body: '人写的原文' })] });
  reply(s, 1, '/spec');
  plan(s, [specOut('第一版')]);
  run(s);
  assert.equal(SPEC_AREA.exec(bodyOf(s, 1))[1], '第一版');

  reply(s, 1, '用户故事再补一条');
  plan(s, [specOut('第二版')]);
  run(s);
  const second = seen(s)[1];
  assert.match(second.goal, /当前 spec[\s\S]*第一版/);
  assert.match(second.goal, /用户故事再补一条/);
  assert.match(second.goal, /choice 只能是 spec/);
  assert.equal(bodyOf(s, 1), '人写的原文\n\n<!-- miworkflow:spec:begin -->\n第二版\n<!-- miworkflow:spec:end -->');
  assert.match(bodies(s, 1).at(-1), /改写 spec/);

  reply(s, 1, '/spec');
  plan(s, [specOut('第三版')]);
  run(s);
  assert.equal(bodyOf(s, 1), '人写的原文\n\n<!-- miworkflow:spec:begin -->\n第三版\n<!-- miworkflow:spec:end -->');

  plan(s, []);
  run(s);
  assert.equal(seen(s).length, 3, 'spec 区域不计入哈希');

  edit(s, (st) => { st.issues[0].body = st.issues[0].body.replace('人写的原文', '人改过的原文'); });
  plan(s, [specOut('第四版')]);
  run(s);
  assert.equal(seen(s).length, 4, '人改原文仍触发');
  assert.equal(bodyOf(s, 1), '人改过的原文\n\n<!-- miworkflow:spec:begin -->\n第四版\n<!-- miworkflow:spec:end -->');
  assert.deepEqual(labelsOf(s, 1), ['agent-discuss', 'discuss:spec']);
});

test('写 spec 失败：正文不动，发带标记的失败评论', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'], body: '人写的原文' })] });
  reply(s, 1, '/spec');
  plan(s, [ask('答非所问')]);
  run(s);
  assert.equal(bodyOf(s, 1), '人写的原文');
  assert.match(bodies(s, 1).at(-1), /写 spec 失败[\s\S]*choice=spec/);
  assert.match(bodies(s, 1).at(-1), MARK);
});

test('AI 思考期间人发的 /spec（排在 AI 评论之前）下一次运行仍进 spec 阶段', () => {
  const s = setup({ issues: [issue(1, { labels: ['agent-discuss'], body: '人写的原文' })] });
  plan(s, [ask('1. 问题一？')]);
  run(s);
  edit(s, (st) => { const c = st.issues[0].comments; c.splice(c.length - 1, 0, { author: 'alice', at: '', body: '/spec' }); });
  plan(s, [specOut('第一版')]);
  run(s);
  assert.equal(SPEC_AREA.exec(bodyOf(s, 1))[1], '第一版');
  assert.deepEqual(labelsOf(s, 1), ['agent-discuss', 'discuss:spec']);
});
