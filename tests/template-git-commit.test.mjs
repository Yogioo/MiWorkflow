// templates/_shared/scripts/git_commit.mjs：工作流统一提交（压成一笔、回读校验标题与 AI 署名）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, runScript, git, gitOut } from './support/github-template.mjs';

const commitAs = (s, file, msg) => {
  writeFileSync(path.join(s.root, file), file);
  git(['add', '-A'], s.root);
  git(['commit', '-qm', msg], s.root);
};

test('git_commit baseSha：base 之后的提交与工作区改动压成一笔，标题按 message', () => {
  const s = setup();
  const base = gitOut(['rev-parse', 'HEAD'], s.root);
  commitAs(s, 'a.txt', 'wip 1');
  commitAs(s, 'b.txt', 'wip 2\n\nCo-authored-by: Cursor <cursoragent@cursor.com>');
  writeFileSync(path.join(s.root, 'c.txt'), 'c');

  const r = runScript(s, 'git_commit', { message: 'feat:1004854 三个文件', baseSha: base, cwd: s.root });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.data.squashed, 2);
  assert.equal(gitOut(['rev-list', '--count', `${base}..HEAD`], s.root), '1');
  assert.equal(gitOut(['log', '-1', '--pretty=%B'], s.root), 'feat:1004854 三个文件');
  assert.deepEqual(gitOut(['show', '--name-only', '--pretty=', 'HEAD'], s.root).split('\n').sort(), ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(gitOut(['status', '--porcelain'], s.root), '');
});

test('git_commit baseSha：相对起点什么都没改 → 失败（nothing_to_commit），不造空提交', () => {
  const s = setup();
  const base = gitOut(['rev-parse', 'HEAD'], s.root);
  const r = runScript(s, 'git_commit', { message: 'x', baseSha: base, cwd: s.root });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /nothing_to_commit/);
  assert.equal(r.data.committed, false);
  assert.equal(gitOut(['rev-parse', 'HEAD'], s.root), base);
});

test('git_commit：钩子加了 AI 署名 / 改了标题 → 判失败（committed=false，交给调用方回滚）', () => {
  for (const [hook, want] of [
    ['echo "" >> "$1"; echo "Co-authored-by: Cursor <cursoragent@cursor.com>" >> "$1"', /AI 署名「Co-authored-by: Cursor/],
    ['echo "被改了" > "$1"', /标题被改成了「被改了」/]
  ]) {
    const s = setup();
    const base = gitOut(['rev-parse', 'HEAD'], s.root);
    writeFileSync(path.join(s.root, '.git', 'hooks', 'commit-msg'), `#!/bin/sh\n${hook}\n`, { mode: 0o755 });
    writeFileSync(path.join(s.root, 'a.txt'), 'a');
    const r = runScript(s, 'git_commit', { message: 'feat:1004854 加文件', baseSha: base, cwd: s.root });
    assert.equal(r.status, 'failed', hook);
    assert.match(r.error, /^commit_rejected: /);
    assert.match(r.error, want);
    assert.equal(r.data.committed, false, '不合规不算提交成功，免得被当成「推送失败、保留本地提交」');
  }
});

test('git_commit：message 只能一行', () => {
  const s = setup();
  const r = runScript(s, 'git_commit', { message: 'a\nb', cwd: s.root });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /只能是一行/);
});
