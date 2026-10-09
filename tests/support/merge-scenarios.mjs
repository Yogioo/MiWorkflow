// 合并流程端到端场景：同一套场景对每家假工单源各跑一遍（tests/merge-<工单源>.test.mjs 各注册一次）。
// 工人在工位里做完的单子分支（`afk/<工单号>`）由本文件手工造出来（真跑 dev --dir 的路径由 dev 场景覆盖）。
// 假远端：setup({ push: true }) 建的本地裸仓库当 origin。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { plan, seen, cli, git, gitOut, runScript } from './github-template.mjs';

const READY = ['ready-for-agent'];
const MERGING = ['afk-merging'];

export function defineMergeScenarios(src) {
  const scenario = (name, opts, fn) => test(`[${src.name}] ${name}`, async () => {
    const s = await src.open(opts);
    try {
      await fn(s, (key) => src.view(s, key));
    } finally {
      await s.close();
    }
  });

  const branchOf = (key) => `afk/${src.id(key)}`;
  const assertDelivered = (t) => {
    assert.equal(t.closed, src.closes, 'GitHub / beads 关单，TAPD 不关单');
    assert.deepEqual(t.labels, src.deliveredLabels, t.labels.join(','));
  };
  const branches = (s) => gitOut(['for-each-ref', '--format=%(refname:short)', 'refs/heads/afk/'], s.root).split('\n').filter(Boolean);
  const backups = (s) => gitOut(['for-each-ref', '--format=%(refname)', 'refs/afk-merge-backup'], s.root).split('\n').filter(Boolean);

  // 带提交时间跑一条 git：先交先合按提交时间排序，用例得能把先后定死
  const gitAt = (argv, cwd, at) => spawnSync('git', argv, {
    cwd, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }
  });

  // 模拟工人在工位里做完一张单：单子分支上放一笔提交 + 工单标「等合并」
  function deliver(s, key, files, { at = '', message = '改一下' } = {}) {
    const branch = branchOf(key);
    git(['checkout', '-q', '-b', branch, 'main'], s.root);
    write(s, files);
    git(['add', '-A'], s.root);
    const run = at ? gitAt : git;
    run(['commit', '-qm', `${src.commitPrefix(key)}${message}`], s.root, at);
    const sha = gitOut(['rev-parse', 'HEAD'], s.root);
    runScript(s, 'ticket_mark', { id: src.id(key), action: 'merging', sha, branch });
    git(['checkout', '-q', 'main'], s.root);
    return { branch, sha };
  }

  // 别人的一笔直接落在主分支上（工人开工之后主分支动了）
  function othersMerge(s, files, message = '别人的一笔') {
    write(s, files);
    git(['add', '-A'], s.root);
    git(['commit', '-qm', message], s.root);
    git(['push', '-q', 'origin', 'main'], s.root);
    return gitOut(['rev-parse', 'HEAD'], s.root);
  }

  function write(s, files) {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(s.root, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }

  const conflict = (s, key, mine, theirs) => {
    deliver(s, key, { 'a.txt': mine });
    othersMerge(s, { 'a.txt': theirs });
  };

  scenario('正常合入：rebase → 快进主分支 → 推送 → 关单 → 删单子分支', {
    tickets: [{ key: 1, title: '加个文件', labels: READY }], push: true
  }, (s, view) => {
    deliver(s, 1, { 'note.txt': 'hi\n' });
    const r = cli(s, ['merge']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), `${src.commitPrefix(1)}改一下`, '远端拿到这一笔');
    assert.equal(gitOut(['status', '--porcelain'], s.root), '', '主目录干净');
    assert.deepEqual(branches(s), [], '单子分支删了');
    assert.equal(seen(s).length, 0, '没冲突、没验证，不叫 Agent');
    const t = view(1);
    assertDelivered(t);
    assert.ok(t.comments.at(-1).includes('已合并'), t.comments.at(-1));
    assert.ok(!t.labels.includes('afk-merging'), t.labels.join(','));
  });

  scenario('先交先合：按分支 tip 的提交时间，不看工单号', {
    tickets: [{ key: 1, labels: READY }, { key: 2, labels: READY }], push: true
  }, (s, view) => {
    deliver(s, 1, { 'one.txt': '1\n' }, { at: '2026-01-02T00:00:00' });
    deliver(s, 2, { 'two.txt': '2\n' }, { at: '2026-01-01T00:00:00' });
    const r = cli(s, ['merge']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const subjects = gitOut(['log', '--pretty=%s', '-2', 'origin/main'], s.root).split('\n');
    assert.ok(subjects[1].startsWith(src.commitPrefix(2)), `先交的 2 先合：${subjects.join(' / ')}`);
    assert.ok(subjects[0].startsWith(src.commitPrefix(1)), `后交的后合：${subjects.join(' / ')}`);
    assertDelivered(view(1));
    assertDelivered(view(2));
  });

  scenario('主分支没动过 → 跳过验证（配了会失败的验证命令也照样合入）', {
    tickets: [{ key: 1, labels: READY }], push: true, verify: ['node', '-e', 'process.exit(1)']
  }, (s, view) => {
    deliver(s, 1, { 'note.txt': 'hi\n' });
    const r = cli(s, ['merge']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(seen(s).length, 0, '跳过验证，不叫修正 Agent');
    const t = view(1);
    assertDelivered(t);
    assert.ok(t.comments.at(-1).includes('跳过'), t.comments.at(-1));
  });

  scenario('主分支动过 → 跑验证；不过就交给合并 Agent 修好再合', {
    tickets: [{ key: 1, labels: READY }], push: true,
    verify: ['node', '-e', "process.exit(require('fs').readFileSync('note.txt','utf8').includes('fixed') ? 0 : 1)"]
  }, (s, view) => {
    deliver(s, 1, { 'note.txt': 'hi\n' });
    othersMerge(s, { 'other.txt': 'x\n' });
    plan(s, [{ choice: 'fixed', reason: '补上 fixed', file: { name: 'note.txt', content: 'fixed\n' } }]);
    const r = cli(s, ['merge']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.equal(seen(s).length, 1, '验证不过叫了一次修正 Agent');
    assert.ok(seen(s)[0].goal.includes('验证命令'), '修正 Agent 拿到的是验证命令');
    assert.equal(gitOut(['show', 'origin/main:note.txt'], s.root), 'fixed', '修好的内容合进去了');
    assert.equal(gitOut(['show', 'origin/main:other.txt'], s.root), 'x', '别人的改动也在');
    assertDelivered(view(1));
  });

  scenario('冲突交给合并 Agent：解完继续 rebase，两边的改动都在主分支上', {
    tickets: [{ key: 1, labels: READY }], push: true
  }, (s, view) => {
    conflict(s, 1, 'worker\n', 'other\n');
    plan(s, [{ choice: 'resolved', reason: '两边都保留', file: { name: 'a.txt', content: 'other\nworker\n' }, reply: '冲突在 a.txt：两边都要。' }]);
    const r = cli(s, ['merge']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const goal = seen(s)[0].goal;
    assert.ok(goal.includes('a.txt'), '提示词里给了冲突文件');
    assert.ok(goal.includes('别人的一笔'), '提示词里给了主分支新进来的提交');    assert.equal(gitOut(['show', 'origin/main:a.txt'], s.root), 'other\nworker', 'commit 里是解完冲突的内容');
    assert.ok(view(1).comments.at(-1).includes('冲突在 a.txt'), view(1).comments.at(-1));
    assertDelivered(view(1));
  });

  scenario('合并失败（冲突解不了）→ 回到合并前 + 分支备份成 ref 后删掉 + 退回就绪队列', {
    tickets: [{ key: 1, labels: READY }], push: true
  }, (s, view) => {
    conflict(s, 1, 'worker\n', 'other\n');
    plan(s, [{ choice: 'give_up', reason: '两边意图矛盾', reply: '解不了：拿不准该保哪个。' }]);
    const r = cli(s, ['merge']);
    assert.equal(r.code, 1);
    const before = gitOut(['log', '-1', '--pretty=%s', 'main'], s.root);
    assert.equal(before, '别人的一笔', '主分支回到合并前');
    assert.equal(gitOut(['status', '--porcelain'], s.root), '');
    assert.deepEqual(branches(s), [], '单子分支删掉（工人会在最新主分支上重做）');
    const refs = backups(s);
    assert.equal(refs.length, 1, `分支备份成 ref：${refs.join(',')}`);
    assert.equal(gitOut(['log', '-1', '--pretty=%s', refs[0]], s.root), `${src.commitPrefix(1)}改一下`);
    const t = view(1);
    assert.equal(t.closed, false, '没关单');
    assert.deepEqual(t.labels, READY, '摘 afk-merging、退回 ready');
    const c = t.comments.at(-1);
    assert.ok(c.includes('afk merge 失败（第 1 次') && c.includes('解不了'), c);
    assert.ok(c.includes('拿不准该保哪个'), c);
  });

  scenario('同一张单满 MERGE_FAIL_LIMIT 次 → 标失败转人工，不再退回队列', {
    tickets: [{ key: 1, labels: READY }], push: true, config: { MERGE_FAIL_LIMIT: 2 }
  }, (s, view) => {
    conflict(s, 1, 'one\n', 'other\n');
    plan(s, [{ choice: 'give_up', reason: '解不了' }]);
    assert.equal(cli(s, ['merge']).code, 1);
    assert.deepEqual(view(1).labels, READY, '第 1 次退回队列');

    conflict(s, 1, 'two\n', 'third\n');
    plan(s, [{ choice: 'give_up', reason: '还是解不了' }]);
    const r = cli(s, ['merge']);
    assert.equal(r.code, 1);
    const t = view(1);
    assert.equal(t.closed, false);
    assert.ok(t.labels.includes('afk-failed') && !t.labels.includes('afk-merging'), t.labels.join(','));
    assert.ok(t.comments.at(-1).includes('已满 2 次'), t.comments.at(-1));
  });

  scenario('推送失败 → 本地主分支保留、不关单、不删分支，整轮停下', {
    tickets: [{ key: 1, labels: READY }], push: true
  }, (s, view) => {
    deliver(s, 1, { 'note.txt': 'hi\n' });
    const hook = path.join(s.base, 'origin.git', 'hooks', 'pre-receive');
    mkdirSync(path.dirname(hook), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    const r = cli(s, ['merge']);
    assert.equal(r.code, 1);
    assert.equal(gitOut(['log', '-1', '--pretty=%s', 'main'], s.root), `${src.commitPrefix(1)}改一下`, '本地保留');
    assert.equal(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), 'init', '远端没拿到');
    const t = view(1);
    assert.equal(t.closed, false);
    assert.deepEqual(t.labels, [...READY, ...MERGING], '没关单、没退回队列');
    assert.ok(t.comments.at(-1).includes('推送失败'), t.comments.at(-1));
    assert.deepEqual(branches(s), [branchOf(1)], '分支留着，人处理完再合');
  });

  // 别人从另一份克隆推到 origin，本地主分支没跟上（只落后、不分叉）
  function othersPush(s, files, message = '远端的一笔') {
    const other = path.join(s.base, 'other');
    git(['clone', '-q', '-b', 'main', path.join(s.base, 'origin.git'), other], s.base);
    git(['config', 'user.email', 't@t'], other);
    git(['config', 'user.name', 't'], other);
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(other, name), content);
    git(['add', '-A'], other);
    git(['commit', '-qm', message], other);
    git(['push', '-q', 'origin', 'main'], other);
  }

  scenario('本地主分支落后 origin（别人推了新提交）→ 快进后照常合入', {
    tickets: [{ key: 1, labels: READY }], push: true
  }, (s, view) => {
    deliver(s, 1, { 'note.txt': 'hi\n' });
    othersPush(s, { 'remote.txt': 'y\n' });
    const r = cli(s, ['merge']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const subjects = gitOut(['log', '--pretty=%s', '-2', 'origin/main'], s.root).split('\n');
    assert.deepEqual(subjects, [`${src.commitPrefix(1)}改一下`, '远端的一笔'], subjects.join(' / '));
    assertDelivered(view(1));
  });

  scenario('本地主分支与 origin 分叉 → 停下交给人，不动分支、不改工单', {
    tickets: [{ key: 1, labels: READY }], push: true
  }, (s, view) => {
    deliver(s, 1, { 'note.txt': 'hi\n' });
    write(s, { 'local.txt': 'x\n' });
    git(['add', '-A'], s.root);
    git(['commit', '-qm', '本地的一笔'], s.root);
    othersPush(s, { 'remote.txt': 'y\n' });

    const r = cli(s, ['merge']);
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /分叉/, r.stderr + r.stdout);
    assert.deepEqual(branches(s), [branchOf(1)], '分支不动');
    assert.deepEqual(view(1).labels, [...READY, ...MERGING], '工单不动');
  });

  scenario('主目录不干净 → 停下并说清原因，不 fetch、不动分支、不改工单', {
    tickets: [{ key: 1, labels: READY }], push: true
  }, (s, view) => {
    deliver(s, 1, { 'note.txt': 'hi\n' });
    writeFileSync(path.join(s.root, 'dirty.txt'), 'x\n');
    const r = cli(s, ['merge']);
    assert.equal(r.code, 1);
    assert.match(r.stderr + r.stdout, /不干净/, r.stderr + r.stdout);
    assert.match(r.stderr + r.stdout, /dirty\.txt/, '说清哪里脏');
    assert.deepEqual(branches(s), [branchOf(1)], '分支不动');
    assert.deepEqual(view(1).labels, [...READY, ...MERGING], '工单不动');
  });

  scenario('--dry-run：只报队列，不动 git、不改工单', {
    tickets: [{ key: 1, labels: READY }], push: true
  }, (s, view) => {
    deliver(s, 1, { 'note.txt': 'hi\n' });
    const r = cli(s, ['merge', '--dry-run']);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(r.stdout.includes(src.id(1)), r.stdout);
    assert.deepEqual(view(1).labels, [...READY, ...MERGING]);
    assert.equal(gitOut(['log', '-1', '--pretty=%s', 'origin/main'], s.root), 'init');
  });
}
