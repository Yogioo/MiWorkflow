// templates/tapd/ 的测试：_tapd.mjs 助手（假 tapd-cli + 假 OpenAPI）、source.mjs、占位的 ticket_* 脚本。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAKE_TOKEN, openApiLog, readTapdState, startFakeOpenApi, story, tapdEnv, writeTapdState } from './support/tapd-fakes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(ROOT, 'templates', 'tapd');
const { runTapd, tapdJson, firstJson, mask, openApi } = await import(pathToFileURL(path.join(TPL, 'scripts', '_tapd.mjs')).href);

const TMP = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-tapd-'));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const stateFile = (seed) => { const f = path.join(TMP, `state${++n}.json`); writeTapdState(f, seed); return f; };

// 进程级环境变量：同文件内用例按顺序跑，每个用例自己设好
function useEnv(env) {
  for (const k of ['MIWORKFLOW_TAPD', 'FAKE_TAPD_STATE', 'TAPD_API_ENDPOINT', 'TAPD_TOKEN']) delete process.env[k];
  Object.assign(process.env, env);
}

test('runTapd：MIWORKFLOW_TAPD 生效，参数不经 shell 原样传过去', () => {
  const f = stateFile();
  useEnv(tapdEnv(f));
  const weird = 'description=a & echo pwned | more "q" %PATH% $HOME `x`\n第二行';
  const r = tapdJson(['comment', 'add', 'entry_type=stories', 'entry_id=7', weird]);
  assert.equal(r.data.Comment.description, weird.slice('description='.length));
  assert.deepEqual(readTapdState(f).calls, [['comment', 'add', 'entry_type=stories', 'entry_id=7', weird]]);
});

test('tapdJson：comment add 的 JSON 后面多一行也能解析', () => {
  const f = stateFile();
  useEnv(tapdEnv(f));
  const raw = runTapd(['comment', 'add', 'entry_type=stories', 'entry_id=1', 'description=hi']);
  assert.match(raw, /已写入/);
  assert.equal(tapdJson(['comment', 'add', 'entry_type=stories', 'entry_id=1', 'description=hi']).status, 1);
});

test('firstJson：只取第一段，字符串里的括号不算', () => {
  assert.deepEqual(firstJson('{"a":"}{\\"]"}\n已写入 /tmp/comment.log\n{"b":1}'), { a: '}{"]' });
  assert.deepEqual(firstJson('[1,[2]] trailing'), [1, [2]]);
  assert.throws(() => firstJson('no json here'), /没有返回 JSON/);
  assert.throws(() => firstJson('{"a":'), /不完整/);
});

test('runTapd：瞬时错误最多重试 2 次', () => {
  const ok = stateFile({ fail: { times: 2, message: 'network timeout' } });
  useEnv(tapdEnv(ok));
  assert.equal(tapdJson(['story', 'list', 'id=1'], { retryDelayMs: 0 }).status, 1);
  assert.equal(readTapdState(ok).calls.length, 3);

  const bad = stateFile({ fail: { times: 3, message: 'network timeout' } });
  useEnv(tapdEnv(bad));
  assert.throws(() => runTapd(['story', 'list'], { retryDelayMs: 0 }), /network timeout/);
  assert.equal(readTapdState(bad).calls.length, 3, '1 次 + 重试 2 次');

  const perm = stateFile({ fail: { times: 5, message: 'invalid param' } });
  useEnv(tapdEnv(perm));
  assert.throws(() => runTapd(['story', 'list'], { retryDelayMs: 0 }), /invalid param/);
  assert.equal(readTapdState(perm).calls.length, 1, '非瞬时错误不重试');
});

test('报错信息里 32 位十六进制令牌打码', () => {
  const f = stateFile({ fail: { times: 1, message: `auth failed token=${FAKE_TOKEN}` } });
  useEnv(tapdEnv(f));
  assert.throws(() => runTapd(['story', 'list']), (err) => {
    assert.doesNotMatch(err.message, new RegExp(FAKE_TOKEN));
    assert.match(err.message, /token=\*\*\*/);
    return true;
  });
  assert.equal(mask('x ABCDEF0123456789abcdef0123456789 y'), 'x *** y');
  assert.equal(mask('短的 abc123 不动'), '短的 abc123 不动');
});

