// dev（GitHub 工单源）的端到端测试：开发 → 提交 → 关单的正常路径。脚手架在 tests/support/github-template.mjs。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, plan, seen, issue, issueState, labelsOf, comments, cli, git, gitOut } from './support/github-template.mjs';

const SHARED_PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', '_shared', 'prompts');

test('共用提示词 dev / review / fix 存在、不含 GitHub 专属字样；都叫 Agent 别提交、回帖稿必写', () => {
  for (const f of ['dev.md', 'review.md', 'fix.md']) {
    const text = readFileSync(path.join(SHARED_PROMPTS, f), 'utf8');
    assert.doesNotMatch(text, /GitHub|\bgh\b|#N|#\d|Closes|issue/i, f);
    assert.match(text, /不要 git commit，也不要 git push/, f);
    assert.match(text, /回帖稿（必写/, f);
    assert.doesNotMatch(text, /别建它/, f);
  }
  for (const f of ['dev.md', 'review.md']) {
    assert.match(readFileSync(path.join(SHARED_PROMPTS, f), 'utf8'), /\{\{commitData\}\}/, f);
  }
  for (const f of ['dev.md', 'review.md', 'fix.md']) {
    assert.match(readFileSync(path.join(SHARED_PROMPTS, f), 'utf8'), /\{\{local\}\}/, f);
  }
});

test('项目补充要求 prompts/local/<dev|review|fix>.md：各接到对应 Agent 的提示词，没有的不留占位', () => {
  const s = setup({
    issues: [issue(3, { title: '加个文件', labels: ['ready-for-agent'] })],
    verify: ['node', '-e', "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"],
    push: true
  });
  mkdirSync(path.join(s.home, 'prompts', 'local'), { recursive: true });
  writeFileSync(path.join(s.home, 'prompts', 'local', 'dev.md'), '开发要按策划 / 玩家 / 开发三个角度写 {{cwd}}\n');
  writeFileSync(path.join(s.home, 'prompts', 'local', 'review.md'), '审查要核对开发写的角度\n');
  git(['add', '-A'], s.root);
  git(['commit', '-qm', 'local prompts'], s.root);
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '没问题' },
    { choice: 'fixed', reason: '补上了', file: { name: 'ok.txt', content: '1' } }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  const [dev, review, fix] = seen(s).map((x) => x.goal);
  assert.ok(dev.includes('项目补充要求（与上面冲突时以这里为准）：\n开发要按策划 / 玩家 / 开发三个角度写 {{cwd}}'), dev);
  assert.doesNotMatch(dev, /审查要核对/);
  assert.ok(review.includes('审查要核对开发写的角度') && !review.includes('三个角度写'), review);
  assert.doesNotMatch(fix, /项目补充要求|\{\{local\}\}/);
  assert.ok(dev.indexOf('项目补充要求') < dev.indexOf('最后只回一段 JSON'), '补充要求在回话格式之前');
});

