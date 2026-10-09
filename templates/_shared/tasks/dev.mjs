// 开发工作流：把就绪工单逐个「接单 → 开发 →（审查）→ 验证 → 提交 → 关单」。
// 接单（认领）不是原子操作：`ticket_mark claimed` 内部走「校验 → 抢接单锁 → 锁里再校验 → 发接单评论 + 贴 afk-claimed」，
// 抢输的什么都不写，这里接着挑下一张（共用层见 scripts/_claim.mjs）。工人开跑前先收拾自己上次没收尾的单。
//
// 工位（--dir <目录>）：git 操作、Agent 工作目录、VERIFY 都挪到工位里，工单快照 / 回帖稿 / 日志仍在主目录
// （工位的建与对齐见 scripts/git_worktree.mjs）。每张单开工前工位分离 HEAD 到最新本地主分支；做完把那一笔挂到
// 本地分支 afk/<工单号> 上、贴 afk-merging 标「等合并」——不推 origin、不碰主分支，合入交给主目录的 merge。
// 不带 --dir 一切照旧：在主目录提交、推当前分支、标记完成。两种用法之间不加开关。
//
// 审查按需：工单贴了 source.mjs 的 LABELS.review（缺省 needs-review）、或 DEV 选 done_review 升级、或 config.mjs 的
// REVIEW='always' 才起审查 Agent；其余单子 DEV 自测 + VERIFY 就够（TODO G1）。
// 只通过工单源接口 ticket_ready / ticket_view / ticket_mark 碰工单系统，不知道背后是哪家（入队、标记的规则见各工单源的脚本）。
// 失败就回滚 + 贴评论 + 标记失败，等人看完再重新入队。
// Agent 根本没跑完（基础设施故障）不算工单失败：退避重试，还不行就回滚、释放工单（不贴失败）、整轮停下，下轮重做。
// Agent 被强制结束（卡死：AGENT_IDLE_SEC 秒没动静；超时：2 小时上限）：诊断 Agent 查原因 → 回滚（半成品另存 diff）→
// 评论写明结束时在干什么、诊断、diff → 释放、整轮停下，下轮的 Agent 读到评论换个做法；同一张单满 AGENT_KILL_LIMIT 次就标失败转人工。
//
// 用法：
//   miworkflow dev                    按队列一直跑到空
//   miworkflow dev --max 3            最多做 3 个
//   miworkflow dev --max-failures 1   连续失败 1 次就停（默认 3）
//   miworkflow dev --issue 42         只做工单 42（不看入队和依赖，人点名就跑；被别的工人接走就报错退出、不动这张单）
//   miworkflow dev --dir wt1          在工位 wt1 里做单：交本地分支 afk/<工单号> + 标「等合并」，不推 origin
//   miworkflow dev --confirm          每次提交（+ 推送 + 标记完成）前 human 确认
//   miworkflow dev --dry-run          只报会做哪些工单、哪些被挡住，不改工单、不改 git
//   miworkflow dev --now              忽略退避，立刻就列一次队（队列空过一阵之后不想等）
//
// 省着查（工单系统有调用额度）：队列空的那一轮记退避（logs/dev.pace.json，实现在 scripts/_pace.mjs），
// 空闲期最多每 config.mjs 的 DEV_IDLE_MAX_SEC 秒列一次队；--issue、--dry-run、--now 直接放行。
//   miworkflow stop dev               手头这张单做完（提交、标记）就停，不再挑下一张；--now 立刻强关、半成品留给人
//
// 提交权在工作流：Agent 只改代码、在回话 data 里给 type / summary，审查、验证（和 --confirm）之后由这里统一提交，
// 一张工单一笔，提交信息按工单源的 commitMessage 拼（Agent 自己提交了会被 git_commit 压成这一笔）。
// 工单评论：每次调 Agent 都要它写回帖稿；完成 / 未推送时把各份回帖稿（没写就用它回话里的 reason）
// 拼起来，再由工作流补一段落款（改了哪些文件、审查、验证、提交号），整段交给 ticket_mark。
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEV, REVIEWER, VERIFY, ROUNDS, PUSH, REVIEW, AGENT_RETRY_DELAYS, AGENT_IDLE_SEC, AGENT_KILL_LIMIT, DEV_IDLE_MAX_SEC, WORKER } from '../config.mjs';
import * as source from '../source.mjs';
import { paceOf, clock } from '../scripts/_pace.mjs';
import { defaultWorker } from '../scripts/_claim.mjs';
import { branchOf } from '../scripts/_lib.mjs';

export const title = '开发：认领工单 → 开发 → 审查 → 验证 → 提交 → 关单';

// 实例名（§9）：一个工位 = 一个工人 = 一份该跑的活。--dir 指的是工位目录，目录名就是实例名，
// 于是主目录能同时起 dev --dir wt1、dev --dir wt2（锁 / 停止 / --every 都按 dev@wt1、dev@wt2 各算各的）。
// 不带 --dir 返回空 = 没实例，跟以前一样只有一份。内核只问这个键，不认识工位。
export function instance(args) {
  return args.dir ? path.basename(path.resolve(args.dir)) : '';
}

// .workflow/ 的上一级 = 项目根
const PROJECT = fileURLToPath(new URL('../..', import.meta.url));

