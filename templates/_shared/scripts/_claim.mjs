// 接单（认领）的共用层，与工单源无关：校验 → 抢接单锁 → 锁里再校验 → 写工单，三家的 `ticket_mark claimed` 都走这里。
// 三家的「认领」都不是原子的（GitHub 贴标签幂等、TAPD 读改写、beads 贴标签再改状态），只「先校验再接单」挡不住
// 两个工人同一秒都校验通过。胜负不在工单评论里决（输的会留一条评论），而是先抢一把按工单号建的锁：
// 锁文件放 git 的共享目录（各 worktree 共用同一个），排他创建抢锁；锁里记 pid，持有进程死了就算过期锁，可以被接管。
// 抢输的什么都不往工单上写，交回 claimed:false 让调用方接着挑下一张。
// 这是模板内容，复制进项目后归项目所有。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { git } from './_lib.mjs';

// 接单评论：一行纯文本标记，工人名写在里面（跟 discuss 的记账标记同款）
export const claimComment = (worker) => `[miworkflow:claim worker=${worker}]`;

// 工作流自己发的状态评论：标记贴在开头，回读与校验都认它（工单系统上就是普通文本，人看得见）。
// 终态之后「有效接单」就不算数了（`STOP_ACTIONS`）；`unpushed` 不在里面——工单还归这个人，只是没推出去。
export const STOP_ACTIONS = ['done', 'failed', 'released', 'merging'];
export const stampComment = (action, text) =>
  [`[miworkflow:${action}]`, String(text ?? '').trim()].filter(Boolean).join('\n\n');

// 工单上贴着的机器标签（三家同名，各 source.mjs 的 LABELS 里也是这些名字）：有任何一个就不该再被接单
const MACHINE_LABELS = ['afk-claimed', 'afk-merging', 'afk-delivered', 'afk-failed'];
export const machineLabels = (labels) =>
  MACHINE_LABELS.filter((m) => (labels ?? []).some((l) => String(l).toLowerCase() === m));

const CLAIM_RE = /\[miworkflow:claim\s+worker=([^\]\s]+)\]/;
const STOP_RE = /\[miworkflow:(done|failed|released|merging)\s*\]/;

// 有效接单人：最后一条接单评论之后没有工作流发的终态评论（释放 / 完成 / 失败 / 等合并）；没有就返回 null
export function claimWorker(comments) {
  let worker = null;
  for (const text of comments ?? []) {
    const s = String(text ?? '');
    if (STOP_RE.test(s)) { worker = null; continue; }
    const m = CLAIM_RE.exec(s);
    if (m) worker = m[1];
  }
  return worker;
}

// 工人名缺省：`<主机名>/<工位目录名>`（不带 --dir 时是主目录的目录名）。dev 按 config.mjs 的 WORKER 算好了传进来，
// 单独手动跑脚本又不给 worker 时退回这个（同一个工人重启后认得出自己接的单）。
export const defaultWorker = (dir) => `${os.hostname()}/${path.basename(path.resolve(dir))}`;

// 项目根（接单锁放它的 git 共享目录里）：调用方给的 cwd，缺省用 `.workflow/` 的上一级
export const projectDirOf = (cwd) => path.resolve(cwd ?? path.join(process.env.AGENTFLOW_HOME || process.cwd(), '..'));

// 锁文件：git 的共享目录 + 按工单号命名（工单号里的 # / 空格 → -）。
// 项目不是 git 仓库时退到系统临时目录（按项目路径分开一份）：让脚本在没有仓库的地方也能单独跑
// （dev 本来就要求干净的 git 工作区，正常路径永远走 git 共享目录）。
export function claimLockFile(cwd, ref) {
  const safe = String(ref).replace(/[^\w.-]+/g, '-');
  const dir = (() => {
    try { return path.resolve(cwd, git(['rev-parse', '--git-common-dir'], cwd).trim()); }
    catch { return path.join(os.tmpdir(), 'miworkflow-claim', createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 12)); }
  })();
  return path.join(dir, `miworkflow-claim-${safe}.lock`);
}

// 持有锁的进程还在不在。认不出 pid（读不出来、不是正整数）算死
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
};

// 抢锁跑 fn：排他创建（wx）成功就是抢到，干完（fn 返回 / 报错）删锁；已有锁时看持有进程还在不在，死了就接管。
// fn = 锁里再校验一遍 + 写工单（可以是 async，TAPD 发完评论要回读），返回结果。
// 出参：{ ok: true, result } 或 { ok: false, holder }
export async function withClaimLock({ cwd, ref, worker }, fn) {
  const file = claimLockFile(cwd, ref);
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, worker, at: new Date().toISOString() }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const held = readHolder(file);
      // 过期锁：持有进程死了，删掉重抢（读与删之间那把锁换人的窗口极小，锁里的第二次校验兜底）
      if (attempt === 0 && !pidAlive(held?.pid)) { rmSync(file, { force: true }); continue; }
      return { ok: false, holder: held?.worker || '别的工人' };
    }
  }
  try { return { ok: true, result: await fn() }; } finally { rmSync(file, { force: true }); }
}

const readHolder = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};
