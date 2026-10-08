// 讨论流程端到端：TAPD 工单源跑一遍共用场景（tests/support/discuss-scenarios.mjs），
// 外加 --every 循环里「省着查」（TAPD 有调用额度，增量只有 TAPD 源实现）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineDiscussScenarios } from './support/discuss-scenarios.mjs';
import { SOURCES } from './support/discuss-sources.mjs';
import { cli, plan, seen } from './support/github-template.mjs';
import { openApiLog, readTapdState, writeTapdState } from './support/tapd-fakes.mjs';

defineDiscussScenarios(SOURCES.tapd);

const src = SOURCES.tapd;
const ask = (comment) => ({ choice: 'ask', data: { comment } });
const MAX_MS = 600_000;

test('[tapd] --every 循环里省着查：没到点不碰 TAPD；到点只读有变化的单；没动静间隔拉长到上限', async () => {
  const s = await src.open({ issues: [{ key: 1, labels: ['agent-discuss'] }, { key: 2, labels: ['agent-discuss'] }] });
  s.env.AGENTFLOW_LOOP_PID = '1';
  const paceFile = path.join(s.home, 'logs', 'discuss.pace.json');
  const pace = () => JSON.parse(readFileSync(paceFile, 'utf8'));
  const setPace = (patch) => writeFileSync(paceFile, JSON.stringify({ ...pace(), ...patch }));
  const calls = () => readTapdState(s.tapdFile).calls.length + openApiLog(s.tapdFile).length;
  // discuss_view 读评论带 entry_id；discuss_list 翻全项目评论不带
  const viewed = () => openApiLog(s.tapdFile).filter((r) => r.url.startsWith('/comments?') && r.url.includes('entry_id=')).map((r) => new URL(r.url, 'http://x').searchParams.get('entry_id'));
  const run = () => { const r = cli(s, ['discuss']); assert.equal(r.code, 0, r.stderr); return r; };
  try {
    plan(s, [ask('问一'), ask('问二')]);
    run();
    assert.equal(seen(s).length, 2, '头一轮没有 cursor：全量看一遍');
    assert.ok(pace().cursor, '记下 cursor');
    assert.ok(pace().nextAt - Date.now() < 5_000, '刚有动静：下一轮马上查');

    let n = viewed().length;
    plan(s, []);
    run();
    assert.equal(viewed().length, n, '没有新的人的评论：一张都不读（AI 自己的评论不算）');

    setPace({ nextAt: Date.now() + 3_600_000 });
    const before = calls();
    assert.match(run().stdout, /还没到点/);
    assert.equal(calls(), before, '没到点：一次 TAPD 都不调');

    src.reply(s, 2, '回答二');
    setPace({ nextAt: 0 });
    n = viewed().length;
    plan(s, [ask('追问二')]);
    run();
    assert.deepEqual(viewed().slice(n), [src.ref(2).replace('story ', '')], '只读有变化的那张');
    assert.match(src.comments(s, 2).at(-1), /追问二/);
    assert.equal(src.comments(s, 1).length, 1);

    setPace({ nextAt: 0, activeAt: Date.now() - 2 * 60_000 });
    run();
    let gap = pace().nextAt - Date.now();
    assert.ok(gap > 20_000 && gap < 40_000, `静了 2 分钟：间隔约 30 秒（实际 ${gap}）`);

    setPace({ nextAt: 0, activeAt: Date.now() - 3_600_000 });
    run();
    gap = pace().nextAt - Date.now();
    assert.ok(gap > MAX_MS - 10_000 && gap <= MAX_MS, `静了很久：封顶 DISCUSS_IDLE_MAX_SEC（实际 ${gap}）`);
  } finally {
    await s.close();
  }
});

test('[tapd] --every 循环里列单失败（额度用完）：本轮失败、不重试，下次按最长间隔再查', async () => {
  const s = await src.open({ issues: [{ key: 1, labels: ['agent-discuss'] }] });
  s.env.AGENTFLOW_LOOP_PID = '1';
  try {
    const st = readTapdState(s.tapdFile);
    st.fail = { times: 3, message: 'API 错误 429: {"status":429,"info":"API request limit exceeded (2000 requests/24 hours)."}' };
    writeTapdState(s.tapdFile, st);
    const r = cli(s, ['discuss']);
    assert.notEqual(r.code, 0);
    assert.equal(readTapdState(s.tapdFile).fail.times, 2, '额度用完不重试');
    const gap = JSON.parse(readFileSync(path.join(s.home, 'logs', 'discuss.pace.json'), 'utf8')).nextAt - Date.now();
    assert.ok(gap > MAX_MS - 10_000 && gap <= MAX_MS, `退到最长间隔（实际 ${gap}）`);
  } finally {
    await s.close();
  }
});
