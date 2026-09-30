// templates/tapd/ 的测试：_tapd.mjs 助手（假 tapd-cli + 假 OpenAPI）、source.mjs、占位的 ticket_* 脚本。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAKE_TOKEN, openApiLog, readTapdState, startFakeOpenApi, story, tapdEnv, writeTapdState } from './support/tapd-fakes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TPL = path.join(ROOT, 'templates', 'tapd');
const { runTapd, tapdJson, firstJson, mask, openApi, htmlToMarkdown } = await import(pathToFileURL(path.join(TPL, 'scripts', '_tapd.mjs')).href);

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

const HOME = path.join(TMP, 'home');
mkdirSync(HOME, { recursive: true });
for (const t of ['_shared', 'tapd']) cpSync(path.join(ROOT, 'templates', t), HOME, { recursive: true });

const runScript = (name, input, env) => {
  const r = spawnSync(process.execPath, [path.join(HOME, 'scripts', `${name}.mjs`)], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env }
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: JSON.parse(r.stdout), stderr: r.stderr };
};

test('ticket_ready：只看标签入队、工单号为字符串、优先级映射与排序', () => {
  const f = stateFile({
    stories: [
      story('1152360842001004003', { label: 'ready-for-agent', priority: '低' }),
      story('1152360842001004002', { label: 'ready-for-agent', priority: '' }),
      story('1152360842001004001', { label: 'ready-for-agent', priority: '中', owner: '' }),
      story('1152360842001004010', { label: 'x|ready-for-agent', priority: '高' }),
      story('1152360842001004011', { label: 'ready-for-agent', priority: '紧急' }),
      story('1152360842001004020', { label: 'ready-for-agent|afk-claimed', priority: '高' }),
      story('1152360842001004021', { label: 'ready-for-agent|afk-delivered' }),
      story('1152360842001004022', { label: 'afk-failed|ready-for-agent' }),
      story('1152360842001004030', { label: 'other', priority: '高' })
    ]
  });
  const { out, stderr } = runScript('ticket_ready', {}, tapdEnv(f));
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.data.ready.map((t) => [t.id, t.priority]), [
    ['1152360842001004010', 1],
    ['1152360842001004001', 2],
    ['1152360842001004002', 2],
    ['1152360842001004011', 2],
    ['1152360842001004003', 3]
  ]);
  for (const t of out.data.ready) {
    assert.equal(typeof t.id, 'string');
    assert.equal(t.ref, `story ${t.id}`);
    assert.equal(t.title, `story ${t.id}`);
  }
  assert.deepEqual(out.data.blocked, []);
  assert.match(out.say, /紧急/);
  assert.match(stderr, /紧急/);
  const calls = readTapdState(f).calls;
  assert.equal(calls.length, 1, '一次列表请求拿全部候选');
  assert.deepEqual(calls[0].slice(0, 3), ['story', 'list', 'label=ready-for-agent']);
  assert.ok(!calls.some((c) => c[0] === 'bug'), '缺陷不处理');
});

