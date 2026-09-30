// TAPD 讨论流程的脚本契约测试：discuss_list / discuss_view / discuss_post / tickets_create。
// 直接喂 stdin JSON 跑脚本（同 template-tapd.test.mjs 的做法），假 tapd-cli + 假 OpenAPI，不碰真网络。
// 端到端（同一套场景 × 两家工单源）见 tests/discuss-tapd.test.mjs。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTapdState, startFakeOpenApi, story, tapdEnv, writeTapdState } from './support/tapd-fakes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-tapd-discuss-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const HOME = path.join(TMP, 'home');
mkdirSync(HOME, { recursive: true });
for (const t of ['_shared', 'tapd']) cpSync(path.join(ROOT, 'templates', t), HOME, { recursive: true });

let n = 0;
const stateFile = (seed) => { const f = path.join(TMP, `state${++n}.json`); writeTapdState(f, seed); return f; };
const runScript = (name, input, env) => {
  const r = spawnSync(process.execPath, [path.join(HOME, 'scripts', `${name}.mjs`)], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env }
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(r.stdout), stderr: r.stderr };
};

const D = '1152360842001006001';
const P = '1152360842001006002';
const comment = (id, entry_id, description, author = 'alice') => ({
  id, entry_type: 'stories', entry_id, description, author, created: `2026-01-01 00:00:${String(id).padStart(2, '0')}`
});
const mark = (extra = '') => `[miworkflow:discuss hash=deadbeef seen=1 cli=cmd${extra}]`;
const withEnv = (f, api, extra = {}) => ({ ...tapdEnv(f, api.endpoint), TAPD_NPC_ROLE: 'bot-npc', ...extra });

test('discuss_list：只挑贴了 agent-discuss 且阶段标为空 / grilling / spec 的需求，按需求号升序', async () => {
  const f = stateFile({ stories: [
    story(D, { name: '要追问的', label: 'agent-discuss|discuss:grilling' }),
    story('1152360842001006003', { name: '刚入队', label: 'agent-discuss' }),
    story('1152360842001006004', { name: '已拆完', label: 'agent-discuss|discuss:ticketed' }),
    story('1152360842001006005', { name: '别家的', label: 'other' })
  ] });
  const api = await startFakeOpenApi(f);
  try {
    const { out } = runScript('discuss_list', { enter: 'agent-discuss', grilling: 'discuss:grilling', spec: 'discuss:spec' }, withEnv(f, api));
    assert.deepEqual(out.data.items.map((i) => i.id), [D, '1152360842001006003']);
    assert.equal(out.data.items[0].ref, `story ${D}`);
    assert.equal(out.data.items[0].title, '要追问的');
    assert.deepEqual(out.data.items[0].labels, ['agent-discuss', 'discuss:grilling']);
  } finally { await api.close(); }
});

test('discuss_view：出规范形状——body 是描述 Markdown、spec 取最新 kind=spec 评论且它不出现在 comments 里', async () => {
  const f = stateFile({
    stories: [story(D, {
      name: '讨论单', label: 'agent-discuss|discuss:spec',
      description: '<p>人写的原文</p><p><strong>粗</strong></p>'
    })],
    comments: [
      comment(1, D, '<p>问题一</p><p>[miworkflow:discuss hash=aaa seen=1 cli=cmd]</p>'),
      comment(2, D, '<h2>Problem Statement</h2><p>第一版</p><p>[miworkflow:discuss hash=bbb seen=2 kind=spec]</p>'),
      comment(3, D, '<p>人补一句</p>'),
      comment(4, D, '<p>按评论改写</p><p>[miworkflow:discuss hash=ccc seen=3 cli=cmd]</p>')
    ]
  });
  const api = await startFakeOpenApi(f);
  try {
    const { out } = runScript('discuss_view', { id: D }, withEnv(f, api));
    const d = out.data;
    assert.equal(d.id, D);
    assert.equal(d.ref, `story ${D}`);
    assert.equal(d.body, '人写的原文\n\n**粗**');
    assert.equal(d.spec, '## Problem Statement\n\n第一版', '当前 spec = 最新一条 kind=spec 评论的正文');
    assert.deepEqual(d.labels, ['agent-discuss', 'discuss:spec']);
    assert.deepEqual(d.comments.map((c) => [c.author, c.text, c.ai]), [
      ['alice', '问题一', true],
      ['alice', '人补一句', false],
      ['alice', '按评论改写', true]
    ]);
    assert.equal(d.comments[0].mark.hash, 'aaa');
    assert.equal(d.comments[0].mark.seen, 1);
    assert.equal(d.comments[1].mark, null, '人的评论没有 mark');
    assert.equal(d.comments[0].mark.kind, undefined, 'mark 不把 TAPD 自己的 kind 泄给任务');
  } finally { await api.close(); }
});

