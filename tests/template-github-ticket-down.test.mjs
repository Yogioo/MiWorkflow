// 工单系统故障（GitHub 5xx）：runGh 退避重试 + dev 熔断停下，不算工单失败、不回滚已推送代码（#28）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setup, issue, plan, seen, cli, gitOut, readState, labelsOf } from './support/github-template.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runGh } = await import(pathToFileURL(path.join(ROOT, 'templates', 'github', 'scripts', '_gh.mjs')).href);

const TMP = mkdtempSync(path.join(os.tmpdir(), 'miworkflow-ghdown-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

// 假 gh：先按 FAKE_GH_FAIL 报错 times 次，之后回 ok；每次调用计数
const FAKE = path.join(TMP, 'fake-gh-fail.mjs');
writeFileSync(FAKE, [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const f = process.env.FAKE_GH_FAIL;',
  'const s = JSON.parse(readFileSync(f, "utf8"));',
  's.calls = (s.calls ?? 0) + 1;',
  'writeFileSync(f, JSON.stringify(s));',
  'if (s.calls <= s.times) { process.stderr.write(s.message + "\\n"); process.exit(1); }',
  'process.stdout.write("ok");',
  ''
].join('\n'));

let n = 0;
function fakeGh(times, message) {
  const f = path.join(TMP, `fail${++n}.json`);
  writeFileSync(f, JSON.stringify({ times, message }));
  process.env.MIWORKFLOW_GH = FAKE;
  process.env.FAKE_GH_FAIL = f;
  return () => JSON.parse(readFileSync(f, 'utf8')).calls;
}

test('runGh：HTTP 500、GraphQL 通用服务端报错会重试；404 / 权限错误不重试；间隔可配成 0', () => {
  const delays = [0, 0, 0];
  for (const message of [
    'HTTP 500: Internal Server Error',
    'GraphQL: Something went wrong while executing your query. (addLabelsToLabelable)',
    'GraphQL: Could not close the issue. (closeIssue)',
    'API rate limit exceeded'
  ]) {
    const calls = fakeGh(1, message);
    assert.equal(runGh(['issue', 'view', '1'], { retryDelays: delays }), 'ok', message);
    assert.equal(calls(), 2, message);
  }

  const calls = fakeGh(99, 'HTTP 502: Bad Gateway');
  assert.throws(() => runGh(['issue', 'close', '1'], { retryDelays: delays }), (err) => err.transient === true);
  assert.equal(calls(), 4, '1 次 + 重试 3 次');

  for (const message of [
    'HTTP 404: Not Found',
    'GraphQL: Could not resolve to an Issue with the number of 500. (repository.issue)',
    'HTTP 403: Resource not accessible by integration',
    'GraphQL: Could not add label: permission denied'
  ]) {
    const c = fakeGh(99, message);
    assert.throws(() => runGh(['issue', 'edit', '500'], { retryDelays: delays }), (err) => !err.transient, message);
    assert.equal(c(), 1, `${message} 不重试`);
  }

  const v = fakeGh(99, 'HTTP 500');
  assert.throws(() => runGh(['--version'], { retries: 0, retryDelays: delays }));
  assert.equal(v(), 1, 'retries: 0 保持不重试');
  delete process.env.MIWORKFLOW_GH;
  delete process.env.FAKE_GH_FAIL;
});

const READY = ['ready-for-agent'];
const DONE_STEPS = [
  { choice: 'done', reason: '做完', file: { name: 'note.txt', content: 'hi' } },
  { choice: 'clean', reason: '没问题' }
];
const ghFail = (s, fails) => {
  const st = readState(s);
  st.ghFail = fails;
  writeFileSync(s.stateFile, JSON.stringify(st));
};

test('认领、关单各先 500 一次再成功：工单正常完成，不贴 afk-failed', () => {
  const s = setup({ issues: [issue(1, { labels: READY })], push: true });
  ghFail(s, { edit: { times: 1, message: 'HTTP 500' }, close: { times: 1, message: 'GraphQL: Could not close the issue. (closeIssue)' } });
  plan(s, DONE_STEPS);
  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /第 1 次重试/);
  assert.equal(readState(s).issues[0].state, 'CLOSED');
  assert.deepEqual(labelsOf(s, 1), ['afk-delivered']);
});

test('关单一直 500：不回滚、不贴 afk-failed、不挑下一张、退出码非 0、停止原因含 sha 与工单号、不计入失败', () => {
  const s = setup({ issues: [issue(1, { labels: READY }), issue(2, { labels: READY })], push: true });
  ghFail(s, { close: { times: 999, message: 'HTTP 500: Something went wrong while executing your query' } });
  plan(s, [...DONE_STEPS, ...DONE_STEPS]);
  const r = cli(s, ['dev', '--max-failures', '5']);
  assert.notEqual(r.code, 0);
  const sha = gitOut(['rev-parse', 'HEAD'], s.root);
  assert.equal(gitOut(['rev-parse', 'origin/main'], s.root), sha, '已推送，不回滚');
  assert.ok(gitOut(['log', '-1', '--pretty=%s'], s.root).startsWith('#1 '));
  const out = r.stdout + r.stderr;
  assert.ok(out.includes(`已推送 ${sha.slice(0, 7)}`) && out.includes('#1') && out.includes('需人补标记'), out);
  assert.match(r.stdout, /失败 0 个/);
  assert.ok(!labelsOf(s, 1).includes('afk-failed'));
  assert.equal(seen(s).length, 2, '没挑 #2');
  assert.deepEqual(labelsOf(s, 2), READY);
});

test('认领一直 500：不叫 Agent、不改 git、主循环停下、退出码非 0', () => {
  const s = setup({ issues: [issue(1, { labels: READY }), issue(2, { labels: READY })] });
  ghFail(s, { edit: { times: 999, message: 'GraphQL: Something went wrong while executing your query' }, create: { times: 999, message: 'HTTP 500' } });
  const head = gitOut(['rev-parse', 'HEAD'], s.root);
  plan(s, DONE_STEPS);
  const r = cli(s, ['dev']);
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /工单系统暂时不可用（接单 #1）：下轮重做/);
  assert.match(r.stdout, /失败 0 个/);
  assert.equal(seen(s).length, 0, '没叫 Agent');
  assert.equal(gitOut(['rev-parse', 'HEAD'], s.root), head);
  assert.equal(gitOut(['status', '--porcelain'], s.root), '');
  assert.equal(readState(s).ghFail.edit.times, 999 - 4, '只认领 #1 一次（1 次 + 重试 3 次），没去认领 #2');
  assert.equal(readState(s).ghFail.create.times, 999, '故障时不去建标签');
});