test('ticket_ready：空壳需求进 blocked，贴 afk-failed + 评论；干跑不改 TAPD；只对描述为空的读评论', async () => {
  const seed = () => ({
    stories: [
      story('1152360842001004101', { label: 'ready-for-agent', description: '<p> &nbsp;</p>' }),
      story('1152360842001004102', { label: 'ready-for-agent', description: '' }),
      story('1152360842001004103', { label: 'ready-for-agent', description: '<p><img src="/tfl/a.png"/></p>' }),
      story('1152360842001004104', { label: 'ready-for-agent' })
    ],
    comments: [{ id: '1', entry_type: 'stories', entry_id: '1152360842001004102', description: '<p><img src="/tfl/b.png"/></p>', author: 'h', created: '1' }]
  });

  const dry = stateFile(seed());
  const api1 = await startFakeOpenApi(dry);
  try {
    const { out } = runScript('ticket_ready', {}, { ...tapdEnv(dry, api1.endpoint), AGENTFLOW_DRY_RUN: '1', TAPD_NPC_ROLE: '' });
    assert.deepEqual(out.data.ready.map((t) => t.id), ['1152360842001004102', '1152360842001004103', '1152360842001004104']);
    assert.deepEqual(out.data.blocked.map((t) => t.id), ['1152360842001004101']);
    assert.match(out.data.blocked[0].reason, /需求为空/);
    const st = readTapdState(dry);
    assert.equal(st.calls.length, 1, '干跑不改 TAPD');
    assert.equal(st.stories[0].label, 'ready-for-agent');
    assert.deepEqual(openApiLog(dry).map((l) => /entry_id=(\d+)/.exec(l.url)[1]), ['1152360842001004101', '1152360842001004102']);
  } finally {
    await api1.close();
  }

  const live = stateFile(seed());
  const api2 = await startFakeOpenApi(live);
  try {
    const { out } = runScript('ticket_ready', {}, { ...tapdEnv(live, api2.endpoint), TAPD_NPC_ROLE: 'bot-npc' });
    assert.deepEqual(out.data.blocked.map((t) => t.id), ['1152360842001004101']);
    assert.match(out.data.blocked[0].reason, /afk-failed/);
    const st = readTapdState(live);
    assert.equal(st.stories[0].label, 'ready-for-agent|afk-failed');
    const c = st.comments.at(-1);
    assert.equal(c.entry_id, '1152360842001004101');
    assert.equal(c.description, '需求为空，请补充描述后摘掉 afk-failed');
    assert.equal(c.author, 'bot-npc');
  } finally {
    await api2.close();
  }
});