test('discuss_post：发评论（末尾一行纯文本标记）/ 写 spec 评论 / 贴摘标签并回读', async () => {
  const f = stateFile({ stories: [
    story(D, { name: '讨论单', label: 'agent-discuss|discuss:grilling', description: '<p>原文</p>' }),
    story(P, { name: '父单', label: '', description: '<p>父</p>' })
  ] });
  const api = await startFakeOpenApi(f);
  try {
    const env = withEnv(f, api);
    runScript('discuss_post', { id: D, body: '第一轮追问', mark: { hash: 'aaaa1111', seen: 0, cli: 'cmd' } }, env);
    runScript('discuss_post', { id: D, addLabel: 'discuss:spec', removeLabel: 'discuss:grilling' }, env);
    let st = readTapdState(f);
    assert.deepEqual(st.stories[0].label.split('|'), ['agent-discuss', 'discuss:spec']);
    assert.equal(st.comments.length, 1);
    assert.match(st.comments[0].description, /第一轮追问\n\n\[miworkflow:discuss hash=aaaa1111 seen=0 cli=cmd\]$/, '标记是评论末尾一行纯文本');

    runScript('discuss_post', { id: D, body: '已按评论改写', mark: { hash: 'bbbb2222', seen: 1 }, spec: '## Solution\n\n第一版' }, env);
    st = readTapdState(f);
    assert.equal(st.comments.length, 3);
    assert.match(st.comments[1].description, /^## Solution\n\n第一版\n\n\[miworkflow:discuss hash=bbbb2222 seen=1 kind=spec\]$/, 'spec 评论在前、带 kind=spec');
    assert.match(st.comments[2].description, /^已按评论改写\n\n\[miworkflow:discuss hash=bbbb2222 seen=1\]$/, '回复评论在后（任务的判轮认最后一条）');

    // 摘回 grilling、再贴 spec，标签始终按 | 分隔写回
    runScript('discuss_post', { id: D, addLabel: 'discuss:ticketed', removeLabel: 'discuss:spec' }, env);
    st = readTapdState(f);
    assert.deepEqual(st.stories[0].label.split('|'), ['agent-discuss', 'discuss:ticketed']);
  } finally { await api.close(); }
});

test('tickets_create：建子需求（parent_id、标签、优先级）+ 写前后置依赖（form）+ 回查；结构有问题一张不建', async () => {
  const f = stateFile({ stories: [story(D, { name: '讨论单', label: 'agent-discuss|discuss:spec', description: '<p>原文</p>' })] });
  const api = await startFakeOpenApi(f);
  try {
    const env = withEnv(f, api);
    const { out } = runScript('tickets_create', {
      parentId: D,
      tickets: [
        { key: 't1', title: '做甲', body: '## What to build\n\n甲的行为', priority: 'P1', review: true, blockedBy: [] },
        { key: 't2', title: '做乙', body: '## What to build\n\n乙的行为', priority: 'P3', review: false, blockedBy: ['t1'] }
      ]
    }, env);
    assert.deepEqual(out.data.problems, []);
    assert.equal(out.data.tickets.length, 2);

    const st = readTapdState(f);
    const kids = st.stories.filter((s) => s.parent_id === D).sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.equal(kids.length, 2);
    assert.deepEqual(kids.map((s) => [s.name, s.label, s.priority_label]), [
      ['做甲', 'ready-for-agent|needs-review', '高'],
      ['做乙', 'ready-for-agent', '低']
    ]);
    assert.equal(kids[0].description, '## What to build\n\n甲的行为', '正文原样给 description（tapd-cli 自己转 HTML）');
    // 依赖落成原生前后置关系：t1(due) → t2(begin)
    assert.deepEqual(st.relations, [{
      id: st.relations[0].id, workspace_id: '1000', workitem_type: 'story', workitem_id: kids[0].id,
      src_field: 'due', dst_workspace_id: '1000', dst_workitem_type: 'story', dst_workitem_id: kids[1].id,
      dst_field: 'begin', relation_type: 'after', lag_time: '0'
    }]);

    // 结构有问题（依赖不认识的 key / 成环）→ 一张不建，problems 非空
    const before = readTapdState(f).stories.length;
    const bad = runScript('tickets_create', {
      parentId: D,
      tickets: [
        { key: 'a', title: '甲', priority: 'P2', blockedBy: ['nope'] },
        { key: 'b', title: '乙', priority: 'P2', blockedBy: ['c'] },
        { key: 'c', title: '丙', priority: 'P2', blockedBy: ['b'] }
      ]
    }, env);
    assert.equal(bad.out.data.tickets.length, 0);
    assert.ok(bad.out.data.problems.some((p) => /不认识的 key：nope/.test(p)), bad.out.data.problems.join('；'));
    assert.ok(bad.out.data.problems.some((p) => /成环/.test(p)), bad.out.data.problems.join('；'));
    assert.equal(readTapdState(f).stories.length, before, '有问题的结构一张都不建');
  } finally { await api.close(); }
});