// 省着查的记账：logs/dev.pace.json（实现见 scripts/_pace.mjs）
const devPace = paceOf('dev', DEV_IDLE_MAX_SEC);

export default async function ({ script: rawScript, agent, human, args, stopping = () => false }) {
  // 工单脚本内部对工单系统故障退避重试（一次 ticket_mark 可能多条命令各自等），缺省 120 秒不够
  const script = (name, input, opts) =>
    rawScript(name, input, name.startsWith('ticket_') ? { timeoutMs: 900_000, ...opts } : opts);
  const max = args.max ? Number(args.max) : Infinity;
  const maxFailures = args['max-failures'] ? Number(args['max-failures']) : 3;
  const only = args.issue ? String(args.issue) : null;
  // 省着查：退避对所有调用方生效（单跑也读）——只管 --every 循环的话，外面套一层 while 反复单跑，
  // 每轮都实打实列一次队。人点名的（--issue）、干跑、--now 放行：这三种都是当场就要看结果。
  const force = Boolean(args.now || only || process.env.AGENTFLOW_DRY_RUN === '1');
  if (!force && devPace.held()) {
    console.log(`还没到点：${clock(devPace.read().nextAt)} 再查（上一轮队列空；要立刻就做用 --now）`);
    return;
  }
  const ctx = { script, agent, human, args };

  const pre = await script('git_state', { cwd: PROJECT });
  if (pre.status !== 'ok') throw new Error(`看不了 git 状态：${pre.error}`);
  const root = pre.data.root || PROJECT;
  // 工位（--dir）：项目根换成工位——git 操作 / Agent 工作目录 / VERIFY 都在里面做；
  // 任务 / 配置 / 日志 / 工单快照仍在主目录（PROJECT = `.workflow/` 的上一级）
  ctx.main = root;
  ctx.station = args.dir ? path.resolve(root, String(args.dir)) : '';
  ctx.root = root;
  // 工人名（config.mjs 的 WORKER 可改）：写进接单评论，重启后靠它认自己上次没收尾的单；
  // 缺省 `<主机名>/<工位目录名>`（不带 --dir 时是主目录的目录名）
  const worker = WORKER || defaultWorker(ctx.station || root);
  ctx.worker = worker;

  // --dry-run：只报「今天会做哪几张工单、哪些被挡住」，不叫 Agent、不改工单、不改 git。
  // （ticket_mark 自己也支持 dryRun，但那挡不住 Agent 改文件，所以这里直接不进流程。）
  // --dry-run 不进 args（§5），从 env 读。
  if (process.env.AGENTFLOW_DRY_RUN === '1') {
    if (only) {
      const v = await script('ticket_view', { id: only });
      console.log(v.status === 'ok' ? `干跑：会做 ${v.data.ref} ${v.data.title}` : `干跑：读不到工单 ${only}：${v.error}`);
    } else {
      const r = await script('ticket_ready', {});
      const { ready = [], blocked = [] } = r.status === 'ok' ? r.data : {};
      console.log(ready.length
        ? `干跑：就绪 ${ready.length} 个：${ready.map((t) => `${t.ref}(P${t.priority})`).join('、')}`
        : `干跑：队列空${r.status === 'ok' ? '' : `（列不出来：${r.error}）`}`);
      for (const b of blocked) console.log(`干跑：被挡住 ${b.ref}：${b.reason}`);
    }
    console.log('干跑：不改工单、不改 git、不叫 Agent');
    return;
  }

  // 工位准备：不存在就从主分支建（分离 HEAD + 初始化子模块），已存在就查「同一仓库 + 干净」；不干净/建不出来就拒跑
  if (ctx.station) {
    const w = await script('git_worktree', { action: 'ensure', cwd: root, dir: ctx.station });
    if (w.status !== 'ok') throw new Error(`工位用不了：${firstLine(w.error)}`);
    ctx.root = ctx.station;
    console.log(`工位 ${ctx.station}：${w.data.created ? `从 ${w.data.main || '主分支'} 新建（分离 HEAD）` : '复用（干净）'}`);
  }

  // 工人重启：先收拾自己上次没收尾的单（工作区里可能正是那份半成品，清理会把它回滚掉），再要求干净
  await cleanOwnClaims(ctx, worker);
  const start = await script('git_state', { cwd: ctx.root });
  if (start.status !== 'ok') throw new Error(`看不了 git 状态：${start.error}`);
  if (!start.data.clean) throw new Error('工作区有未提交改动，先处理干净再跑（免得把人改的东西提交或回滚掉）');

  // 这一轮接单抢输过的工单：别再来回挑（就绪队列里已经不列它们，只剩锁竞争那一瞬的空窗）
  const skipped = new Set();
  let done = 0;
  let failures = 0;
  let pushStopped = false;
  let infraStopped = false;
  let stop = '队列空';

  for (;;) {
    if (done >= max) { stop = `到上限（--max ${args.max}）`; break; }
    if (failures >= maxFailures) { stop = `连续失败 ${failures} 次`; break; }
    if (only && done + failures > 0) break;
    if (stopping()) { stop = '收到停止请求（miworkflow stop dev）'; break; }

    const t = await pick(only, ctx, skipped);
    if (t?.down) { infraStopped = true; stop = t.down; break; }
    if (!t) { stop = '队列空'; break; }

    const outcome = await runTicket(t, ctx);
    // 接单抢输了：这张单已经被别人接走，什么都不写，接着挑下一张
    if (outcome === 'skipped') { skipped.add(t.id); continue; }
    if (outcome === 'ticket_down') {
      // 工单系统暂时不可用：同 Agent 连接失败，不计入 failures、立即停
      infraStopped = true;
      stop = ctx.down;
      break;
    }
    if (outcome === 'done') { done++; failures = 0; }
    else if (outcome === 'push_failed') {
      pushStopped = true;
      stop = `推送失败（工单 ${t.ref}）：本地提交保留，留给人处理`;
      break;
    } else if (outcome === 'unpushed') {
      pushStopped = true;
      stop = `未推送（PUSH=false，工单 ${t.ref}）：本地提交保留，留给人处理`;
      break;
    } else if (outcome === 'infra_failed') {
      // 不计入 failures（--max-failures 只管业务失败）；接着挑下一张多半也连不上，直接停
      infraStopped = true;
      stop = `Agent 连接失败（工单 ${t.ref}）：已回滚并释放，下轮重做`;
      break;
    } else if (outcome === 'killed_released') {
      // 释放的单还排在队首，本轮接着挑会立刻重做；停下，下轮（--every）再带着诊断评论重做
      infraStopped = true;
      stop = `Agent 被强制结束（工单 ${t.ref}）：已诊断、回滚并释放，下轮带着诊断重做`;
      break;
    } else { failures++; }
  }

  console.log(`本轮结束：完成 ${done} 个，失败 ${failures} 个；${stop}`);
  // 队列空（没做成、也没出事）才记退避；出过事的下一轮照旧快查，别把重试拖慢
  const after = devPace.settle(done > 0 || failures > 0 || pushStopped || infraStopped);
  if (after.idle && after.nextAt > Date.now()) console.log(`队列空，${clock(after.nextAt)} 再查（要立刻就做用 --now）`);
  if (failures > 0) throw new Error(`本轮有 ${failures} 个工单失败（停止原因：${stop}）`);
  if (pushStopped || infraStopped) throw new Error(stop);
}

