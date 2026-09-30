// 讨论流程端到端场景：同一套场景对每家假工单源各跑一遍（tests/discuss-<工单源>.test.mjs 各注册一次）。
// 正文 / spec / 标记 / 依赖怎么存由源决定，断言走 discuss-sources.mjs 里各自的读法；
// GitHub 特有的正文区域与隐藏注释另见 template-github-discuss.test.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { plan, seen, cli } from './github-template.mjs';

const ask = (comment) => ({ choice: 'ask', data: { comment } });
const specOut = (spec) => ({ choice: 'spec', data: { spec } });
const tickets = (list) => ({ choice: 'tickets', data: { tickets: list } });
// Agent 只交结构（key / title / body / priority / review / blockedBy），建单由脚本做
const dev = (key, title, extra = {}) => ({
  key, title, priority: 'P2', review: false, blockedBy: [], ...extra,
  body: extra.body ?? `## What to build\n\n${title} 的行为\n\n## Acceptance criteria\n\n- [ ] 好了`
});
const says = (s) => readdirSync(path.join(s.home, 'logs')).filter((f) => f.endsWith('.jsonl'))
  .flatMap((f) => readFileSync(path.join(s.home, 'logs', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l).say ?? ''));

export function defineDiscussScenarios(src) {
  const MARK = src.markRe();
  const scenario = (name, opts, fn) => test(`[${src.name}] ${name}`, async () => {
    const s = await src.open(opts);
    try {
      await fn(s);
    } finally {
      await s.close();
    }
  });
  const run = (s, argv = []) => { const r = cli(s, ['discuss', ...argv]); assert.equal(r.code, 0, r.stderr); return r; };
  const bodies = (s, key) => src.comments(s, key);
  const reply = (s, key, body, opts) => src.reply(s, key, body, opts);
  const specIssue = () => ({ key: 1, labels: ['agent-discuss', 'discuss:spec'], body: '原文', spec: '规格' });

  scenario('进入：只挑 agent-discuss 且无阶段或 grilling / spec；首轮贴 discuss:grilling、评论带标记；哈希不变不重复', {
    issues: [{ key: 1, labels: ['agent-discuss'] }, { key: 2, labels: ['agent-discuss', 'discuss:tickets'] }, { key: 3, labels: [] }]
  }, (s) => {
    plan(s, [ask('1. 问题一？推荐：A')]);
    run(s);
    assert.deepEqual(src.labels(s, 1), ['agent-discuss', 'discuss:grilling']);
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

  scenario('AI 思考期间人补发的评论，下一次运行会被处理；改正文也触发', { issues: [{ key: 1, labels: ['agent-discuss'] }] }, (s) => {
    plan(s, [{ ...ask('第一轮'), ...src.thinkStep('补一句') }]);
    run(s);
    assert.equal(bodies(s, 1).length, 2);

    plan(s, [ask('第二轮')]);
    run(s);
    assert.equal(bodies(s, 1).length, 3);
    assert.match(bodies(s, 1)[2], /第二轮/);

    plan(s, []);
    run(s);
    assert.equal(bodies(s, 1).length, 3);

    src.editOriginal(s, 1, '改过的正文');
    plan(s, [ask('第三轮')]);
    run(s);
    assert.equal(bodies(s, 1).length, 4);
    assert.match(bodies(s, 1)[3], /第三轮/);
  });

  scenario('一轮失败 → 带标记的失败评论，不贴 afk-failed，不自动重试；回复即重试', { issues: [{ key: 1, labels: ['agent-discuss'] }] }, (s) => {
    plan(s, [{ choice: 'ask', data: {} }]);
    run(s);
    assert.equal(bodies(s, 1).length, 1);
    assert.match(bodies(s, 1)[0], /输出不合契约/);
    assert.match(bodies(s, 1)[0], /回复任意内容重试/);
    assert.match(bodies(s, 1)[0], MARK);
    assert.ok(!src.labels(s, 1).includes('afk-failed'));

    plan(s, []);
    run(s);
    assert.equal(bodies(s, 1).length, 1, '不自动重试');

    plan(s, [{ status: 'failed', choice: 'ask', reason: '超时' }]);
    reply(s, 1, '再来');
    run(s);
    assert.match(bodies(s, 1)[2], /超时/);
  });

  scenario('--max 限处理张数，逐张按号处理', { issues: [1, 2, 3].map((key) => ({ key, labels: ['agent-discuss'] })) }, (s) => {
    plan(s, [ask('a'), ask('b')]);
    run(s, ['--max', '2']);
    assert.equal(bodies(s, 1).length, 1);
    assert.equal(bodies(s, 2).length, 1);
    assert.equal(bodies(s, 3).length, 0);
  });

  scenario('续会话：标记记下 cli 与会话号，下一轮续上只喂增量（新评论、正文变化）', {
    issues: [{ key: 1, labels: ['agent-discuss'], body: '原始正文' }]
  }, (s) => {
    plan(s, [{ ...ask('第一问'), session: 'S1' }]);
    run(s);
    assert.match(bodies(s, 1)[0], src.markRe(' cli=cmd session=S1 body=[0-9a-f]+'));
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

    src.editOriginal(s, 1, '改过的正文');
    plan(s, [{ ...ask('第三问'), session: 'S1' }]);
    run(s);
    const third = seen(s)[2];
    assert.equal(third.session, 'S1');
    assert.match(third.goal, /正文改成了：\n改过的正文/);
    assert.doesNotMatch(third.goal, /人的新回复/);
  });

  scenario('续会话返回 session_not_found → 改为重放完整正文 + 全部评论，say 写明「续不上，改为重放」', {
    issues: [{ key: 1, labels: ['agent-discuss'], body: '原始正文' }]
  }, (s) => {
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
    assert.match(replay.ticket, /原始正文/);
    assert.ok(says(s).some((x) => x.includes('续不上，改为重放')));
    assert.match(bodies(s, 1)[2], /重放后的追问[\s\S]*session=S2/);
  });

  scenario('标记里没有会话号（上一轮 CLI 不交回）→ 直接重放', { issues: [{ key: 1, labels: ['agent-discuss'], body: '原始正文' }] }, (s) => {
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

  scenario('/spec：spec 落到源的存放处、原文不动；阶段改 discuss:spec；不贴 ready-for-agent；AI 写 spec 不触发自己', {
    issues: [{ key: 1, labels: ['agent-discuss'], body: '人写的原文' }]
  }, (s) => {
    plan(s, [ask('1. 问题一？')]);
    run(s);
    reply(s, 1, '/spec');
    plan(s, [specOut('## Problem Statement\n第一版')]);
    run(s);
    assert.match(seen(s)[1].goal, /Problem Statement/);
    assert.match(seen(s)[1].goal, /人写的原文/);
    assert.equal(src.original(s, 1), '人写的原文');
    assert.equal(src.spec(s, 1), '## Problem Statement\n第一版');
    assert.deepEqual(src.labels(s, 1), ['agent-discuss', 'discuss:spec']);
    assert.ok(!src.labels(s, 1).includes('ready-for-agent'));
    assert.equal(bodies(s, 1).length, 3);
    assert.match(bodies(s, 1)[2], /已写好 spec/);
    assert.match(bodies(s, 1)[2], MARK);

    plan(s, []);
    run(s);
    assert.equal(bodies(s, 1).length, 3, 'AI 写 spec 不触发它自己');
    assert.equal(seen(s).length, 2);
  });

  scenario('spec 阶段评论改 spec：只换 spec，不动原文；再次 /spec 同样；人改原文仍触发', {
    issues: [{ key: 1, labels: ['agent-discuss'], body: '人写的原文' }]
  }, (s) => {
    reply(s, 1, '/spec');
    plan(s, [specOut('第一版')]);
    run(s);
    assert.equal(src.spec(s, 1), '第一版');

    reply(s, 1, '用户故事再补一条');
    plan(s, [specOut('第二版')]);
    run(s);
    const second = seen(s)[1];
    assert.match(second.goal, /当前 spec[\s\S]*第一版/);
    assert.match(second.goal, /用户故事再补一条/);
    assert.match(second.goal, /choice 只能是 spec/);
    assert.equal(src.original(s, 1), '人写的原文');
    assert.equal(src.spec(s, 1), '第二版');
    assert.match(bodies(s, 1).at(-1), /改写 spec/);

    reply(s, 1, '/spec');
    plan(s, [specOut('第三版')]);
    run(s);
    assert.equal(src.original(s, 1), '人写的原文');
    assert.equal(src.spec(s, 1), '第三版');

    plan(s, []);
    run(s);
    assert.equal(seen(s).length, 3, 'AI 写的 spec 不计入哈希');

    src.editOriginal(s, 1, '人改过的原文');
    plan(s, [specOut('第四版')]);
    run(s);
    assert.equal(seen(s).length, 4, '人改原文仍触发');
    assert.equal(src.original(s, 1), '人改过的原文');
    assert.equal(src.spec(s, 1), '第四版');
    assert.deepEqual(src.labels(s, 1), ['agent-discuss', 'discuss:spec']);
  });

  scenario('写 spec 失败：原文与 spec 都不动，发带标记的失败评论', { issues: [{ key: 1, labels: ['agent-discuss'], body: '人写的原文' }] }, (s) => {
    reply(s, 1, '/spec');
    plan(s, [ask('答非所问')]);
    run(s);
    assert.equal(src.original(s, 1), '人写的原文');
    assert.equal(src.spec(s, 1), null);
    assert.match(bodies(s, 1).at(-1), /写 spec 失败[\s\S]*choice=spec/);
    assert.match(bodies(s, 1).at(-1), MARK);
  });

  scenario('AI 思考期间人发的 /spec（排在 AI 评论之前）下一次运行仍进 spec 阶段', {
    issues: [{ key: 1, labels: ['agent-discuss'], body: '人写的原文' }]
  }, (s) => {
    plan(s, [ask('1. 问题一？')]);
    run(s);
    reply(s, 1, '/spec', { beforeLast: true });
    plan(s, [specOut('第一版')]);
    run(s);
    assert.equal(src.spec(s, 1), '第一版');
    assert.deepEqual(src.labels(s, 1), ['agent-discuss', 'discuss:spec']);
  });

  scenario('/tickets 通过：脚本建单（贴标签、写依赖、挂父单）→ 阶段改 ticketed；之后不再响应，改回 spec 恢复', { issues: [specIssue()] }, (s) => {
    reply(s, 1, '/tickets');
    plan(s, [tickets([dev('a', '做甲'), dev('b', '做乙', { blockedBy: ['a'], review: true })])]);
    run(s);
    assert.match(seen(s)[0].goal, new RegExp(`把 spec 拆成开发单[\\s\\S]*讨论单：${src.ref(1)}[\\s\\S]*规格`));

    const devs = src.devTickets(s, 1);
    assert.deepEqual(devs.map((t) => [t.key, t.title, t.labels]), [
      [2, '做甲', src.readyLabels('P2', false)],
      [3, '做乙', src.readyLabels('P2', true)]
    ]);
    assert.match(devs[0].body, /## What to build\n\n做甲 的行为/);
    assert.deepEqual(src.blockedBy(s, 2), []);
    assert.deepEqual(src.blockedBy(s, 3), [2], '依赖落成源自己的写法');

    assert.equal(src.original(s, 1), '原文');
    assert.equal(src.spec(s, 1), '规格');
    assert.deepEqual(src.labels(s, 1), ['agent-discuss', 'discuss:ticketed']);
    assert.match(bodies(s, 1).at(-1), new RegExp(`已建开发单 ${src.ref(2)}、${src.ref(3)}[\\s\\S]*discuss:ticketed`));
    assert.match(bodies(s, 1).at(-1), MARK);

    reply(s, 1, '还有个想法');
    plan(s, []);
    run(s);
    assert.equal(seen(s).length, 1, 'ticketed 阶段不响应');

    src.setLabels(s, 1, ['agent-discuss', 'discuss:spec']);
    plan(s, [specOut('新规格')]);
    run(s);
    assert.equal(seen(s).length, 2, '改回 spec 恢复响应');
    assert.equal(src.spec(s, 1), '新规格');
    assert.equal(src.devTickets(s, 1).length, 2, '改写 spec 不动已建的开发单');
  });

  scenario('/tickets 讨论单下已有别的子需求（没贴 ready-for-agent）→ 回查只看这次建的，仍改 ticketed，已有的一个字不动', {
    issues: [specIssue(), { key: 2, parent: 1, labels: [], body: '早就有的子需求' }]
  }, (s) => {
    const old = () => ({
      ticket: src.devTickets(s, 1).find((t) => t.key === 2), comments: bodies(s, 2), blockedBy: src.blockedBy(s, 2)
    });
    const before = old();
    assert.ok(before.ticket, '预置的子需求挂在讨论单下');

    reply(s, 1, '/tickets');
    plan(s, [tickets([dev('a', '做甲'), dev('b', '做乙', { blockedBy: ['a'] })])]);
    run(s);

    assert.deepEqual(src.labels(s, 1), ['agent-discuss', 'discuss:ticketed']);
    assert.match(bodies(s, 1).at(-1), new RegExp(`已建开发单 ${src.ref(3)}、${src.ref(4)}`));
    assert.doesNotMatch(bodies(s, 1).at(-1), new RegExp(src.ref(2)));
    assert.deepEqual(src.devTickets(s, 1).map((t) => t.key), [2, 3, 4]);
    assert.deepEqual(src.blockedBy(s, 4), [3]);
    assert.deepEqual(old(), before, '已有的子需求一个字都不动');
  });

  scenario('/tickets 结构有问题（依赖指向不认识的 key、成环）→ 一张不建、带标记评论说明、阶段不变、不自动重试', { issues: [specIssue()] }, (s) => {
    reply(s, 1, '/tickets');
    plan(s, [tickets([
      dev('a', '做甲', { blockedBy: ['nope'] }),
      dev('b', '做乙', { blockedBy: ['c'] }),
      dev('c', '做丙', { blockedBy: ['b'] })
    ])]);
    run(s);
    const last = bodies(s, 1).at(-1);
    assert.match(last, /开发单没建好/);
    assert.match(last, /依赖了不认识的 key：nope/);
    assert.match(last, /成环/);
    assert.match(last, MARK);
    assert.deepEqual(src.labels(s, 1), ['agent-discuss', 'discuss:spec']);
    assert.equal(src.original(s, 1), '原文');
    assert.equal(src.spec(s, 1), '规格');
    assert.equal(src.devTickets(s, 1).length, 0, '一张都没建');

    plan(s, []);
    run(s);
    assert.equal(seen(s).length, 1, '不自动重试');
  });

  scenario('/tickets 只在 spec 阶段生效：grilling 阶段当普通评论追问', { issues: [{ key: 1, labels: ['agent-discuss', 'discuss:grilling'] }] }, (s) => {
    reply(s, 1, '/tickets');
    plan(s, [ask('接着问')]);
    run(s);
    assert.doesNotMatch(seen(s)[0].goal, /把 spec 拆成开发单/);
    assert.match(bodies(s, 1).at(-1), /接着问/);
    assert.deepEqual(src.labels(s, 1), ['agent-discuss', 'discuss:grilling']);
  });
}
