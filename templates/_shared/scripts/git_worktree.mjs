// 工位（`dev --dir <工位>`）：工人从主目录起、活在工位里干。工位是一份长期存在的 git 工作副本
// （本机是 worktree，别的机器是 clone），里面不放 `.workflow/`——任务 / 配置 / 日志只有主目录一份。
//
// action=ensure（工人启动时）：目录不存在就从主分支建一个分离 HEAD 的 worktree、初始化子模块（通用做法，项目自己的准备由项目脚本先做）；
//   已存在就只查两件事——是同一个仓库的工作副本、工作区干净；不干净就 failed 并说清原因，工人据此拒跑。
// action=align（每张单开工前）：把工位分离 HEAD 到最新的本地主分支，再更新子模块（merge 推进主分支后所有工位立刻可见，各自不用 fetch）。
//
// 主分支自动认 origin/HEAD 指向的分支（不加配置项）；取不到（没有 origin、克隆时没带）退回主目录当前分支。
// 入：{ action?: 'ensure' | 'align', dir, cwd? }；cwd = 主目录（`.workflow/` 的上一级）
// 出：{ status, say, data: { dir, root, main, created, sha } }
import { existsSync } from 'node:fs';
import path from 'node:path';
import { main, readStdin, emit, git, gitOrNull } from './_lib.mjs';

const out = (argv, cwd) => {
  const r = gitOrNull(argv, cwd);
  return r === null ? '' : r.trim();
};
const can = (argv, cwd) => gitOrNull(argv, cwd) !== null;

// 主分支名：origin/HEAD（refs/remotes/origin/<名>）→ 主目录当前分支；分离 HEAD 又没 origin 就是空
function mainBranchOf(repo) {
  const head = out(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repo);
  const name = head.replace(/^refs\/remotes\/origin\//, '');
  if (name) return name;
  const cur = out(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  return cur === 'HEAD' ? '' : cur;
}

// 参照点：优先本地主分支（最新的本地主分支），再是 origin 上的同名分支，最后退回 HEAD
function startPoint(repo, name) {
  for (const c of name ? [`refs/heads/${name}`, `refs/remotes/origin/${name}`] : []) {
    if (can(['rev-parse', '--verify', '--quiet', c], repo)) return c;
  }
  return can(['rev-parse', '--verify', '--quiet', 'HEAD'], repo) ? 'HEAD' : '';
}

// 工位与主目录是不是同一个仓库的工作副本（worktree 与主仓库共用同一个 git 目录）
function commonDir(dir) {
  const raw = out(['rev-parse', '--git-common-dir'], dir);
  return raw ? path.resolve(dir, raw) : '';
}

// 子模块随工位一起初始化 / 更新；项目没有子模块时这条命令直接成功返回
const submodules = (dir) => git(['submodule', 'update', '--init'], dir);

await main(async () => {
  const args = await readStdin();
  const action = args.action ?? 'ensure';
  if (!['ensure', 'align'].includes(action)) throw new Error(`不认识的 action：${action}（ensure / align）`);
  if (!args.dir) throw new Error('缺 dir');
  const repo = out(['rev-parse', '--show-toplevel'], args.cwd ?? process.cwd());
  if (!repo) throw new Error(`${args.cwd ?? process.cwd()} 不是 git 仓库`);
  const dir = path.resolve(repo, String(args.dir));
  const name = mainBranchOf(repo);
  const start = startPoint(repo, name);
  if (!start) throw new Error('主目录还没有提交，先提交一次再开工位');

  const created = !existsSync(dir);
  if (created) {
    if (action === 'align') throw new Error(`工位 ${dir} 不存在，先让工人启动时建（ensure）`);
    git(['worktree', 'add', '--detach', dir, start], repo);
    submodules(dir);
  } else {
    const theirs = commonDir(dir);
    if (!theirs || theirs !== commonDir(repo)) {
      throw new Error(`${dir} 不是本仓库的工作副本（${repo}）；工位要是本仓库的 worktree（目录不存在时工人会自己建）`);
    }
    const dirty = git(['status', '--porcelain'], dir).trim();
    if (dirty) {
      const files = dirty.split('\n').filter(Boolean);
      throw new Error(`工位 ${dir} 不干净（${files.length} 处改动，先处理干净再跑）：${files.slice(0, 5).map((l) => l.trim()).join('、')}${files.length > 5 ? ' 等' : ''}`);
    }
    if (action === 'align') {
      git(['checkout', '--detach', start], dir);
      submodules(dir);
    }
  }

  const sha = out(['rev-parse', 'HEAD'], dir);
  emit({
    status: 'ok',
    say: `工位 ${dir}：${created ? '从主分支新建（分离 HEAD）' : action === 'align' ? `对齐到 ${name || start}（分离 HEAD）` : '复用（干净）'}`,
    data: { dir, root: dir, main: name, created, sha }
  });
});