// 挑下一张要做的工单：--issue 直接读那张；否则列就绪队列取第一张（抢输过的跳过）。
// 工单系统暂时不可用（出参 data.transient）时交回 { down: 停止原因 }，由主循环停下
async function pick(only, ctx, skipped = new Set()) {
  const { script } = ctx;
  let id = only;
  if (id === null) {
    // first：只要第一张可做的就行——别为后面整条队列（每张一次依赖查询、每个前置一次 /stories）付钱。
    // 抢输过一次就得看整条队列，才能跳过那张（只在锁竞争那一瞬的窗口里发生，平时走上面那条便宜路）
    const r = await script('ticket_ready', skipped.size ? {} : { first: true });
    if (r.status !== 'ok') {
      if (transient(r)) return { down: `工单系统暂时不可用（列就绪工单）：${firstLine(r.error)}` };
      throw new Error(`列就绪工单失败：${r.error}`);
    }
    id = (r.data.ready ?? []).find((x) => !skipped.has(x.id))?.id ?? null;
  }
  if (id === null) return null;
  const v = await script('ticket_view', { id });
  if (v.status !== 'ok') {
    if (transient(v)) return { down: `工单系统暂时不可用（读工单 ${id}）：${firstLine(v.error)}` };
    throw new Error(`读工单 ${id} 失败：${v.error}`);
  }
  return v.data;
}

const transient = (r) => r?.data?.transient === true;

