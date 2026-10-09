// 开发流程端到端场景：同一套场景对每家假工单源各跑一遍（tests/dev-<工单源>.test.mjs 各注册一次）。
// 断言只在「完成」的含义上按工单源分支，其余共用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { plan, seen, cli, git, gitOut, runScript } from './github-template.mjs';

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
    assert.equal(t.closed, src.closes, 'GitHub / beads 关单，TAPD 不关单');
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

  scenario('完成评论：开发、审查的回帖稿 + 工作流落款；提交信息用 Agent 给的类型和一句话', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true
  }, (s, view) => {
    plan(s, [
      { choice: 'done', reason: '做完', file: { name: 'note.txt', content: 'hi' }, reply: '新增 note.txt。\n验证：没有运行。', data: { type: 'fix', summary: '补上说明文件。' } },
      { choice: 'refined', reason: '顺手补了', file: { name: 'extra.txt', content: 'x' }, reply: '审查：补了 extra.txt，没有运行。' }
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    const subject = gitOut(['log', '-1', '--pretty=%s'], s.root);
    assert.equal(subject, src.commitSubject(1, 'fix', '补上说明文件'));
    assert.doesNotMatch(gitOut(['log', '-1', '--pretty=%B'], s.root), /Co-authored-by|Made-with/i);
    const c = view(1).comments.at(-1);
    const at = (text) => { const i = c.indexOf(text); assert.ok(i >= 0, `评论里没有「${text}」：\n${c}`); return i; };
    assert.ok(at('已完成') < at('**开发**') && at('**开发**') < at('新增 note.txt') && at('新增 note.txt') < at('**审查**') &&
      at('**审查**') < at('审查：补了') && at('审查：补了') < at('改动 2 个文件'), c);
    if (src.name === 'tapd') assert.ok(c.includes('新增 note.txt。  \n验证：没有运行。'), `TAPD 单个换行转硬换行：${c}`);
    at('`note.txt`');
    at('`extra.txt`');
    at('审查者做了修正');
    at('没配验证命令');
    at(`${gitOut(['rev-parse', '--short=7', 'HEAD'], s.root)} ${subject}（已推送）`);
    assert.doesNotMatch(c, /没写回帖稿/);
  });

  scenario('完成评论：Agent 没写回帖稿 → 用它回话的 reason 兜底；类型不在表里取第一个、没给一句话用标题', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true
  }, (s, view) => {
    plan(s, [
      { choice: 'done', reason: '只改了一行字符串拼接，没有编译', file: { name: 'note.txt', content: 'hi' }, data: { type: 'feature' } },
      { choice: 'clean', reason: '看过没问题，我也没编译' }
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), src.commitSubject(1, undefined, '加个文件'));
    const c = view(1).comments.at(-1);
    assert.ok(c.indexOf('**开发**（没写回帖稿，这是它的回话）') < c.indexOf('只改了一行字符串拼接，没有编译'), c);
    assert.ok(c.indexOf('**审查**（没写回帖稿，这是它的回话）') < c.indexOf('看过没问题，我也没编译'), c);
    assert.ok(c.indexOf('只改了一行字符串拼接') < c.indexOf('**审查**'), c);
    assert.ok(c.includes('改动 1 个文件') && c.includes('审查者看过，没有改动'), c);
  });

  scenario('Agent 不听话自己提交了（开发、审查各一笔）→ 压成工作流的一笔，提交信息照规范重写', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true
  }, (s, view) => {
    plan(s, [
      { choice: 'done', reason: '做完', file: { name: 'note.txt', content: 'hi' }, commit: 'wip 随便写的\n\nCo-authored-by: Cursor <cursoragent@cursor.com>' },
      { choice: 'refined', reason: '改了', file: { name: 'more.txt', content: 'x' }, commit: 'review fix' }
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assertDelivered(view(1));
    assert.equal(gitOut(['rev-list', '--count', 'HEAD'], s.root), '2', 'init + 这一笔');
    assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), src.commitSubject(1, undefined, '加个文件'));
    assert.doesNotMatch(gitOut(['log', '-1', '--pretty=%B'], s.root), /Co-authored-by/);
    assert.deepEqual(gitOut(['show', '--name-only', '--pretty=', 'HEAD'], s.root).split('\n').sort(), ['more.txt', 'note.txt']);
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

  scenario('miworkflow stop dev：手头这张单照常做完、标记完成，不再挑下一张', {
    tickets: [{ key: 1, labels: READY }, { key: 2, labels: READY }], push: true
  }, (s, view) => {
    plan(s, [
      { choice: 'done', reason: '做完', file: { name: 'one.txt', content: '1' }, miworkflow: ['stop', 'dev'] },
      { choice: 'clean', reason: '没问题' }
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assertDelivered(view(1));
    assert.ok(existsSync(path.join(s.root, 'one.txt')));
    assert.equal(seen(s).length, 2, '只做了第一张单的开发 + 审查');
    assert.deepEqual(view(2).labels, READY, '停下了，不挑下一张');
    assert.match(r.stderr, /已请求停止：dev 做完手头这一单就停/, '假 Agent 把 miworkflow stop 的输出打在 stderr');
    assert.match(r.stdout, /本轮结束：完成 1 个，失败 0 个；收到停止请求/);
    assert.ok(!existsSync(path.join(s.home, 'logs', 'dev.stop')), '请求用完就删');
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
    assert.equal(view(7).closed, src.closes);
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

  // ── 启动校验（§10.1）：配置不对就不启动——不认领、不评论、不叫 Agent ──
  scenario('配置不对：REVIEWER 的 CLI 名字不认识 → 启动就报错，没认领、没评论、没叫过 Agent；--dry-run 也报', {
    tickets: [{ key: 1, labels: READY }], config: { REVIEWER: { cli: 'agent' } }
  }, (s, view) => {
    plan(s, DONE_STEPS('x.txt'));
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /不认识的 Agent CLI：agent（可选：pi \/ codex \/ cursor）/, '说清哪一项错、合法的值有哪些');
    assert.deepEqual(seen(s), [], '没叫 Agent');
    assert.deepEqual(view(1).labels, READY, '没认领');
    assert.deepEqual(view(1).comments, [], '没评论');

    const dry = cli(s, ['dev', '--dry-run']);
    assert.equal(dry.code, 1, '干跑也要查配置');
    assert.match(dry.stderr + dry.stdout, /不认识的 Agent CLI：agent/);
  });

  scenario('配置不对：DEV 的参数组合非法（cursor 只给 thinking）→ 启动就报错', {
    tickets: [{ key: 1, labels: READY }], config: { DEV: { cli: 'cursor', thinking: 'high' } }
  }, (s, view) => {
    plan(s, []);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /DEV：.*只给 thinking/);
    assert.deepEqual(seen(s), []);
    assert.deepEqual(view(1).labels, READY);
  });

  scenario('配置不对：DEV 走内核适配器，但本机没这个命令 → 启动就报错，说清用哪个环境变量指路', {
    tickets: [{ key: 1, labels: READY }], config: { DEV: { cli: 'pi' } }
  }, (s, view) => {
    s.env.PI_BIN = path.join(s.base, 'nope', 'pi.mjs');
    plan(s, DONE_STEPS('x.txt'));
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /DEV：Agent 配置不对：本机找不到 pi 的命令/);
    assert.match(r.stderr + r.stdout, /PI_BIN/);
    assert.deepEqual(seen(s), []);
    assert.deepEqual(view(1).labels, READY);
  });

  scenario('配置不对：普通常量写错 → 启动就报错，所有错的项一次列全', {
    tickets: [{ key: 1, labels: READY }], verify: 1, rounds: -1, review: 'sometimes', push: 'yes'
  }, (s, view) => {
    plan(s, DONE_STEPS('x.txt'));
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    const said = r.stderr + r.stdout;
    for (const name of ['VERIFY', 'ROUNDS', 'REVIEW', 'PUSH']) assert.match(said, new RegExp(`${name} 只能是`), said);
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

  const INFRA = { status: 'failed', choice: 'agent_cli_failed', reason: 'socket hang up' };
  const assertReleased = (t) => {
    assert.equal(t.closed, false);
    assert.deepEqual(t.labels, READY, '释放：摘 afk-claimed、不贴 afk-failed、保留 ready');
    assert.ok(t.comments.some((c) => c.includes('Agent 连接失败')), t.comments.join('\n'));
  };

  scenario('Agent 连不上 → 退避重试成功：开发 / 审查各挂一次，开发重试前回到起点，照常完成', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true
  }, (s, view) => {
    plan(s, [
      { ...INFRA, file: { name: 'half.txt', content: 'x' }, commit: `${src.commitPrefix(1)}半成品` },
      { choice: 'done', reason: '做完', file: { name: 'note.txt', content: 'hi' } },
      INFRA,
      { choice: 'clean', reason: '没问题' }
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen(s).length, 4);
    assertDelivered(view(1));
    assert.ok(!view(1).labels.includes('afk-failed'));
    assert.ok(!existsSync(path.join(s.root, 'half.txt')), '开发重试前回到了起点');
    assert.ok(existsSync(path.join(s.root, 'note.txt')));
    assert.match(r.stderr, /第 1 次重试.*socket hang up/);
  });

  scenario('Agent 一直连不上 → 重试用完：回滚 + 备份 ref + 释放工单、不挑下一张、退出码非 0', {
    tickets: [{ key: 1, labels: READY }, { key: 2, labels: READY }]
  }, (s, view) => {
    plan(s, [
      { ...INFRA, file: { name: 'half.txt', content: 'x' }, commit: `${src.commitPrefix(1)}半成品` },
      INFRA, INFRA, INFRA, INFRA
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.equal(seen(s).length, 3, '缺省重试 2 次');
    assertReleased(view(1));
    assert.ok(view(1).comments.some((c) => c.includes('socket hang up') && c.includes('afk-backup')));
    assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), 'init');
    assert.ok(!existsSync(path.join(s.root, 'half.txt')));
    const refs = gitOut(['for-each-ref', '--format=%(refname)', 'refs/afk-backup'], s.root).split('\n').filter(Boolean);
    assert.ok(refs.length >= 1);
    assert.deepEqual(view(2).labels, READY, '主循环停下，不挑下一张');
    assert.match(r.stderr + r.stdout, /Agent 连接失败（工单 [^）]+）：已回滚并释放，下轮重做/);
  });

  scenario('没配 Agent → 不重试，直接释放并停下', {
    tickets: [{ key: 1, labels: READY }, { key: 2, labels: READY }]
  }, (s, view) => {
    plan(s, [{ status: 'failed', choice: 'agent_unavailable', reason: '未配置 Agent：设 AGENTFLOW_AGENT' }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.equal(seen(s).length, 1);
    assertReleased(view(1));
    assert.ok(view(1).comments.some((c) => c.includes('未配置 Agent')));
    assert.deepEqual(view(2).labels, READY);
  });

  scenario('运行中撞上 agent_bad_config → 不按 AGENT_RETRY_DELAYS 重试，回滚释放、整轮停下', {
    tickets: [{ key: 1, labels: READY }, { key: 2, labels: READY }], retryDelays: [0, 0]
  }, (s, view) => {
    plan(s, [
      { status: 'failed', choice: 'agent_bad_config', reason: 'Agent 配置不对：不认识的 Agent CLI：agent', file: { name: 'half.txt', content: 'x' } },
      ...DONE_STEPS()
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.equal(seen(s).length, 1, '不重试：重试的那一轮没跑');
    const t = view(1);
    assert.equal(t.closed, false);
    assert.deepEqual(t.labels, READY, '释放：摘 afk-claimed、不贴 afk-failed、保留 ready');
    assert.ok(t.comments.some((c) => c.includes('Agent 配置不对') && c.includes('不认识的 Agent CLI：agent')), t.comments.join('\n'));
    assert.ok(!existsSync(path.join(s.root, 'half.txt')), '半成品回滚了');
    assert.deepEqual(view(2).labels, READY, '整轮停下，不挑下一张');
    assert.match(r.stderr + r.stdout, /Agent 配置不对（工单 [^）]+）：已回滚并释放，整轮停下/);
  });

  scenario('Agent 进程什么都没吐（空 stdout）→ 按连不上重试；AGENT_RETRY_DELAYS 为空就不重试', {
    tickets: [{ key: 1, labels: READY }], retryDelays: []
  }, (s, view) => {
    plan(s, [{ crash: true }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.equal(seen(s).length, 1);
    assertReleased(view(1));
  });

  // ── 被强制结束（卡死 / 超时）：诊断 → 回滚存 diff → 评论 → 释放；同一张单满 AGENT_KILL_LIMIT 次转人工 ──
  const TIMEOUT = {
    status: 'failed',
    choice: 'agent_timeout',
    reason: 'pi 超时（7200 秒），已结束进程；没有在跑的工具，停在等模型回话',
    data: { timeoutSec: 7200, stuck: null, trace: 'T/agent-2.trace.md', events: 'T/agent-2.events.jsonl' }
  };
  const IDLE = (extra = {}) => ({
    status: 'failed',
    choice: 'agent_idle',
    reason: 'pi 空闲 1200 秒没有动静，已结束进程；卡在 bash：find / -name SystemContext.cs（已跑 1200 秒）',
    data: { idleSec: 1200, stuck: { toolName: 'bash', args: { command: 'find / -name SystemContext.cs' }, sinceSec: 1200 }, trace: 'T/agent-1.trace.md', events: 'T/agent-1.events.jsonl' },
    ...extra
  });
  const DIAG = { choice: 'diagnosed', reason: '卡在全盘 find', reply: '卡在 `find /` 全盘搜索。\n下次去 Library/PackageCache 找。' };

  scenario('Agent 卡死 → 不重试：诊断 → 回滚并存 diff → 评论写卡在哪 + 诊断 + diff → 释放、整轮停下', {
    tickets: [{ key: 1, labels: READY }, { key: 2, labels: READY }], idleSec: 900
  }, (s, view) => {
    plan(s, [IDLE({ file: { name: 'half.txt', content: 'half\n' } }), DIAG]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    const [dev, diag] = seen(s);
    assert.equal(seen(s).length, 2, '卡死不重试，只多叫一个诊断 Agent');
    assert.equal(dev.budget.idleSec, 900, 'AGENT_IDLE_SEC 传给 Agent');
    assert.ok(diag.goal.includes('find / -name SystemContext.cs') && diag.goal.includes('T/agent-1.trace.md'), diag.goal);
    assert.ok(diag.goal.includes('迟迟不返回'), '卡死时让诊断 Agent 查那条命令');
    assert.equal(diag.budget.idleSec, 300, '诊断 Agent 自己也有看门狗');

    const t = view(1);
    assert.equal(t.closed, false);
    assert.deepEqual(t.labels, READY, '释放：摘 afk-claimed、不贴 afk-failed、保留 ready');
    const c = t.comments.at(-1);
    assert.ok(c.includes('Agent 被强制结束（第 1 次，卡死；满 3 次转人工）'), c);
    assert.ok(c.includes('find / -name SystemContext.cs') && c.includes('下次去 Library/PackageCache 找') && c.includes('killed-1.diff'), c);

    const diff = path.join(path.dirname(dev.ticket), 'killed-1.diff');
    assert.match(readFileSync(diff, 'utf8'), /half\.txt[\s\S]*\+half/, '回滚前存下的 diff 带上新建的文件');
    assert.ok(!existsSync(path.join(s.root, 'half.txt')), '回滚了');
    assert.equal(gitOut(['status', '--porcelain'], s.root), '');
    assert.deepEqual(view(2).labels, READY, '整轮停下，不挑下一张');
    assert.match(r.stderr + r.stdout, /Agent 被强制结束（工单 [^）]+）：已诊断、回滚并释放/);
  });

  scenario('卡死、超时合并计数：满 AGENT_KILL_LIMIT 次 → 标失败转人工；下次接单读得到上次的诊断；诊断没跑成也照样评论', {
    tickets: [{ key: 1, labels: READY }], killLimit: 2
  }, (s, view) => {
    plan(s, [IDLE(), DIAG]);
    assert.equal(cli(s, ['dev']).code, 1);
    assert.deepEqual(view(1).labels, READY);

    plan(s, [TIMEOUT, { crash: true }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    assert.equal(seen(s).length, 4, '超时也不重试');
    assert.ok(readFileSync(seen(s)[2].ticket, 'utf8').includes('下次去 Library/PackageCache 找'), '第二轮的快照里有第一次的诊断');
    assert.ok(seen(s)[3].goal.includes('兜圈子'), '超时时让诊断 Agent 查时间花在哪');
    assertFailed(view(1));
    const c = view(1).comments.at(-1);
    assert.ok(c.includes('afk failed') && c.includes('Agent 被强制结束（第 2 次，超时；已满 2 次，不再自动重做）'), c);
    assert.ok(c.includes('pi 超时（7200 秒）'), c);
    assert.ok(c.includes('诊断 Agent 没跑成') && c.includes('工作区没有留下改动'), c);
  });

  scenario('回帖稿带进失败评论：一句话在前、回帖稿在后', { tickets: [{ key: 1, labels: READY }] }, (s, view) => {
    plan(s, [{ status: 'need_human', choice: 'ask', reason: '要接口文档', reply: '## 问题\n\n接口文档在哪？' }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 1);
    const last = seen(s).at(-1);
    assert.equal(path.basename(last.reply), 'reply-1.md');
    assert.equal(path.dirname(last.reply), path.dirname(last.ticket));
    const c = view(1).comments.at(-1);
    assert.ok(c.indexOf('要接口文档') >= 0 && c.indexOf('要接口文档') < c.indexOf('## 问题'), c);
    assert.ok(c.includes('接口文档在哪？'), c);
  });

  // ── 接单（J1）：接单评论 + 接单锁；重启清理自己的单，别人接的不碰 ──
  const ME = `${os.hostname()}/repo`;

  scenario('工人重启：自己上次没收尾的单被回滚、释放、重新排队做完；别人接的单不碰', {
    tickets: [{ key: 1, title: '别人接的单', labels: READY }, { key: 2, title: '我上次没收尾', labels: READY }],
    push: true
  }, (s, view) => {
    runScript(s, 'ticket_mark', { id: src.id(1), action: 'claimed', worker: 'wt9' });
    runScript(s, 'ticket_mark', { id: src.id(2), action: 'claimed', worker: ME });
    writeFileSync(path.join(s.root, 'half.txt'), '上次跑了一半\n');

    plan(s, DONE_STEPS('note.txt'));
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(view(2).closed, src.closes, '清理后重新排队、这一轮就做完了');
    assert.ok(view(2).comments.some((c) => c.includes('上一轮没做完') && c.includes(ME)), view(2).comments.join('\n'));
    assert.ok(!existsSync(path.join(s.root, 'half.txt')), '清理时回滚了上一轮的工作目录');

    assert.deepEqual(view(1).labels, [...READY, 'afk-claimed'], '别人接的单一律不碰');
    assert.deepEqual(view(1).comments, ['[miworkflow:claim worker=wt9]']);
  });

  scenario('--issue 点到别人接走的单：报错退出，工单上一个字都不写', {
    tickets: [{ key: 1, labels: READY }]
  }, (s, view) => {
    runScript(s, 'ticket_mark', { id: src.id(1), action: 'claimed', worker: 'wt9' });
    plan(s, []);
    const r = cli(s, ['dev', '--issue', src.id(1)]);
    assert.equal(r.code, 1);
    assert.deepEqual(seen(s), [], '没叫 Agent');
    assert.match(r.stderr + r.stdout, /已被 wt9 接走/);
    assert.deepEqual(view(1).labels, [...READY, 'afk-claimed']);
    assert.deepEqual(view(1).comments, ['[miworkflow:claim worker=wt9]']);
  });

  scenario('没抢到的单不挡后面的：队列里第一张被别的工人接走，就接着做下一张', {
    tickets: [{ key: 1, title: '别人接了', labels: READY }, { key: 2, title: '后面的', labels: READY }], push: true
  }, (s, view) => {
    runScript(s, 'ticket_mark', { id: src.id(1), action: 'claimed', worker: 'wt9' });
    plan(s, DONE_STEPS('two.txt'));
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(view(2).closed, src.closes);
    assert.ok(existsSync(path.join(s.root, 'two.txt')));
    assert.deepEqual(view(1).comments, ['[miworkflow:claim worker=wt9]'], '别人接的那张不碰');
  });

  // ── 审查分级（TODO G1）：REVIEW='auto' 时按工单标签 + DEV 升级决定审不审 ──
  const REVIEW_LABEL = 'needs-review';

  scenario('审查分级 auto：工单没贴要审查标签 → 跳过审查，DEV 完成后直接验证提交', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true, review: 'auto'
  }, (s, view) => {
    plan(s, [{ choice: 'done', reason: '做完', file: { name: 'note.txt', content: 'hi' } }]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen(s).length, 1, '只叫了开发 Agent');
    assert.ok(seen(s)[0].goal.includes('done_review'), '提示词告诉 DEV 可以升级审查');
    assertDelivered(view(1));
    assert.ok(view(1).comments.some((c) => c.includes('没审查')), view(1).comments.join('\n'));
    assert.ok(existsSync(path.join(s.root, 'note.txt')));
  });

  scenario('审查分级 auto：工单贴了要审查标签 → DEV 选 done 也照审', {
    tickets: [{ key: 1, title: '加个文件', labels: [...READY, REVIEW_LABEL] }], push: true, review: 'auto'
  }, (s, view) => {
    plan(s, DONE_STEPS());
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen(s).length, 2, '开发 + 审查');
    const t = view(1);
    assert.equal(t.closed, src.closes, '按各家语义交付');
    assert.ok(t.labels.includes('afk-delivered'), t.labels.join(','));
    assert.ok(!t.labels.includes('afk-claimed'), t.labels.join(','));
    assert.ok(view(1).comments.some((c) => c.includes('审查者看过，没有改动')), view(1).comments.join('\n'));
  });

  scenario('审查分级 auto：DEV 选 done_review 主动升级 → 照常审', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true, review: 'auto'
  }, (s, view) => {
    plan(s, [
      { choice: 'done_review', reason: '改了公共接口', file: { name: 'note.txt', content: 'hi' } },
      { choice: 'clean', reason: '没问题' }
    ]);
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen(s).length, 2, '升级后就该起审查');
    assertDelivered(view(1));
    assert.ok(view(1).comments.some((c) => c.includes('审查者看过，没有改动')), view(1).comments.join('\n'));
  });

  scenario('REVIEW=always → 没贴标签也每张都审', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true, review: 'always'
  }, (s, view) => {
    plan(s, DONE_STEPS());
    const r = cli(s, ['dev']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(seen(s).length, 2, '开发 + 审查');
    assertDelivered(view(1));
  });

  // ── 工位（J0 / J2）：`dev --dir <工位>` 在工位里做单，交本地单子分支 + 标「等合并」（不推 origin、不动主分支） ──
  const branchOf = (key) => `afk/${src.id(key)}`;

  scenario('工位 --dir：目录不存在就建 worktree；做完留 afk/<工单号> 分支、贴 afk-merging、评论写明分支，不推 origin、不动主分支', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true
  }, (s, view) => {
    const station = path.join(s.base, 'wt1');
    plan(s, DONE_STEPS('note.txt'));
    const r = cli(s, ['dev', '--dir', station]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(existsSync(station), '工位目录建出来了');
    assert.equal(gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], station), 'HEAD', '工位是分离 HEAD');
    assert.equal(gitOut(['status', '--porcelain'], station), '', '工位干净');

    const branch = branchOf(1);
    assert.equal(gitOut(['rev-parse', branch], s.root), gitOut(['rev-parse', 'HEAD'], station), '那一笔挂在 afk/<工单号> 上');
    const subject = gitOut(['log', '-1', '--pretty=%s', branch], s.root);
    assert.ok(subject.startsWith(src.commitPrefix(1)) && subject.endsWith('加个文件'), subject);

    const t = view(1);
    assert.equal(t.closed, false, '等合并不关单');
    assert.ok(t.labels.includes('afk-merging') && !t.labels.includes('afk-claimed'), t.labels.join(','));
    assert.ok(!t.labels.includes('afk-delivered'), t.labels.join(','));
    assert.ok(t.comments.at(-1).includes(branch), t.comments.at(-1));

    assert.equal(gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], s.root), 'main', '主分支没被碰');
    assert.equal(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), 'init', '没推 origin');
    assert.ok(existsSync(path.join(s.root, 'note.txt')) === false, '改动只落在工位，主目录没有');
  });

  scenario('工位 --dir：主分支取自 origin/HEAD（当前分支挪到别处也一样），开工时对齐到最新的本地主分支', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true, branch: 'develop'
  }, (s, view) => {
    const station = path.join(s.base, 'wt2');
    // 当前分支不是主分支、还比主分支多一笔：工位仍要认 origin/HEAD 指向的 develop
    git(['checkout', '-q', '-b', 'scratch'], s.root);
    writeFileSync(path.join(s.root, 'scratch.txt'), 'x\n');
    git(['add', '-A'], s.root);
    git(['commit', '-qm', 'scratch 上的一笔'], s.root);
    plan(s, DONE_STEPS('one.txt'));
    const r = cli(s, ['dev', '--dir', station]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(!existsSync(path.join(station, 'scratch.txt')), '工位从 develop 建，不带当前分支的改动');
    assert.equal(gitOut(['log', '-1', '--pretty=%s', `${branchOf(1)}~1`], s.root), 'init', '这一笔直接基于 develop 顶端');
    assert.equal(gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], s.root), 'scratch', '主目录当前分支没动');
    assert.ok(view(1).labels.includes('afk-merging'), view(1).labels.join(','));
  });

  scenario('工位 --dir：工位不干净、这个工人名下没有没收尾的单 → 拒跑并说清原因，不动工单、不叫 Agent、不回滚人的改动', {
    tickets: [{ key: 1, labels: READY }, { key: 2, labels: READY }]
  }, (s, view) => {
    const station = path.join(s.base, 'wt3');
    git(['worktree', 'add', '--detach', station, 'main'], s.root);
    writeFileSync(path.join(station, 'dirty.txt'), 'x\n');
    runScript(s, 'ticket_mark', { id: src.id(2), action: 'claimed', worker: 'wt9' });
    plan(s, DONE_STEPS());
    const r = cli(s, ['dev', '--dir', station]);
    assert.equal(r.code, 1);
    const said = r.stderr + r.stdout;
    assert.match(said, /不干净/);
    assert.match(said, /dirty\.txt/, '说清哪些文件');
    assert.match(said, /不是这个工人没收尾的单留下的/);
    assert.doesNotMatch(said, /工位用不了/);
    assert.deepEqual(seen(s), [], '没叫 Agent');
    assert.deepEqual(view(1).labels, READY, '工单一个字都没动');
    assert.deepEqual(view(1).comments, []);
    assert.deepEqual(view(2).labels, [...READY, 'afk-claimed'], '别人接的单不碰');
    assert.deepEqual(view(2).comments, ['[miworkflow:claim worker=wt9]']);
    assert.ok(existsSync(path.join(station, 'dirty.txt')), '人的改动没被回滚');
  });

  scenario('工位 --dir：工人做到一半被强关（工位里留着没提交的改动）→ 重启先回滚并释放自己那张单，再照常做完', {
    tickets: [{ key: 1, title: '做到一半', labels: READY }]
  }, (s, view) => {
    const station = path.join(s.base, 'wt5');
    git(['worktree', 'add', '--detach', station, 'main'], s.root);
    const me = `${os.hostname()}/wt5`;
    runScript(s, 'ticket_mark', { id: src.id(1), action: 'claimed', worker: me, cwd: station });
    mkdirSync(path.join(station, 'practice'));
    writeFileSync(path.join(station, 'practice', 'e.md'), '半成品\n');
    writeFileSync(path.join(station, 'app.txt'), '改了一半\n');

    plan(s, DONE_STEPS('note.txt'));
    const r = cli(s, ['dev', '--dir', station]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.doesNotMatch(r.stderr + r.stdout, /工位用不了|不干净/);
    assert.match(r.stdout, /清理自己没收尾的 .*已回滚并释放/);

    const t = view(1);
    const released = t.comments.findIndex((c) => c.includes('上一轮没做完') && c.includes(me));
    assert.ok(released >= 0, t.comments.join('\n'));
    assert.ok(t.comments.findIndex((c, i) => i > released && c.includes(branchOf(1))) > released, '先释放、再重新接单做完');
    assert.ok(t.labels.includes('afk-merging') && !t.labels.includes('afk-claimed'), t.labels.join(','));

    assert.ok(!existsSync(path.join(station, 'practice', 'e.md')), '未跟踪的半成品被回滚');
    assert.doesNotMatch(readFileSync(path.join(station, 'app.txt'), 'utf8'), /改了一半/, '改了一半的文件被回滚');
    assert.equal(gitOut(['status', '--porcelain'], station), '');
    assert.deepEqual(gitOut(['show', '--name-only', '--pretty=', branchOf(1)], s.root).split('\n'), ['note.txt'], '这一笔不带上一轮的半成品');
  });

  scenario('工位 --dir：等合并的单不再被挑中；依赖它的单仍被挡住', {
    tickets: [{ key: 1, title: '等合并', labels: READY }, { key: 2, title: '依赖它', labels: READY, deps: [1] }]
  }, (s, view) => {
    const station = path.join(s.base, 'wt4');
    plan(s, DONE_STEPS('one.txt'));
    assert.equal(cli(s, ['dev', '--dir', station, '--max', '1']).code, 0);
    assert.ok(view(1).labels.includes('afk-merging'), view(1).labels.join(','));

    const calls = seen(s).length;
    plan(s, []);
    const r = cli(s, ['dev', '--dir', station]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(seen(s).length, calls, '等合并的不再挑、被挡住的也做不了，一个 Agent 都不叫');
    assert.deepEqual(view(2).labels, READY, '依赖它的单仍被挡住');
  });
}