test('GitHub 下提示词只要 summary（不分类型）；提交信息 = #N + Agent 给的一句话，审查给的覆盖开发的', () => {
  const s = setup({
    issues: [issue(7, { title: '加个文件', labels: ['ready-for-agent'] })],
    verify: ['node', '-e', "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"],
    push: true
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'note.txt', content: 'hi' }, data: { summary: '加说明文件' } },
    { choice: 'clean', reason: '没问题', data: { summary: '加说明文件和校验标记' } },
    { choice: 'fixed', reason: '补上了', file: { name: 'ok.txt', content: '1' } }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  const [dev, review, fix] = seen(s).map((x) => x.goal);
  assert.ok(dev.includes('`{"summary": "…"}`'), dev);
  assert.doesNotMatch(dev, /"type"/);
  assert.ok(review.includes('`{"summary": "…"}`'), review);
  assert.doesNotMatch(fix, /\{\{/);
  assert.equal(gitOut(['log', '-1', '--pretty=%s'], s.root), '#7 加说明文件和校验标记');
  assert.equal(gitOut(['log', '-1', '--pretty=%b'], s.root), 'Closes #7');
  assert.match(comments(issueState(s, 7)), /`node -e .*` 通过（验证不过后修了 1 轮）/);
});

test('Agent 的提示词与 inputs 里没有工单正文，只有快照路径；快照在本次运行的日志目录下', () => {
  const s = setup({ issues: [issue(5, { title: '看快照', body: '独一无二的正文XYZ', labels: ['ready-for-agent'] })], push: true });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '没问题' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  const calls = seen(s);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.doesNotMatch(c.goal, /独一无二的正文XYZ/);
    assert.equal(c.issue, undefined);
    assert.match(c.ticket, /[\\/]logs[\\/][^\\/]+[\\/]tickets[\\/]5[\\/]ticket\.md$/);
    assert.ok(c.goal.includes(c.ticket), '提示词里给的是快照路径');
    assert.match(readFileSync(c.ticket, 'utf8'), /独一无二的正文XYZ/);
  }
});

test('成功：认领 → 开发 → 审查 → 提交 → 关单（且推送）', () => {
  const s = setup({ issues: [issue(1, { title: '加个文件', labels: ['ready-for-agent'] })], push: true });
  plan(s, [
    { choice: 'done', reason: '写好 note.txt 了', file: { name: 'note.txt', content: 'hi' } },
    { choice: 'clean', reason: '看着没问题' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 1).state, 'CLOSED');
  assert.deepEqual(labelsOf(s, 1), ['afk-delivered'], '贴 afk-delivered，ready 与 afk-claimed 都要摘掉');
  assert.match(comments(issueState(s, 1)), /提交：/);
  assert.ok(existsSync(path.join(s.root, 'note.txt')));
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 加个文件/);
  assert.equal(gitOut(['status', '--porcelain'], s.root), '', '提交后工作区应干净');
  // 远端也拿到了这个提交
  assert.match(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), /^#1 加个文件/);
});

test('验证配了且能过 → 正常提交关单', () => {
  const s = setup({
    issues: [issue(2, { labels: ['ready-for-agent'] })],
    verify: ['node', '-e', 'process.exit(0)'],
    push: true
  });
  plan(s, [
    { choice: 'done', reason: '做了', file: { name: 'ok.txt', content: '1' } },
    { choice: 'clean', reason: '没问题' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 2).state, 'CLOSED');
});

test('Agent 自己先提交了 → 不判失败，压成工作流的一笔，照常推送关单', () => {
  const s = setup({ issues: [issue(1, { title: '加个文件', labels: ['ready-for-agent'] })], push: true });
  plan(s, [
    {
      choice: 'done',
      reason: '写好并提交了',
      file: { name: 'note.txt', content: 'hi' },
      commit: 'wip'
    },
    { choice: 'clean', reason: '看着没问题' }
  ]);

  const r = cli(s, ['dev']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(issueState(s, 1).state, 'CLOSED');
  assert.ok(!/commit_failed/.test(comments(issueState(s, 1))), '不该有 commit_failed 评论');
  assert.equal(gitOut(['rev-list', '--count', 'HEAD'], s.root), '2', 'Agent 那笔被压进工作流的一笔，不多出提交');
  assert.match(gitOut(['log', '-1', '--pretty=%s'], s.root), /^#1 加个文件/);
  assert.match(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), /^#1 加个文件/, '照样要推送');
});

test('dev：--dir 的目录名是实例名（锁落 dev@<工位>），不带 --dir 还是 dev 一把锁', () => {
  const s = setup({});
  mkdirSync(path.join(s.home, 'logs'), { recursive: true });
  const held = (name) => writeFileSync(path.join(s.home, 'logs', name), JSON.stringify({ pid: process.pid, runId: 'holder', at: new Date().toISOString() }));

  held('dev@wt1.lock');
  const skip = cli(s, ['dev', '--dir', 'wt1']);
  assert.equal(skip.code, 0, skip.stderr);
  assert.match(skip.stdout, /dev@wt1 已在跑/);
  assert.equal(seen(s).length, 0, '跳过的实例不该叫 Agent');

  // 别的实例不受这把锁影响（队列空，跑一轮就完）
  const other = cli(s, ['dev', '--dir', 'wt2']);
  assert.equal(other.code, 0, other.stderr);
  assert.doesNotMatch(other.stdout, /已在跑/);

  // 不带 --dir = 没实例，落回 dev.lock：已有一把活锁就照旧跳过
  held('dev.lock');
  const plain = cli(s, ['dev']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.stdout, /dev 已在跑/);
});