// 一张工单走完全程；返回 'done' | 'failed' | 'push_failed' | 'unpushed' | 'infra_failed' | 'killed_released' | 'ticket_down'（停止原因在 ctx.down）
async function runTicket(t, ctx) {
  const { script, human, args, root, worker } = ctx;

  const claim = await script('ticket_mark', { id: t.id, action: 'claimed', worker, cwd: root });
  if (claim.status !== 'ok') {
    console.error(`${t.ref} 接单失败：${claim.error}`);
    if (transient(claim)) {
      ctx.down = `工单系统暂时不可用（接单 ${t.ref}）：下轮重做`;
      return 'ticket_down';
    }
    return 'failed';
  }
  // 工单源交回 claimed:false = 这一单没抢到（别人刚接走 / 锁在别人手里），工单上一个字都没写
  if (claim.data?.claimed === false) {
    const why = String(claim.data.reason ?? '已被别的工人接走');
    // 人点名的（--issue）就报错退出、不动这张单；队列里挑的接着挑下一张
    if (args.issue) throw new Error(`${t.ref} ${why}`);
    console.log(`跳过 ${t.ref}：${why}`);
    return 'skipped';
  }

  // 开工：工位分离 HEAD 到最新的本地主分支 + 更新子模块（每张单重新对齐，不在上一单的落点上叠）
  if (ctx.station) {
    const a = await script('git_worktree', { action: 'align', cwd: ctx.main, dir: ctx.station });
    if (a.status !== 'ok') {
      // 工位用不了（主分支取不到 / 工位脏了）：这张单没开工，释放回队列，整轮停下留给人看
      markQuietly(await script('ticket_mark', { id: t.id, action: 'released', comment: `工位对齐不了，这张单没开工：${firstLine(a.error)}` }), t, '释放');
      throw new Error(`${t.ref} 的工位对齐不了：${firstLine(a.error)}`);
    }
  }

  const base = (await script('git_state', { cwd: root })).data.sha;
  // 每次调 Agent 的回帖稿与回话，完成时拼进评论
  const notes = [];

  // 1. 开发（每次调 Agent 都分配一份新的回帖稿；失败时它写了就跟着评论发回工单）
  let reply = nextReply(t);
  // 重试前回到本轮起点，免得在半成品上续写；那时备份掉的提交也要写进释放评论
  let saved = '';
  const dev = await callAgent(ctx, devPrompt(t, root, reply), {
    label: '开发Agent',
    ...(DEV ? { agent: DEV } : {}),
    inputs: { cwd: root, ticket: t.file, reply, choices: ['done', 'done_review', 'no_change'] }
  }, async () => { saved += await rollback(base, ctx); });
  notes.push({ who: '开发', reply, answer: dev });
  if (dev.infra) return release(t, dev, base, ctx, saved);
  if (dev.status === 'need_human') return fail(t, `Agent 提问：${dev.reason}`, base, ctx, reply);
  if (dev.status !== 'ok' || !['done', 'done_review', 'no_change'].includes(dev.choice)) {
    return fail(t, `开发失败（${dev.choice}）：${dev.reason}`, base, ctx, reply);
  }
  if (dev.choice === 'no_change') return fail(t, `Agent 判断无需改动：${dev.reason}`, base, ctx, reply);

  // 2. 信 git，不信 Agent 自报
  const st = await script('git_state', { cwd: root, baseSha: base });
  if (st.status !== 'ok') return fail(t, `看不了改动：${st.error}`, base, ctx);
  const changed = st.data.changed;
  if (!changed.length) return fail(t, `Agent 报完成，但 git 看不到改动：${dev.reason}`, base, ctx, reply);

  // 3. 审查（有问题直接改）：REVIEW='always'、工单贴了「要审查」标签，或 DEV 主动升级（done_review）才起；
  //    其余单子 DEV 自测 + VERIFY 就够，不起审查 Agent（TODO G1）。
  const needReview = REVIEW === 'always' || t.review === true || dev.choice === 'done_review';
  if (needReview) {
    reply = nextReply(t);
    const rev = await callAgent(ctx, reviewPrompt(t, root, changed, reply), {
      label: '审查Agent',
      ...(REVIEWER ? { agent: REVIEWER } : {}),
      inputs: { cwd: root, ticket: t.file, reply, changed, choices: ['clean', 'refined', 'reject'] }
    });
    notes.push({ who: '审查', reply, answer: rev });
    if (rev.infra) return release(t, rev, base, ctx, saved);
    if (rev.status === 'need_human') return fail(t, `审查者提问：${rev.reason}`, base, ctx, reply);
    if (rev.status !== 'ok' || !['clean', 'refined'].includes(rev.choice)) {
      return fail(t, `审查未通过（${rev.choice}）：${rev.reason}`, base, ctx, reply);
    }
  }

  // 4. 验证（配了才跑）；不过就把输出交回 DEV 再改，最多 ROUNDS 轮
  let round = 0;
  if (VERIFY) {
    for (;;) {
      const v = await script('run_cmd', { cmd: VERIFY, cwd: root }, { timeoutMs: 1_800_000 });
      if (v.status === 'ok') break;
      if (round >= ROUNDS) {
        return fail(t, `验证不过（已重试 ${round} 轮）：${lastLines(v.data?.tail)}`, base, ctx);
      }
      round++;
      reply = nextReply(t);
      const fix = await callAgent(ctx, fixPrompt(t, root, VERIFY, v.data?.tail, reply), {
        label: '修正Agent',
        ...(DEV ? { agent: DEV } : {}),
        inputs: { cwd: root, ticket: t.file, reply, verify: VERIFY, output: v.data?.tail, choices: ['fixed', 'give_up'] }
      });
      notes.push({ who: '验证后修正', reply, answer: fix });
      if (fix.infra) return release(t, fix, base, ctx, saved);
      if (fix.status !== 'ok' || fix.choice !== 'fixed') {
        return fail(t, `验证失败后放弃：${fix.reason}`, base, ctx, reply);
      }
    }
  }

  // 5. 带 --confirm 才找人点头；不带就无人值守。门在提交之前：拒绝就回滚，什么都没留下。
  if (args.confirm) {
    const h = await human(`${t.ref} 改动就绪（已审查${VERIFY ? '、已验证' : ''}），提交${PUSH ? '并推送' : ''}、标记完成？`);
    if (h.status !== 'ok') return fail(t, '人工拒绝提交', base, ctx);
  }

  // 6. 提交（+ 推送）：一张工单一笔（Agent 自己做的提交压进来），提交信息按工单源格式拼。
  //    带 --dir 的工位用法只交本地单子分支 afk/<工单号>（同名覆盖）、不推 origin——合入交给主目录的 merge
  const msg = source.commitMessage(t, commitInfo(t, notes));
  const branch = ctx.station ? branchOf(t.id) : '';
  const c = await script('git_commit', {
    message: msg.message,
    ...(msg.body ? { body: msg.body } : {}),
    baseSha: base,
    push: branch ? false : PUSH,
    cwd: root,
    ...(branch ? { branch } : {})
  });
  if (c.status !== 'ok') {
    // 推送失败：本地提交保留，不关单、保留 afk-claimed、整轮停下
    if (c.data?.committed) {
      const file = await report(t, ctx, notes, { base, sha: c.data.sha, subject: msg.message, round,
        head: `已本地提交 ${short(c.data.sha)}，但推送失败，工单保持打开，等人处理：${firstLine(c.error)}` });
      return notPublished('push_failed', t, c.data.sha, ctx, file);
    }
    return fail(t, `提交失败：${c.error}`, base, ctx);
  }

  // 工位交单：标记「等合并」——不算交付（依赖这张单的单仍被挡住），不推 origin
  if (branch) return submitted(t, ctx, notes, { base, sha: c.data.sha, subject: msg.message, round, branch });

  // 提交成功但没推送（PUSH=false）：跟推送失败同款语义——没发布就不算做完
  if (c.data.pushed === false) {
    const file = await report(t, ctx, notes, { base, sha: c.data.sha, subject: msg.message, round,
      head: `已本地提交 ${short(c.data.sha)}，没有推送（PUSH=false），工单保持打开，等人处理。` });
    return notPublished('unpushed', t, c.data.sha, ctx, file);
  }

  // 7. 标记完成（评论：回帖稿 + 落款）
  const file = await report(t, ctx, notes, { base, sha: c.data.sha, subject: msg.message, round, pushed: true,
    head: `已完成，提交 ${short(c.data.sha)} 已推送。` });
  const marked = await script('ticket_mark', { id: t.id, action: 'done', sha: c.data.sha, commentFile: file });
  if (marked.status !== 'ok') {
    // 已经提交推送出去了，回滚反而更糟；留着让人看
    console.error(`${t.ref} 已提交但关单失败：${marked.error}`);
    if (transient(marked)) {
      ctx.down = `已推送 ${c.data.sha.slice(0, 7)}，工单 ${t.ref} 标记完成失败：工单系统暂时不可用，需人补标记`;
      return 'ticket_down';
    }
    return 'failed';
  }

  console.log(`✔ ${t.ref} ${t.title}（${short(c.data.sha)}）`);
  return 'done';
}

