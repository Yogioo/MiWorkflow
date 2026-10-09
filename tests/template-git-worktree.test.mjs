// templates/_shared/scripts/git_worktree.mjs：工位的建（ensure）与对齐（align）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, runScript, git, gitOut } from './support/github-template.mjs';

test('git_worktree ensure：已存在的工位脏了也照样复用（干净留给 dev 清理完自己的单再查），不碰里面的改动', () => {
  const s = setup();
  const station = path.join(s.base, 'wt1');
  git(['worktree', 'add', '--detach', station, 'main'], s.root);
  writeFileSync(path.join(station, 'half.txt'), 'x\n');
  writeFileSync(path.join(station, 'app.txt'), '改了一半\n');

  const r = runScript(s, 'git_worktree', { action: 'ensure', cwd: s.root, dir: station });
  assert.equal(r.status, 'ok', r.error);
  assert.equal(r.data.created, false);
  assert.equal(r.data.dir, station);
  assert.ok(existsSync(path.join(station, 'half.txt')), '改动原样留着');
  assert.notEqual(gitOut(['status', '--porcelain'], station), '');
});

test('git_worktree align：工位脏了照旧拒绝，不切换', () => {
  const s = setup();
  const station = path.join(s.base, 'wt1');
  git(['worktree', 'add', '--detach', station, 'main'], s.root);
  const head = gitOut(['rev-parse', 'HEAD'], station);
  writeFileSync(path.join(station, 'half.txt'), 'x\n');

  const r = runScript(s, 'git_worktree', { action: 'align', cwd: s.root, dir: station });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /不干净/);
  assert.match(r.error, /half\.txt/);
  assert.equal(gitOut(['rev-parse', 'HEAD'], station), head);
});

test('git_worktree ensure：已存在的目录不是本仓库的工作副本 → 照旧报错（别的仓库、普通目录都算）', () => {
  const s = setup();
  const other = path.join(s.base, 'other');
  mkdirSync(other);
  git(['init', '-q', '--initial-branch=main', other]);
  const plain = path.join(s.base, 'plain');
  mkdirSync(plain);

  for (const dir of [other, plain]) {
    const r = runScript(s, 'git_worktree', { action: 'ensure', cwd: s.root, dir });
    assert.equal(r.status, 'failed', dir);
    assert.match(r.error, /不是本仓库的工作副本/);
  }
});
