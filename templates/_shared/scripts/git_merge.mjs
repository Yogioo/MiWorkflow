// 合并的 git 步骤：`merge` 任务只把「在哪一步、结果是什么」交给 Agent，确定的动作都在这儿。
// 主目录（`.workflow/` 的上一级）是唯一的合入口：本地主分支跟 origin 对齐 → 单子分支 rebase 上去 →
// 快进主分支 → 推 origin；单子分支由工人（`dev --dir`）交上来，名叫 `afk/<工单号>`（见 _lib.mjs 的 branchOf）。
//
// 动作（都作用在主目录里）：
//   queue   列 `afk/*` 分支，按 tip 的提交时间升序（先交先合）——工单号就是分支名去掉 afk/ 前缀
//   status  主分支名、当前分支、本地/远端主分支 sha、工作区是否干净、有没有分叉、有没有 rebase 没结束
//   fetch   git fetch origin
//   sync    切到本地主分支并快进到 origin 上那份（分叉就 failed，交给人）
//   rebase  切到单子分支、rebase 到主分支；冲突不算错：ok + conflict:true + 冲突文件，交给合并 Agent；
//           rebased:false = 主分支是分支的祖先（rebase 是空操作，工人开工以来主分支没动过）
//   continue Agent 解完冲突后接着走 rebase（还有冲突就再交回 conflict:true）
//   amend   把 Agent 修验证时改的东西并进那一笔提交（一张单还是一笔）
//   ff      切到主分支、快进到单子分支
//   push    推 origin 上主分支；失败 = failed + data.pushed:false（本地保留，任务据此整轮停下）
//   abort   回到合并前：结束 rebase → 切回主分支 → reset --hard 到 sha → 分支备份成 ref → 删掉单子分支
//   drop    删掉单子分支
// 入：{ action, cwd?, branch?, main?, sha?, backup?, drop?, dryRun? }
// 出：{ status, say, data: {...} }
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { main, readStdin, emit, git, gitOrNull } from './_lib.mjs';

const out = (argv, cwd) => {
  const r = gitOrNull(argv, cwd);
  return r === null ? '' : r.trim();
};
const has = (ref, cwd) => gitOrNull(['rev-parse', '--verify', '--quiet', ref], cwd) !== null;
const isAncestor = (a, b, cwd) => Boolean(a && b) && gitOrNull(['merge-base', '--is-ancestor', a, b], cwd) !== null;
// 本地只落后（能快进）或只领先都不算分叉，两边各有对方没有的提交才算
const diverged = (local, remote, cwd) => Boolean(local && remote) && !isAncestor(local, remote, cwd) && !isAncestor(remote, local, cwd);
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

// 主分支名：origin/HEAD → 主目录当前分支（跟 git_worktree 同一套认法，不加配置项）
function mainBranchOf(repo) {
  const head = out(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repo);
  const name = head.replace(/^refs\/remotes\/origin\//, '');
  if (name) return name;
  const cur = out(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  return cur === 'HEAD' ? '' : cur;
}

const gitDir = (repo) => {
  const raw = out(['rev-parse', '--git-dir'], repo);
  return raw ? path.resolve(repo, raw) : '';
};
// rebase 没结束（冲突等在那里）：git 在 git-dir 下留的目录
const inRebase = (repo) => {
  const d = gitDir(repo);
  return Boolean(d) && (existsSync(path.join(d, 'rebase-merge')) || existsSync(path.join(d, 'rebase-apply')));
};
const unmerged = (repo) => out(['diff', '--name-only', '--diff-filter=U'], repo).split('\n').filter(Boolean);
const refSha = (ref, repo) => out(['rev-parse', '--verify', '--quiet', ref], repo);

// 解冲突时 git 要自己提交那一笔，提交信息的注释符默认是 `#`——而提交标题常常就是 `#12 …`（GitHub 的格式），
// 整行会被当注释剔掉，变成「empty commit message」合不下去。把注释符换成 `;` 就没事了（两条命令必须一致）。
const NO_COMMENT = ['-c', 'core.commentChar=;'];

// 跑一条可能要编辑器的 git（rebase --continue 会问提交信息）：GIT_EDITOR=true 用默认信息往下走
function gitEdit(argv, repo) {
  execFileSync('git', argv, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, GIT_EDITOR: 'true' }
  });
}

function toMain(repo, name) {
  if (!name) throw new Error('认不出主分支：主目录既没有 origin/HEAD 也不在分支上');
  if (has(`refs/heads/${name}`, repo)) git(['checkout', '-q', name], repo);
  else git(['checkout', '-q', '-B', name, `refs/remotes/origin/${name}`], repo);
}

function requireClean(repo) {
  const dirty = out(['status', '--porcelain'], repo).split('\n').filter(Boolean);
  if (dirty.length) {
    throw new Error(`主目录不干净（${dirty.length} 处改动，先处理干净再合）：${dirty.slice(0, 5).map((l) => l.trim()).join('、')}${dirty.length > 5 ? ' 等' : ''}`);
  }
}