// 工人开跑前的重启清理：有效接单人是我、又还没交出去（没有释放 / 完成 / 失败 / 等合并评论）的单，回滚工作目录、
// 发释放评论、摘 afk-claimed，让它重新排队。别人接的、已经交付的一概不碰。
async function cleanOwnClaims(ctx, worker) {
  const { script } = ctx;
  const r = await script('ticket_ready', { claims: true });
  if (r.status !== 'ok') {
    const why = `查自己没收尾的单失败：${firstLine(r.error)}`;
    if (transient(r)) throw new Error(`工单系统暂时不可用（${why}）`);
    throw new Error(why);
  }
  for (const c of r.data.claimed ?? []) {
    // 带 afk-claimed 的单里认自己那份：有效接单人由工单源从评论里的接单标记算出来
    const v = await script('ticket_view', { id: c.id });
    if (v.status !== 'ok') {
      console.error(`  看不了 ${c.ref} 的接单状态，跳过：${firstLine(v.error)}`);
      continue;
    }
    if (v.data.claim !== worker) continue;
    const base = (await script('git_state', { cwd: ctx.root })).data.sha;
    const note = await rollback(base, ctx);
    const rel = await script('ticket_mark', {
      id: c.id,
      action: 'released',
      comment: `工人 ${worker} 上一轮没做完（重启），已回滚并释放，重新排队${note}`
    });
    console.log(`清理自己没收尾的 ${c.ref}：已回滚并释放`);
    markQuietly(rel, c, '释放');
  }
}

// 工位交单的收尾：本地提交已挂到 afk/<工单号> 上，标记「等合并」——不算交付，等主目录的 merge 合入
// 落款里写明分支名，merge 那边靠它 rebase；不推 origin、不关单
async function submitted(t, ctx, notes, { base, sha, subject, round, branch }) {
  const file = await report(t, ctx, notes, { base, sha, subject, round, branch, pushed: false,
    head: `已完成：提交 ${short(sha)} 挂在本地分支 \`${branch}\` 上，等合并（没有推送）。` });
  const marked = await ctx.script('ticket_mark', { id: t.id, action: 'merging', sha, branch, commentFile: file });
  if (marked.status !== 'ok') {
    // 提交和分支都已经在了，改回失败反而更糟；留着让人看
    console.error(`${t.ref} 已提交但标记等合并失败：${marked.error}`);
    if (transient(marked)) {
      ctx.down = `已提交 ${short(sha)}（${branch}），工单 ${t.ref} 标记等合并失败：工单系统暂时不可用，需人补标记`;
      return 'ticket_down';
    }
    return 'failed';
  }
  console.log(`✔ ${t.ref} ${t.title}（${short(sha)}，等合并 ${branch}）`);
  return 'done';
}