test('htmlToMarkdown：标题 / 表格 / 列表 / 加粗 / 行内代码 / 链接 / 实体', () => {
  const md = htmlToMarkdown([
    '<h2>验收</h2><p>要 <strong>加粗</strong>、<code>npm&nbsp;test</code> 和 <a href="https://x.cn/a">链接</a> &amp; 实体</p>',
    '<ul><li>一</li><li>二<ol><li>二.1</li></ol></li></ul>',
    '<table><tbody><tr><th>列A</th><th>列B</th></tr><tr><td>1|2</td><td><b>是</b><br>换行</td></tr></tbody></table>',
    '<img alt="图" src=\'/tfl/x.png\'>'
  ].join(''), { img: (src, alt) => `IMG(${src},${alt})` });
  assert.match(md, /^## 验收$/m);
  assert.match(md, /要 \*\*加粗\*\*、`npm test` 和 \[链接\]\(https:\/\/x\.cn\/a\) & 实体/);
  assert.match(md, /^- 一\n- 二\n {3}1\. 二\.1$/m);
  assert.match(md, /^\| 列A \| 列B \|\n\| --- \| --- \|\n\| 1\\\|2 \| \*\*是\*\*<br>换行 \|$/m);
  assert.match(md, /IMG\(\/tfl\/x\.png,图\)/);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6]);

test('ticket_view：快照含描述 + 全部评论（走 OpenAPI），HTML 转 Markdown，图片按魔数落到 images/', async () => {
  const id = '1152360842001004201';
  const f = stateFile({
    stories: [story(id, {
      name: '做个按钮',
      description: '<h3>背景</h3><table><tr><th>项</th><th>值</th></tr><tr><td>颜色</td><td>红</td></tr></table>' +
        '<ul><li><strong>必须</strong>能点</li></ul><p><img width=10 src=/tfl/a.png></p><p><img src="/tfl/missing.png" alt="坏"></p>'
    })],
    comments: [
      { id: '2', entry_type: 'stories', entry_id: id, description: '<p>第二条<img src=\'/tfl/b.jpg\'/><img src="/tfl/c.png?a=1&amp;b=2"></p>', author: 'bob', created: '2026-01-02 00:00:00' },
      { id: '1', entry_type: 'stories', entry_id: id, description: '<p>第一条 <b>要点</b></p>', author: 'amy', created: '2026-01-01 00:00:00' },
      { id: '3', entry_type: 'stories', entry_id: 'other', description: '别家的', author: 'x', created: '1' }
    ],
    files: { '/tfl/a.png': PNG.toString('base64'), '/tfl/b.jpg': JPG.toString('base64'), '/tfl/c.png': PNG.toString('base64') }
  });
  const api = await startFakeOpenApi(f);
  try {
    const home = path.join(TMP, 'view-home');
    const { out, stderr } = runScript('ticket_view', { id }, { ...tapdEnv(f, api.endpoint), AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'run1' });
    assert.equal(out.status, 'ok');
    const file = path.join(home, 'logs', 'run1', 'tickets', id, 'ticket.md');
    assert.deepEqual(out.data, { id, ref: `story ${id}`, title: '做个按钮', file });
    assert.deepEqual(Object.keys(out.data), ['id', 'ref', 'title', 'file'], '出参形状与 GitHub 相同');

    const md = readFileSync(file, 'utf8');
    assert.match(md, /^# story 1152360842001004201 做个按钮/);
    assert.match(md, /^### 背景$/m);
    assert.match(md, /^\| 项 \| 值 \|\n\| --- \| --- \|\n\| 颜色 \| 红 \|$/m);
    assert.match(md, /^- \*\*必须\*\*能点$/m);
    assert.match(md, /!\[\]\(images\/1\.png\)/);
    assert.match(md, /（图片未能下载：\/tfl\/missing\.png）/, '失败留占位');
    assert.match(stderr, /图片下载失败 \/tfl\/missing\.png/);
    assert.ok(md.indexOf('amy 评论') < md.indexOf('bob 评论'), '评论按时间排');
    assert.match(md, /第一条 \*\*要点\*\*/);
    assert.match(md, /第二条!\[\]\(images\/2\.jpg\)/);
    assert.doesNotMatch(md, /别家的/);
    assert.deepEqual(readFileSync(path.join(path.dirname(file), 'images', '1.png')), PNG);
    assert.deepEqual(readFileSync(path.join(path.dirname(file), 'images', '2.jpg')), JPG);

    const calls = readTapdState(f).calls;
    assert.ok(!calls.some((c) => c[0] === 'comment'), '评论不走 tapd-cli comment list');
    assert.deepEqual(calls[0].slice(0, 4), ['story', 'list', `id=${id}`, 'with_v_status=1']);
    assert.deepEqual(calls.filter((c) => c[0] === 'attachment').map((c) => c.find((a) => a.startsWith('image_path='))),
      ['image_path=/tfl/a.png', 'image_path=/tfl/missing.png', 'image_path=/tfl/b.jpg', 'image_path=/tfl/c.png?a=1&b=2']);
    assert.match(md, /!\[\]\(images\/3\.png\)/, 'src 里的实体解码后再下载、再改写');
    const comment = openApiLog(f).filter((l) => l.url.startsWith('/comments'));
    assert.equal(comment.length, 1);
    assert.match(comment[0].url, /entry_type=stories/);
    assert.match(comment[0].url, new RegExp(`entry_id=${id}`));
  } finally {
    await api.close();
  }
});

test('ticket_view：每单最多 30 张图，超出的写明还有 N 张未下载；找不到需求报 failed', async () => {
  const id = '1152360842001004202';
  const imgs = Array.from({ length: 32 }, (_, k) => `<img src="/tfl/p${k}.png">`);
  const files = Object.fromEntries(Array.from({ length: 32 }, (_, k) => [`/tfl/p${k}.png`, PNG.toString('base64')]));
  const f = stateFile({
    stories: [story(id, { description: `<p>${imgs.slice(0, 20).join('')}</p>` })],
    comments: [{ id: '1', entry_type: 'stories', entry_id: id, description: `<p>${imgs.slice(20).join('')}</p>`, author: 'a', created: '1' }],
    files
  });
  const api = await startFakeOpenApi(f);
  try {
    const home = path.join(TMP, 'view-cap');
    const env = { ...tapdEnv(f, api.endpoint), AGENTFLOW_HOME: home, AGENTFLOW_RUN_ID: 'run2' };
    const { out } = runScript('ticket_view', { id }, env);
    assert.equal(out.status, 'ok');
    const md = readFileSync(out.data.file, 'utf8');
    assert.match(md, /还有 2 张图片未下载/);
    assert.match(md, /images\/30\.png/);
    assert.doesNotMatch(md, /images\/31\.png/);
    assert.equal(readTapdState(f).calls.filter((c) => c[0] === 'attachment').length, 30);

    const missing = runScript('ticket_view', { id: '404' }, env).out;
    assert.equal(missing.status, 'failed');
    assert.match(missing.say, /找不到 story 404/);
  } finally {
    await api.close();
  }
});

const SID = '1152360842001004500';
const patchState = (f, patch) => writeFileSync(f, JSON.stringify({ ...readTapdState(f), ...patch }, null, 2));

async function withMark(label, fn, patch) {
  const f = stateFile({ stories: [story(SID, { label, status: 'doing', owner: 'alice' })] });
  if (patch) patchState(f, patch);
  const api = await startFakeOpenApi(f);
  try {
    const mark = (input, env = {}) => runScript('ticket_mark', { id: SID, ...input }, { ...tapdEnv(f, api.endpoint), TAPD_NPC_ROLE: 'bot-npc', ...env });
    await fn(mark, f);
  } finally {
    await api.close();
  }
}

test('ticket_mark：四种 action 的标签变化，| 分隔；done 不改状态与处理人；出参形状同 GitHub', async () => {
  const cases = [
    ['claimed', 'ready-for-agent', 'ready-for-agent|afk-claimed', null],
    ['done', 'ready-for-agent|afk-claimed', 'ready-for-agent|afk-delivered', '提交：abc123'],
    ['failed', 'ready-for-agent|afk-claimed', 'ready-for-agent|afk-failed', 'afk failed：测试没过'],
    ['unpushed', 'ready-for-agent|afk-claimed', 'ready-for-agent|afk-claimed', '本地提交（未推送）：abc123']
  ];
  for (const [action, from, to, comment] of cases) {
    await withMark(from, async (mark, f) => {
      const { out } = mark({ action, sha: 'abc123', comment: '测试没过' });
      assert.equal(out.status, 'ok', `${action}：${out.say}`);
      assert.deepEqual(Object.keys(out.data).sort(), ['did', 'id', 'ref']);
      assert.equal(out.data.id, SID);
      assert.equal(out.data.ref, `story ${SID}`);
      const st = readTapdState(f);
      assert.equal(st.stories[0].label, to, action);
      assert.equal(st.stories[0].status, 'doing', `${action} 不改状态`);
      assert.equal(st.stories[0].owner, 'alice', `${action} 不改处理人`);
      const updates = st.calls.filter((c) => c[0] === 'story' && c[1] === 'update');
      assert.ok(updates.every((c) => c[3].startsWith('label=') && !c[3].includes(',')), action);
      assert.equal(st.comments.length, comment ? 1 : 0, action);
      if (comment) {
        assert.equal(st.comments[0].description, comment);
        assert.equal(st.comments[0].author, 'bot-npc');
      }
    });
  }
});

test('ticket_mark：回读不一致判失败；缺评论人时标签未被改动；干跑不改 TAPD', async () => {
  await withMark('ready-for-agent', (mark) => {
    const { out } = mark({ action: 'claimed' });
    assert.equal(out.status, 'failed');
    assert.match(out.say, /回读不一致/);
  }, { ignoreUpdate: true });

  await withMark('ready-for-agent|afk-claimed', (mark, f) => {
    const { out } = mark({ action: 'done', sha: 'abc' }, { TAPD_NPC_ROLE: '' });
    assert.equal(out.status, 'failed');
    assert.match(out.say, /缺评论人/);
    const st = readTapdState(f);
    assert.equal(st.stories[0].label, 'ready-for-agent|afk-claimed');
    assert.equal(st.calls.length, 0, '动标签之前就报错');
  });

  const old = Array.from({ length: 35 }, (_, i) => ({
    id: String(i + 1), entry_type: 'stories', entry_id: SID, description: `旧评论 ${i}`, author: 'alice', created: `2025-01-01 00:00:${String(i).padStart(2, '0')}`
  }));
  await withMark('ready-for-agent|afk-claimed', (mark, f) => {
    const { out } = mark({ action: 'done', sha: 'abc' });
    assert.equal(out.status, 'ok', `评论超过一页也能回读到新评论：${out.say}`);
    assert.equal(readTapdState(f).comments.length, 36);
  }, { comments: old });

  await withMark('ready-for-agent|afk-claimed', (mark, f) => {
    const { out } = mark({ action: 'done', sha: 'abc', dryRun: true });
    assert.equal(out.status, 'ok');
    assert.match(out.say, /干跑/);
    assert.ok(out.data.did.some((d) => d.includes('label=ready-for-agent|afk-delivered')));
    const st = readTapdState(f);
    assert.equal(st.stories[0].label, 'ready-for-agent|afk-claimed');
    assert.equal(st.comments.length, 0);
  });
});

test('ticket_mark：回帖稿传图替换引用、保留 alt；不支持的格式降级占位；多行无字面量 \\n；回读走 OpenAPI', async () => {
  const dir = path.join(TMP, 'reply');
  mkdirSync(path.join(dir, 'images'), { recursive: true });
  writeFileSync(path.join(dir, 'images', 'a.png'), PNG);
  writeFileSync(path.join(dir, 'images', 'b.webp'), JPG);
  const reply = path.join(dir, 'reply-1.md');
  writeFileSync(reply, '## 为什么失败\n\n- 第一行\n- 第二行\n\n![红色 截图](images/a.png)\n\n![](images/b.webp)\n');

  await withMark('ready-for-agent|afk-claimed', (mark, f) => {
    const { out, stderr } = mark({ action: 'failed', comment: '做不成', commentFile: reply });
    assert.equal(out.status, 'ok', out.say);
    assert.match(out.say, /未上传/);
    assert.match(stderr, /b\.webp/);
    const st = readTapdState(f);
    assert.equal(st.uploads.length, 1);
    assert.equal(path.resolve(st.uploads[0].file), path.join(dir, 'images', 'a.png'));
    const c = st.comments[0].description;
    assert.ok(c.startsWith('afk failed：做不成\n\n## 为什么失败\n\n- 第一行\n- 第二行'), c);
    assert.ok(!c.includes('\\n'));
    assert.match(c, /!\[红色 截图\]\(\/tfl\/pictures\/1\.png\)/);
    assert.match(c, /（图片未上传：`images\/b\.webp`）/);
    assert.equal(st.stories[0].label, 'ready-for-agent|afk-failed');
    assert.ok(!st.calls.some((x) => x[0] === 'comment' && x[1] === 'list'), '回读不用 tapd-cli comment list');
    assert.ok(openApiLog(f).some((l) => l.url.startsWith('/comments')));
  });

  await withMark('ready-for-agent|afk-claimed', (mark) => {
    const { out } = mark({ action: 'failed', comment: '做不成', commentFile: reply });
    assert.equal(out.status, 'failed');
    assert.match(out.say, /字面量/);
  }, { escapeNewlines: true });

  await withMark('ready-for-agent|afk-claimed', (mark, f) => {
    const { out } = mark({ action: 'failed', comment: '只有一句', commentFile: path.join(dir, 'none.md') });
    assert.equal(out.status, 'ok');
    assert.equal(readTapdState(f).comments[0].description, 'afk failed：只有一句');
  });
});
