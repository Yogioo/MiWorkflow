// github_discuss 模板的端到端测试：进入、带标记追问、哈希判轮、竞态补发、改正文、失败不重试、--max。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { setup, plan, issue, issueState, labelsOf, readState, cli } from './support/github-template.mjs';

const MARK = /<!-- miworkflow:discuss hash=[0-9a-f]+ -->/;
const ask = (comment) => ({ choice: 'ask', data: { comment } });
const edit = (s, fn) => { const st = readState(s); fn(st); writeFileSync(s.stateFile, JSON.stringify(st)); };
const reply = (s, num, body) => edit(s, (st) => st.issues.find((i) => i.number === num).comments.push({ author: 'human', at: '', body }));
const bodies = (s, num) => issueState(s, num).comments.map((c) => c.body);
const run = (s, argv = []) => { const r = cli(s, ['github_discuss', ...argv]); assert.equal(r.code, 0, r.stderr); return r; };

test('进入：只挑 agent-discuss 且无阶段或 grilling；首轮贴 discuss:grilling、评论带标记；哈希不变不重复', () => {
  const s = setup({ issues: [
    issue(1, { labels: ['agent-discuss'] }),
    issue(2, { labels: ['agent-discuss', 'discuss:spec'] }),
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