// 提交成功但没发布（PUSH=false 或推送失败）：评论注明未推送、保留 afk-claimed、不关单，整轮停下留给人处理
async function notPublished(outcome, t, sha, ctx, commentFile) {
  markQuietly(await ctx.script('ticket_mark', { id: t.id, action: 'unpushed', sha, commentFile }), t, '记录未推送');
  console.error(`✖ ${t.ref} 本地提交（未推送）：${short(sha)}，工单保持打开`);
  return outcome;
}

// 任何一步失败：回滚到起点，ticket_mark failed 并附原因（怎么落到工单上由工单源决定）
// 回滚如果要丢掉提交，git_restore 会先备份成 ref——把那个 ref 写进评论，人才能捞回来（TODO B7）
// reply：刚结束那次 Agent 调用的回帖稿路径（写没写由 ticket_mark 看）
async function fail(t, reason, base, ctx, reply) {
  console.error(`✖ ${t.ref} ${reason}`);
  const note = await rollback(base, ctx);
  markQuietly(await ctx.script('ticket_mark', { id: t.id, action: 'failed', comment: `afk failed：${reason}${note}`, ...(reply ? { commentFile: reply } : {}) }), t, '标记失败');
  return 'failed';
}

// 收尾时的 ticket_mark 失败只打印，不覆盖这张工单原来的结果
function markQuietly(r, t, what) {
  if (r.status === 'ok') return;
  console.error(`  ${t.ref} ${what}没成功${transient(r) ? '（工单系统暂时不可用）' : ''}：${firstLine(r.error)}`);
}

// Agent 基础设施故障重试用完（或不该重试）：回滚到起点，ticket_mark released——摘认领、不贴失败、保留入队，下轮重做
// r：callAgent 交回的结果（infra 是原因首句）；saved：重试时已经回滚备份过的提交备注
async function release(t, r, base, ctx, saved = '') {
  if (KILLED[r.choice]) return killed(t, r, base, ctx, saved);
  console.error(`✖ ${t.ref} Agent 连接失败：${r.infra}`);
  const note = saved + await rollback(base, ctx);
  markQuietly(await ctx.script('ticket_mark', { id: t.id, action: 'released', comment: `Agent 连接失败，已回滚并释放，下轮重做：${r.infra}${note}` }), t, '释放');
  return 'infra_failed';
}

// 被强制结束的两种情形：名字写进评论；focus 告诉诊断 Agent 该往哪查
const KILLED = {
  agent_idle: { name: '卡死', focus: '它是长时间没有任何动静被结束的：重点查最后那条命令 / 那一步为什么迟迟不返回。' },
  agent_timeout: { name: '超时', focus: '它一直在干活，但到了总时长上限还没做完：重点查时间花在了哪——在兜圈子重复同样的尝试、某一步本身很慢，还是这张单太大该拆。' }
};