await main(async () => {
  const args = await readStdin();
  const repo = out(['rev-parse', '--show-toplevel'], args.cwd ?? process.cwd());
  if (!repo) throw new Error(`${args.cwd ?? process.cwd()} 不是 git 仓库`);
  const action = args.action ?? 'status';
  const mainBranch = args.main || mainBranchOf(repo);
  const branch = args.branch ? String(args.branch) : '';

  if (action === 'queue') {
    // 先交先合：按 tip 的提交时间升序，同一秒按分支名兜底（别让顺序抖）
    const raw = out(['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)', 'refs/heads/afk/'], repo);
    const branches = raw.split('\n').filter(Boolean).map((l) => {
      const [name, sha, at] = l.split('\t');
      return { branch: name, id: name.slice('afk/'.length), sha, at: Number(at) || 0 };
    }).sort((a, b) => a.at - b.at || a.branch.localeCompare(b.branch));
    emit({ status: 'ok', say: branches.length ? `等合并 ${branches.length} 个：${branches.map((b) => b.id).join('、')}` : '没有等合并的单子分支', data: { branches } });
    return;
  }

  if (action === 'status') {
    const local = mainBranch ? refSha(`refs/heads/${mainBranch}`, repo) : '';
    const remote = mainBranch ? refSha(`refs/remotes/origin/${mainBranch}`, repo) : '';
    const dirty = out(['status', '--porcelain'], repo).split('\n').filter(Boolean);
    emit({
      status: 'ok',
      say: dirty.length ? `主目录不干净（${dirty.length} 处改动）` : `主目录干净（${out(['rev-parse', '--short=7', 'HEAD'], repo)}）`,
      data: {
        root: repo, main: mainBranch, current: out(['rev-parse', '--abbrev-ref', 'HEAD'], repo),
        sha: out(['rev-parse', 'HEAD'], repo), local, remote,
        clean: dirty.length === 0, dirty: dirty.map((l) => l.trim()),
        diverged: diverged(local, remote, repo),
        rebase: inRebase(repo)
      }
    });
    return;
  }

  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会在 ${repo} 上执行 ${action}`, data: { dryRun: true } });
    return;
  }

  if (action === 'fetch') {
    if (!out(['remote'], repo).split('\n').map((l) => l.trim()).includes('origin')) {
      throw new Error('没有 origin：merge 要把主分支对齐到远端，先给仓库配上 origin');
    }
    try {
      git(['fetch', 'origin'], repo);
    } catch (err) {
      const e = new Error(`fetch 失败：${firstLine(err.stderr || err.message)}`);
      e.transient = true;
      throw e;
    }
    emit({ status: 'ok', say: '已 fetch origin', data: { remote: refSha(`refs/remotes/origin/${mainBranch}`, repo) } });
    return;
  }

  if (action === 'sync') {
    requireClean(repo);
    toMain(repo, mainBranch);
    const remote = refSha(`refs/remotes/origin/${mainBranch}`, repo);
    if (!remote) throw new Error(`origin 上没有 ${mainBranch}（先 push 一次主分支）`);
    const local = refSha(`refs/heads/${mainBranch}`, repo);
    if (diverged(local, remote, repo)) {
      throw new Error(`本地 ${mainBranch} 和 origin/${mainBranch} 分叉了（本地 ${local.slice(0, 7)}、远端 ${remote.slice(0, 7)}），交给人处理`);
    }
    const before = local;
    git(['merge', '--ff-only', `refs/remotes/origin/${mainBranch}`], repo);
    const sha = out(['rev-parse', 'HEAD'], repo);
    emit({
      status: 'ok',
      say: before === sha ? `${mainBranch} 已经跟 origin 一致（${sha.slice(0, 7)}）` : `${mainBranch} 快进到 ${sha.slice(0, 7)}`,
      data: { main: mainBranch, sha, before, moved: before !== sha }
    });
    return;
  }

  if (action === 'log') {
    // 主分支上新进来的提交（解冲突的 Agent 要知道别人合进来了什么）：从分支与主分支的分叉点算起
    const to = String(args.to || mainBranch);
    const from = String(args.from || (branch ? out(['merge-base', branch, to], repo) : ''));
    const text = from ? out(['log', '--oneline', '--no-decorate', `${from}..${to}`], repo) : '';
    emit({ status: 'ok', say: text ? `新进来的提交：\n${text}` : '主分支上没有新提交', data: { commits: text, from, to } });
    return;
  }

  if (action === 'rebase') {
    if (!branch) throw new Error('缺 branch');
    requireClean(repo);
    if (!has(`refs/heads/${branch}`, repo)) throw new Error(`没有这个单子分支：${branch}`);
    const mainSha = refSha(`refs/heads/${mainBranch}`, repo);
    if (!mainSha) throw new Error(`没有本地主分支 ${mainBranch}`);
    // 主分支是分支的祖先 = 工人开工以来主分支没动过，rebase 是空操作（调用方据此跳过第二次验证）
    const rebased = !isAncestor(mainSha, branch, repo);
    git(['checkout', '-q', branch], repo);
    let conflict = false;
    if (rebased) {
      try {
        git([...NO_COMMENT, 'rebase', mainBranch], repo);
      } catch (err) {
        if (!inRebase(repo)) throw new Error(`rebase ${branch} 到 ${mainBranch} 失败：${firstLine(err.stderr || err.message)}`);
        conflict = true;
      }
    }
    emit({
      status: 'ok',
      say: conflict ? `${branch} 与 ${mainBranch} 冲突（${unmerged(repo).length} 个文件）` : `${branch} 已 rebase 到 ${mainBranch}${rebased ? '' : '（主分支没动过，无需 rebase）'}`,
      data: { branch, main: mainBranch, sha: out(['rev-parse', 'HEAD'], repo), rebased, conflict, files: conflict ? unmerged(repo) : [] }
    });
    return;
  }

  if (action === 'continue') {
    if (!inRebase(repo)) throw new Error('没有在进行的 rebase');
    git(['add', '-A'], repo);
    let conflict = false;
    try {
      gitEdit([...NO_COMMENT, 'rebase', '--continue'], repo);
    } catch (err) {
      if (!inRebase(repo)) throw new Error(`rebase --continue 失败：${firstLine(err.stderr || err.message)}`);
      conflict = true;
    }
    emit({
      status: 'ok',
      say: conflict ? `还有冲突（${unmerged(repo).length} 个文件）` : 'rebase 完成',
      data: { branch: out(['rev-parse', '--abbrev-ref', 'HEAD'], repo), sha: out(['rev-parse', 'HEAD'], repo), conflict, files: conflict ? unmerged(repo) : [] }
    });
    return;
  }

  if (action === 'amend') {
    git(['add', '-A'], repo);
    if (out(['diff', '--cached', '--name-only'], repo) === '') {
      emit({ status: 'ok', say: '没有新改动要并进去', data: { committed: false, sha: out(['rev-parse', 'HEAD'], repo) } });
      return;
    }
    gitEdit(['commit', '--amend', '--no-edit'], repo);
    emit({ status: 'ok', say: '改动已并进那一笔提交', data: { committed: true, sha: out(['rev-parse', 'HEAD'], repo) } });
    return;
  }

  if (action === 'ff') {
    if (!branch) throw new Error('缺 branch');
    requireClean(repo);
    toMain(repo, mainBranch);
    try {
      git(['merge', '--ff-only', branch], repo);
    } catch (err) {
      throw new Error(`主分支快进到 ${branch} 失败（不是快进）：${firstLine(err.stderr || err.message)}`);
    }
    const sha = out(['rev-parse', 'HEAD'], repo);
    emit({ status: 'ok', say: `${mainBranch} 快进到 ${branch}（${sha.slice(0, 7)}）`, data: { main: mainBranch, sha, branch } });
    return;
  }

  if (action === 'push') {
    const sha = out(['rev-parse', 'HEAD'], repo);
    try {
      git(['push', 'origin', mainBranch], repo);
    } catch (err) {
      emit({
        status: 'failed',
        say: `已合到本地 ${mainBranch}（${sha.slice(0, 7)}），但推送失败，留给人处理`,
        error: `push_failed: ${firstLine(err.stderr || err.message)}`,
        data: { pushed: false, sha, main: mainBranch }
      });
      return;
    }
    emit({ status: 'ok', say: `已推送 ${mainBranch}（${sha.slice(0, 7)}）`, data: { pushed: true, sha, main: mainBranch } });
    return;
  }

  if (action === 'abort') {
    // 分支指针在 rebase 期间不动，先记下来再 abort，备份用的就是它
    const branchSha = branch ? refSha(`refs/heads/${branch}`, repo) : '';
    if (inRebase(repo)) git(['rebase', '--abort'], repo);
    toMain(repo, mainBranch);
    if (args.sha) git(['reset', '--hard', args.sha], repo);
    git(['clean', '-fd'], repo);
    let backup = '';
    if (args.backup && branchSha) {
      git(['update-ref', String(args.backup), branchSha], repo);
      backup = String(args.backup);
    }
    let dropped = false;
    if (args.drop && branch) dropped = gitOrNull(['branch', '-D', branch], repo) !== null;
    emit({
      status: 'ok',
      say: `已回到合并前（${out(['rev-parse', '--short=7', 'HEAD'], repo)}）${backup ? `；${branch} 备份在 ${backup}` : ''}${dropped ? `；已删掉 ${branch}` : ''}`,
      data: { main: mainBranch, sha: out(['rev-parse', 'HEAD'], repo), backup, branchSha, dropped }
    });
    return;
  }

  if (action === 'drop') {
    if (!branch) throw new Error('缺 branch');
    const gone = gitOrNull(['branch', '-D', branch], repo) !== null;
    emit({ status: 'ok', say: gone ? `已删掉 ${branch}` : `${branch} 不在（无需删）`, data: { branch, dropped: gone } });
    return;
  }

  throw new Error(`不认识的 action：${action}（queue / status / fetch / sync / rebase / continue / amend / ff / push / abort / drop / log）`);
});