test('假 tapd-cli：连字符参数被静默丢掉，comment list 剥 HTML', () => {
  const f = stateFile({
    stories: [story(1, { label: 'ready-for-agent' }), story(2)],
    comments: [{ id: '1', entry_type: 'stories', entry_id: '1', description: '<p>看<img src="/tfl/a.png"/></p>', author: 'h', created: '1' }]
  });
  useEnv(tapdEnv(f));
  assert.equal(tapdJson(['story', 'list', 'label=ready-for-agent']).data.length, 1);
  assert.equal(tapdJson(['story', 'list', 'id-x=1']).data.length, 2, '连字符参数丢掉 = 不过滤');
  assert.equal(tapdJson(['comment', 'list', 'entry_type=stories', 'entry_id=1']).data[0].Comment.description, '看');
});

test('openApi：带 Bearer 令牌读到完整 HTML；缺配置 / 令牌错都报错且打码', async () => {
  const html = '<p>看<img src="/tfl/a.png"/></p>';
  const f = stateFile({ comments: [{ id: '1', entry_type: 'stories', entry_id: '9', description: html, author: 'h', created: '1' }] });
  const api = await startFakeOpenApi(f);
  try {
    useEnv(tapdEnv(f, api.endpoint));
    const r = await openApi('/comments', { query: { workspace_id: '1000', entry_type: 'stories', entry_id: '9' } });
    assert.equal(r.data[0].Comment.description, html);
    const log = openApiLog(f);
    assert.equal(log.at(-1).auth, `Bearer ${FAKE_TOKEN}`);
    assert.match(log.at(-1).url, /entry_id=9/);

    useEnv(tapdEnv(f, api.endpoint, 'fedcba9876543210fedcba9876543210'));
    await assert.rejects(openApi('/comments'), (err) => {
      assert.match(err.message, /401/);
      assert.doesNotMatch(err.message, /fedcba9876543210fedcba9876543210/);
      return true;
    });

    useEnv({ TAPD_TOKEN: FAKE_TOKEN });
    await assert.rejects(openApi('/comments'), /TAPD_API_ENDPOINT/);
    useEnv({ TAPD_API_ENDPOINT: api.endpoint });
    await assert.rejects(openApi('/comments'), /TAPD_TOKEN/);
  } finally {
    await api.close();
  }
});

test('source.mjs：优先级映射与提交信息', async () => {
  process.env.TAPD_NPC_ROLE = 'bot-npc';
  const src = await import(`${pathToFileURL(path.join(TPL, 'source.mjs')).href}?t=${Date.now()}`);
  delete process.env.TAPD_NPC_ROLE;
  assert.deepEqual(['高', '中', '', '低', '紧急', undefined].map(src.priorityOf), [1, 2, 2, 3, 2, 2]);
  assert.deepEqual(Object.values(src.LABELS), ['ready-for-agent', 'afk-claimed', 'afk-delivered', 'afk-failed']);
  const t = { id: '1001', ref: '1001', title: '做个按钮' };
  assert.equal(src.commitMessage(t, 'dev').message, '--story=1001 --user=bot-npc 做个按钮');
  assert.equal(src.commitMessage(t, 'review').message, '--story=1001 --user=bot-npc 审查修正：<一句话>');
  assert.equal(src.commitMessage(t, 'fix').message, '--story=1001 --user=bot-npc 验证不过修正：<一句话>');
  assert.throws(() => src.commitMessage(t, 'x'), /不认 kind/);
});

test('占位的 ticket_* 脚本报 failed', () => {
  const home = path.join(TMP, 'home');
  mkdirSync(home, { recursive: true });
  for (const t of ['_shared', 'tapd']) cpSync(path.join(ROOT, 'templates', t), home, { recursive: true });
  for (const name of ['ticket_ready', 'ticket_view', 'ticket_mark']) {
    const r = spawnSync(process.execPath, [path.join(home, 'scripts', `${name}.mjs`)], { input: '{}', encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 'failed', name);
    assert.match(out.say, /还没实现/);
  }
});