// 被强制结束（卡死 / 超时）：趁半成品还在先让诊断 Agent 查原因 → 回滚（半成品另存 diff）→ 评论（适配器记的事实 + 诊断 + diff 位置）→
// 没满 AGENT_KILL_LIMIT 次就释放，下轮的 Agent 读快照里的评论换个做法；满了就标失败转人工。
// 第几次 = 快照里以前这类评论出现的次数 + 1（评论开头是 KILL_MARK，卡死、超时合并计数），不另加标签。
// 按出现次数数、不按行首：TAPD 的快照里评论的换行会被抹成空格（htmlToMarkdown），标记会落在行中间
const KILL_MARK = 'Agent 被强制结束（第';
async function killed(t, r, base, ctx, saved) {
  const kind = KILLED[r.choice];
  const n = countKilled(t.file) + 1;
  const last = n >= AGENT_KILL_LIMIT;
  console.error(`✖ ${t.ref} ${r.reason}`);
  const diagnosis = await diagnose(t, r, kind, ctx);
  const back = await restore(base, ctx, { diffFile: path.join(path.dirname(t.file), `killed-${n}.diff`) });
  const parts = [
    `${KILL_MARK} ${n} 次，${kind.name}；${last ? `已满 ${AGENT_KILL_LIMIT} 次，不再自动重做` : `满 ${AGENT_KILL_LIMIT} 次转人工`}）：${r.reason}`,
    `${back?.data?.diff ? `半成品改动已回滚，diff 存在 \`${back.data.diff}\`，接手时可以参考。` : '工作区没有留下改动。'}${saved}${lostNote(back)}`,
    `**诊断**\n${diagnosis}`,
    last ? '等人看过再重新入队。' : '接手的 Agent：先读上面的诊断，换个做法，别走同一条路。'
  ];
  const file = path.join(path.dirname(t.file), `killed-${n}.md`);
  writeFileSync(file, `${parts.join('\n\n')}\n`);
  if (last) {
    markQuietly(await ctx.script('ticket_mark', { id: t.id, action: 'failed', comment: `afk failed：Agent 第 ${n} 次被强制结束`, commentFile: file }), t, '标记失败');
    return 'failed';
  }
  markQuietly(await ctx.script('ticket_mark', { id: t.id, action: 'released', commentFile: file }), t, '释放');
  return 'killed_released';
}

function countKilled(ticketFile) {
  let text = '';
  try { text = readFileSync(ticketFile, 'utf8'); } catch { /* 读不到当 0 次 */ }
  return text.split(KILL_MARK).length - 1;
}

// 诊断 Agent：只读，查上一个 Agent 为什么没做完、进展到哪、下次怎么做；没跑成就只留适配器记的事实
async function diagnose(t, r, kind, ctx) {
  const reply = nextReply(t);
  const d = r.data ?? {};
  const res = await ctx.agent(render('diagnose', {
    cwd: ctx.root, ticket: t.file, reply, reason: r.reason, focus: kind.focus, trace: d.trace ?? '（没有）', events: d.events ?? '（没有）'
  }), {
    label: '诊断Agent',
    ...(DEV ? { agent: DEV } : {}),
    inputs: { cwd: ctx.root, ticket: t.file, trace: d.trace, events: d.events, reply, choices: ['diagnosed'] },
    budget: { timeoutSec: 900, idleSec: 300 }
  });
  const draft = readDraft(reply);
  if (draft) return draft;
  if (res.status === 'ok' && String(res.reason ?? '').trim()) return String(res.reason).trim();
  return `诊断 Agent 没跑成（${firstLine(res.reason) || res.choice}），只有上面记的结束时在干什么。`;
}

// 回滚到起点；丢掉的提交已由 git_restore 备份成 ref，返回写进评论的那句备注（没丢提交就是空串）
async function rollback(base, ctx) {
  return lostNote(await restore(base, ctx));
}

async function restore(base, ctx, extra = {}) {
  if (!base) return null;
  return ctx.script('git_restore', { sha: base, cwd: ctx.root, ...extra });
}

function lostNote(r) {
  if (!r?.data?.lost?.length) return '';
  console.error(`  回滚掉的提交备份在 ${r.data.backup}`);
  return `\n（回滚掉的 ${r.data.lost.length} 笔提交备份在 ${r.data.backup}：${r.data.lost.map((l) => l.split(' ')[0]).join(' ')}）`;
}

// 调 Agent：区分「Agent 说不行」（原样交回，照旧走 fail）和「Agent 根本没跑完」（基础设施故障）。
// 后者按 AGENT_RETRY_DELAYS 退避重试同一步（beforeRetry 给开发用来先回到起点）；
// 用完或不该重试就交回 { ...结果, infra: 原因首句 }，由调用方 release。
async function callAgent(ctx, goal, opts, beforeRetry) {
  for (let i = 0; ; i++) {
    const r = await ctx.agent(goal, { ...opts, budget: { idleSec: AGENT_IDLE_SEC, ...opts.budget } });
    const kind = infraKind(r);
    if (!kind) return r;
    const why = firstLine(r.reason) || r.choice;
    if (kind === 'stop' || i >= AGENT_RETRY_DELAYS.length) return { ...r, infra: why };
    const wait = AGENT_RETRY_DELAYS[i];
    console.error(`  Agent 没跑完，第 ${i + 1} 次重试（等 ${Math.round(wait / 1000)} 秒）：${why}`);
    await sleep(wait);
    if (beforeRetry) await beforeRetry();
    if (opts.inputs?.reply) rmSync(opts.inputs.reply, { force: true });
  }
}

// 'retry'：连不上 / 崩了 / 被杀了什么都没吐；'stop'：没配 Agent、被强制结束（卡死 / 超时，重试也白搭，由 release 转去诊断）；
// null：Agent 自己给的结论
function infraKind(r) {
  if (r.choice === 'agent_unavailable' || KILLED[r.choice]) return 'stop';
  if (r.choice === 'agent_cli_failed') return 'retry';
  if (r.choice === 'agent_invalid_json' && !String(r.data?.stdout ?? '').trim()) return 'retry';
  return null;
}

const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.split(/(?<=[。！？.!?])\s*/)[0] ?? '';

// 回帖稿放工单快照同目录：reply-1.md、reply-2.md …（图片也放这里，相对路径引用）
const replies = new Map();
function nextReply(t) {
  const k = replies.get(t.file) ?? 0;
  replies.set(t.file, k + 1);
  return path.join(path.dirname(t.file), `reply-${k + 1}.md`);
}

const lastLines = (text, n = 5) => String(text ?? '').split('\n').filter(Boolean).slice(-n).join(' / ');
const short = (sha) => String(sha ?? '').slice(0, 7);

// ── 提交信息：Agent 回话 data 里的 type / summary，后面的（审查、修正）覆盖前面的 ──
const commitTypes = () => (Array.isArray(source.COMMIT_TYPES) ? source.COMMIT_TYPES : []);

function commitInfo(t, notes) {
  const types = commitTypes();
  let type = '';
  let summary = '';
  for (const { answer } of notes) {
    const d = answer?.data && typeof answer.data === 'object' ? answer.data : {};
    if (typeof d.type === 'string' && d.type.trim()) type = d.type.trim().toLowerCase();
    if (typeof d.summary === 'string' && d.summary.trim()) summary = d.summary;
  }
  if (!types.includes(type)) type = types[0] ?? '';
  return { type, summary: cleanSummary(summary, t, types) || cleanSummary(t.title, t, types) || t.ref };
}

// 一行、去掉 Agent 自己加的类型前缀和工单号、去掉句末标点，最长 72 字
function cleanSummary(text, t, types) {
  let s = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (types.length) s = s.replace(new RegExp(`^(?:${types.join('|')})\\s*[:：]\\s*`, 'i'), '');
  for (const id of new Set([String(t.id), String(t.id).slice(-7), t.ref])) {
    if (id) s = s.split(id).join('');
  }
  return s.replace(/^[\s:：#-]+/, '').replace(/[\s。.！!]+$/, '').slice(0, 72).trim();
}

// ── 完成 / 未推送的评论：开头一句 + 各份回帖稿（没写就用回话 reason）+ 工作流落款 ──
// 写成工单快照同目录的 comment.md（回帖稿里的相对图片路径照样能解析），交给 ticket_mark 的 commentFile
async function report(t, ctx, notes, { head, base, sha, subject, round, pushed = false, branch = '' }) {
  const st = await ctx.script('git_state', { cwd: ctx.root, baseSha: base });
  const files = st.data?.changed ?? [];
  const parts = [head];
  for (const { who, reply, answer } of notes) {
    const draft = readDraft(reply);
    const reason = String(answer?.reason ?? '').trim();
    if (draft) parts.push(`**${who}**\n${draft}`);
    else if (reason) parts.push(`**${who}**（没写回帖稿，这是它的回话）\n${reason}`);
  }
  const review = notes.find((n) => n.who === '审查')?.answer?.choice;
  const reviewed = review !== undefined;
  const shown = files.slice(0, 15).map((f) => `- \`${f}\``);
  if (files.length > shown.length) shown.push(`- ……等共 ${files.length} 个`);
  parts.push([
    '---',
    `改动 ${files.length} 个文件${st.data?.stat ? `（${st.data.stat}）` : ''}：`,
    ...shown,
    '',
    `审查：${!reviewed ? `没审查（REVIEW=${REVIEW}：工单没贴 ${source.LABELS?.review ?? 'needs-review'}，DEV 也没升级）` : review === 'refined' ? '审查者做了修正' : '审查者看过，没有改动'}`,
    `验证：${VERIFY ? `\`${Array.isArray(VERIFY) ? VERIFY.join(' ') : VERIFY}\` 通过${round ? `（验证不过后修了 ${round} 轮）` : ''}` : '没配验证命令，工作流没有跑编译或测试'}`,
    `提交：${short(sha)} ${subject}（${branch ? `等合并，本地分支 \`${branch}\`` : pushed ? '已推送' : '未推送'}）`
  ].join('\n'));
  const file = path.join(path.dirname(t.file), 'comment.md');
  writeFileSync(file, `${parts.join('\n\n')}\n`);
  return file;
}

function readDraft(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

// ── 提示词：正文在 prompts/dev|review|fix|diagnose.md，{{名字}} 占位 ──
const PROMPTS = {
  dev: fileURLToPath(new URL('../prompts/dev.md', import.meta.url)),
  review: fileURLToPath(new URL('../prompts/review.md', import.meta.url)),
  fix: fileURLToPath(new URL('../prompts/fix.md', import.meta.url)),
  diagnose: fileURLToPath(new URL('../prompts/diagnose.md', import.meta.url))
};

// 项目自己的补充要求：prompts/local/<dev|review|fix|diagnose>.md，各接到对应提示词的 {{local}} 处；不在模板里，init --upgrade 不碰
const localPrompt = (kind) => {
  let text = '';
  try { text = readFileSync(fileURLToPath(new URL(`../prompts/local/${kind}.md`, import.meta.url)), 'utf8').trim(); } catch { /* 没有就不加 */ }
  return text ? `\n项目补充要求（与上面冲突时以这里为准）：\n${text}\n` : '';
};

// 一趟替换：填进去的值（快照路径、验证输出、项目补充要求）里就算有 {{…}} 也不会再被替换
function render(kind, vars) {
  const all = { ...vars, local: localPrompt(kind) };
  return readFileSync(PROMPTS[kind], 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in all ? String(all[k]) : m));
}

// 回话 data 里要给的提交信息：工单源没有类型表就只要 summary
function commitData() {
  const types = commitTypes();
  const summary = 'summary 是写进提交标题的一句话：中文、30 字以内、不带句号、不写工单号（例：背包改为按品质排序）';
  return types.length
    ? `\`{"type": "…", "summary": "…"}\`——type 从 ${types.join(' / ')} 里选一个；${summary}`
    : `\`{"summary": "…"}\`——${summary}`;
}

function devPrompt(t, root, reply) {
  return render('dev', { cwd: root, ticket: t.file, reply, commitData: commitData() });
}

function reviewPrompt(t, root, changed, reply) {
  return render('review', {
    cwd: root,
    reply,
    changed: changed.map((f) => `- ${f}`).join('\n'),
    ticket: t.file,
    commitData: commitData()
  });
}

function fixPrompt(t, root, verify, output, reply) {
  return render('fix', {
    cwd: root,
    reply,
    verify: Array.isArray(verify) ? verify.join(' ') : verify,
    output: String(output ?? '').split('\n').slice(-60).join('\n'),
    ticket: t.file
  });
}
