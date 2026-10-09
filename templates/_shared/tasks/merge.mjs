// 合并工作流：把工人在工位里交上来的单子分支（`afk/<工单号>`）逐张合入主分支。
// 主目录里跑，一般 `merge --every`（工位产出唯一的合入口）。一次一张：先交先合（按分支 tip 的提交时间，不看标签、不看优先级）。
//
// 每轮开始：主目录整个干净（`.workflow/` 本来就被 git 忽略，不开例外，不干净就说清哪里脏）→ fetch →
// 本地主分支快进到 origin 上那份（分叉了停下交给人）→ 列 `afk/*` 分支取第一张。
//
// 每张单：rebase 到主分支 → 有冲突交给合并 Agent（给工单快照、冲突文件、主分支新进来的提交；只解冲突，两边意图都保留）→
// 验证（工人开工以来主分支没动过就跳过；动过就跑 VERIFY，不过交回合并 Agent 修，最多 ROUNDS 轮）→ 快进主分支 → 推 origin →
// 推送成功才 ticket_mark done（GitHub 关单 / 贴 afk-delivered），然后删掉单子分支。
//
// 合并失败（冲突解不了 / 验证修不好）：回到合并前 → 单子分支备份成 ref 后删掉 → 摘 afk-merging、评论写明原因、退回就绪队列
// （ticket_mark requeued），工人在最新主分支上重做；同一张单满 MERGE_FAIL_LIMIT 次就贴 afk-failed 转人工
// （次数按工单快照里这类评论的条数算，做法同 dev 的「Agent 被强制结束」计数）。
// 推送失败：本地主分支保留、不关单、整轮停下（同 dev 的推送失败）。
// 合并 Agent 没跑成（连不上 / 卡死 / 超时）：退回队列但不计入失败次数，整轮停下，下轮重来。
//
// 用法：
//   miworkflow merge                把队列合完
//   miworkflow merge --max 1        最多合 1 张
//   miworkflow merge --max-failures 1  连续失败 1 次就停（默认 3）
//   miworkflow merge --dry-run      只报队列里有哪些单子分支，不动 git、不改工单
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { MERGER, VERIFY, ROUNDS, AGENT_RETRY_DELAYS, AGENT_IDLE_SEC, MERGE_FAIL_LIMIT } from '../config.mjs';

export const title = '合并：单子分支 rebase → 解冲突 → 验证 → 推送 → 关单';

// .workflow/ 的上一级 = 项目根（主目录）
const PROJECT = fileURLToPath(new URL('../..', import.meta.url));

export default async function ({ script: rawScript, agent, args, stopping = () => false }) {
  // 工单脚本内部对工单系统故障退避重试（一次 ticket_mark 可能多条命令各自等），缺省 120 秒不够
  const script = (name, input, opts) =>
    rawScript(name, input, name.startsWith('ticket_') ? { timeoutMs: 900_000, ...opts } : opts);
  const pre = await script('git_state', { cwd: PROJECT });
  if (pre.status !== 'ok') throw new Error(`看不了 git 状态：${pre.error}`);
  const root = pre.data.root || PROJECT;
  const g = (action, extra = {}) => script('git_merge', { action, cwd: root, ...extra });

  // 启动校验（§10.1）：配置不对就不启动——不动 git、不改工单、不叫 Agent；干跑也一样查
  await checkConfig(agent);

  const st = await g('status');
  if (st.status !== 'ok') throw new Error(`看不了仓库：${st.error}`);
  const main = st.data.main;
  if (!main) throw new Error('认不出主分支：merge 要在主目录跑，主目录要么在分支上，要么有 origin/HEAD');

  // --dry-run：只报队列，不动 git、不改工单
  if (process.env.AGENTFLOW_DRY_RUN === '1') {
    const q = await g('queue');
    const list = q.data?.branches ?? [];
    console.log(list.length
      ? `干跑：等合并 ${list.length} 个（先交先合）：${list.map((b) => b.id).join('、')}`
      : '干跑：没有等合并的单子分支');
    console.log(`干跑：在主目录 ${root} 上会把 ${main} 对齐 origin、逐张 rebase，不改工单、不叫 Agent`);
    return;
  }

  if (!st.data.clean) throw new Error(`主目录不干净（${st.data.dirty.length} 处改动，先处理干净再合）：${st.data.dirty.slice(0, 5).join('、')}${st.data.dirty.length > 5 ? ' 等' : ''}`);

  const ctx = { script, agent, args, root, g, main };
  const max = args.max ? Number(args.max) : Infinity;
  const maxFailures = args['max-failures'] ? Number(args['max-failures']) : 3;
  let merged = [];
  let failures = 0;
  let stop = '队列空';
  let stopped = false;

  for (;;) {
    if (merged.length >= max) { stop = `到上限（--max ${args.max}）`; break; }
    if (failures >= maxFailures) { stop = `连续失败 ${failures} 次`; break; }
    if (stopping()) { stop = '收到停止请求（miworkflow stop merge）'; break; }

    // 每轮开始：主目录干净 + fetch + 主分支快进到 origin
    const now = await g('status');
    if (now.status !== 'ok') throw new Error(`看不了仓库：${now.error}`);
    if (!now.data.clean) throw new Error(`主目录不干净（${now.data.dirty.length} 处改动，先处理干净再合）：${now.data.dirty.slice(0, 5).join('、')}`);
    const f = await g('fetch');
    if (f.status !== 'ok') throw new Error(`fetch 失败：${firstLine(f.error)}`);
    const sy = await g('sync');
    if (sy.status !== 'ok') throw new Error(`主分支对不上 origin：${firstLine(sy.error)}`);
    if (sy.data?.moved) console.log(`主分支 ${sy.data.before?.slice(0, 7)} → ${sy.data.sha.slice(0, 7)}（跟上了 origin）`);

    const q = await g('queue');
    const next = (q.data?.branches ?? [])[0];
    if (!next) { stop = '队列空'; break; }

    const r = await mergeOne(next, ctx);
    if (r === 'done') { merged.push(next.id); failures = 0; continue; }
    if (r === 'push_failed') { stopped = true; stop = `推送失败（${next.branch}）：本地主分支保留，留给人处理`; break; }
    if (r === 'infra') { stopped = true; stop = `合并 Agent 没跑成（${next.branch}）：已退回队列，整轮停下，下轮重来`; break; }
    failures++;
  }

  console.log(`本轮结束：合入 ${merged.length} 个${merged.length ? `（${merged.join('、')}）` : ''}，失败 ${failures} 个；${stop}`);
  if (failures > 0) throw new Error(`本轮有 ${failures} 个工单合并失败（停止原因：${stop}）`);
  if (stopped) throw new Error(stop);
}

// 启动校验（§10.1）：MERGER 走内核的只校验用法（opts.check，不调模型）；VERIFY / ROUNDS / MERGE_FAIL_LIMIT 用 JS 查
async function checkConfig(agent) {
  const problems = [];
  if (MERGER) {
    const r = await agent('校验 Agent 配置', { check: true, agent: MERGER });
    if (r.status !== 'ok') problems.push(`MERGER：${r.reason}`);
  }
  if (!(typeof VERIFY === 'string' || Array.isArray(VERIFY))) problems.push(`VERIFY 只能是字符串或数组：${show(VERIFY)}`);
  if (!(Number.isInteger(ROUNDS) && ROUNDS >= 0)) problems.push(`ROUNDS 只能是非负整数：${show(ROUNDS)}`);
  if (!(Number.isInteger(MERGE_FAIL_LIMIT) && MERGE_FAIL_LIMIT >= 1)) problems.push(`MERGE_FAIL_LIMIT 只能是正整数：${show(MERGE_FAIL_LIMIT)}`);
  if (problems.length) throw new Error(`配置不对，不启动：\n- ${problems.join('\n- ')}`);
}

const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

// 解冲突最多交给合并 Agent 几轮（一张单只有一笔提交，正常一轮就够；剩下的是「解完又撞上」）
const CONFLICT_ROUNDS = 3;

// 一张单：rebase → 解冲突 → 验证 → 快进 → 推送 → 关单 → 删分支
// 返回 'done' | 'push_failed' | 'infra' | 'failed'
async function mergeOne(next, ctx) {
  const { script, g, root, main } = ctx;
  const { branch, id } = next;

  const v = await script('ticket_view', { id });
  if (v.status !== 'ok') throw new Error(`读工单 ${id} 失败：${firstLine(v.error)}`);
  const t = v.data;

  // 合并前的本地主分支 sha：失败时回到这里（rebase / 验证期间主分支没动，这里只是兜底）
  const before = await g('status');
  const baseMain = before.data.local || before.data.sha;
  const notes = [];
  let reply = nextReply(t);

  // 1. rebase 到主分支
  const rb = await g('rebase', { branch, main });
  if (rb.status !== 'ok') return requeue(t, branch, baseMain, `rebase 不了：${firstLine(rb.error)}`, '', ctx);

  // 2. 冲突交给合并 Agent（只解冲突，两边意图都保留）
  if (rb.data.conflict) {
    let files = rb.data.files ?? [];
    const back = await g('log', { branch, to: main });
    let resolved = false;
    for (let attempt = 1; attempt <= CONFLICT_ROUNDS && !resolved; attempt++) {
      reply = nextReply(t);
      const res = await callAgent(ctx, mergePrompt(t, root, branch, main, files, back.data?.commits ?? ''), {
        label: '合并Agent',
        ...(MERGER ? { agent: MERGER } : {}),
        inputs: { cwd: root, ticket: t.file, reply, branch, main, conflicts: files, commits: back.data?.commits ?? '', choices: ['resolved', 'give_up'] }
      });
      notes.push({ who: attempt > 1 ? `解冲突（第 ${attempt} 轮）` : '解冲突', reply, answer: res });
      if (res.infra) return requeue(t, branch, baseMain, `合并 Agent 没跑成：${res.infra}`, '', ctx, { plain: true });
      if (res.status !== 'ok' || res.choice !== 'resolved') {
        return requeue(t, branch, baseMain, `冲突解不了（${res.choice}）：${res.reason}`, reply, ctx);
      }
      const c = await g('continue');
      if (c.status !== 'ok') return requeue(t, branch, baseMain, `rebase 收尾失败：${firstLine(c.error)}`, reply, ctx);
      if (!c.data.conflict) resolved = true;
      else files = c.data.files ?? [];
    }
    if (!resolved) return requeue(t, branch, baseMain, `解了 ${CONFLICT_ROUNDS} 轮还有冲突：${files.join('、')}`, reply, ctx);
  }

  // 3. 验证：工人开工以来主分支没动过（rebase 空操作）就跳过——代码就是工人验证过的那份
  let round = 0;
  let verified = rb.data.rebased ? 'passed' : 'skipped';
  if (VERIFY && rb.data.rebased) {
    for (;;) {
      const r = await script('run_cmd', { cmd: VERIFY, cwd: root }, { timeoutMs: 1_800_000 });
      if (r.status === 'ok') break;
      if (round >= ROUNDS) {
        return requeue(t, branch, baseMain, `验证不过（已重试 ${round} 轮）：${lastLines(r.data?.tail)}`, reply, ctx);
      }
      round++;
      reply = nextReply(t);
      const fix = await callAgent(ctx, fixPrompt(t, root, VERIFY, r.data?.tail, reply), {
        label: '合并验证修正Agent',
        ...(MERGER ? { agent: MERGER } : {}),
        inputs: { cwd: root, ticket: t.file, reply, verify: VERIFY, output: r.data?.tail, choices: ['fixed', 'give_up'] }
      });
      notes.push({ who: `验证后修正（第 ${round} 轮）`, reply, answer: fix });
      if (fix.infra) return requeue(t, branch, baseMain, `合并 Agent 没跑成：${fix.infra}`, '', ctx, { plain: true });
      if (fix.status !== 'ok' || fix.choice !== 'fixed') {
        return requeue(t, branch, baseMain, `验证失败后放弃：${fix.reason}`, reply, ctx);
      }
      await g('amend');
      verified = 'passed';
    }
  }

  // 4. 快进主分支 → 推 origin（推送失败不关单、整轮停下）
  const ff = await g('ff', { branch, main });
  if (ff.status !== 'ok') return requeue(t, branch, baseMain, `主分支快进失败：${firstLine(ff.error)}`, reply, ctx);
  const sha = ff.data.sha;
  const push = await g('push', { main });
  if (push.status !== 'ok' || push.data?.pushed === false) {
    const file = await report(t, ctx, notes, {
      head: `已合到本地 ${main}（${short(sha)}），但推送失败：本地提交保留，工单保持打开，等人处理。`,
      base: baseMain, sha, verified, round
    });
    markQuietly(await script('ticket_mark', { id: t.id, action: 'unpushed', sha, commentFile: file }), t, '记录未推送');
    console.error(`✖ ${t.ref} 已合到本地 ${main}（${short(sha)}）但推送失败`);
    return 'push_failed';
  }

  // 5. 推送成功才关单，然后删掉单子分支
  const file = await report(t, ctx, notes, { head: `已合并到 ${main} 并推送（提交 ${short(sha)}）。`, base: baseMain, sha, verified, round });
  const marked = await script('ticket_mark', { id: t.id, action: 'done', sha, commentFile: file });
  if (marked.status !== 'ok') {
    // 已经推上去了，改回失败反而更糟；留着让人看（分支也不删，人还能对着看）
    console.error(`✖ ${t.ref} 已推送 ${short(sha)} 但关单失败：${firstLine(marked.error)}`);
    return 'failed';
  }
  await g('drop', { branch });
  console.log(`✔ ${t.ref} ${t.title}（${short(sha)}，${branch} 已删）`);
  return 'done';
}

// 合并失败：回到合并前 → 分支备份成 ref 后删掉 → 摘 afk-merging 发评论退回就绪队列；满 MERGE_FAIL_LIMIT 次转人工
// plain=true：合并 Agent 没跑成（基础设施故障），不计次数、不写计数标记，整轮停下，下轮重来
const MERGE_MARK = 'afk merge 失败（第';
async function requeue(t, branch, baseMain, why, reply, ctx, { plain = false } = {}) {
  const n = plain ? countMergeFails(t.file) : countMergeFails(t.file) + 1;
  const last = !plain && n >= MERGE_FAIL_LIMIT;
  const backup = `refs/afk-merge-backup/${t.id}-${plain ? `retry-${Date.now()}` : n}`;
  const back = await ctx.g('abort', { branch, main: ctx.main, sha: baseMain, backup, drop: true });
  const head = plain
    ? `合并中断：${why}`
    : `${MERGE_MARK} ${n} 次${last ? `；已满 ${MERGE_FAIL_LIMIT} 次，不再自动重做` : `（满 ${MERGE_FAIL_LIMIT} 次转人工）`}）：${why}`;
  const parts = [
    head,
    `没合进主分支：${ctx.main} 已回到合并前（${short(back.data?.sha)}），单子分支 \`${branch}\`${back.data?.backup ? `备份在 ${back.data.backup}` : '（没建成备份 ref）'}后已删掉。`,
    plain ? '下轮重新来（不计失败次数）。' : last ? '等人看过再重新入队。' : `工人在最新的主分支上重做这张单（第 ${n} 次）。`
  ];
  const draft = reply ? readDraft(reply) : '';
  if (draft) parts.push(draft);
  const file = path.join(path.dirname(t.file), plain ? 'merge-broken.md' : `merge-failed-${n}.md`);
  writeFileSync(file, `${parts.join('\n\n')}\n`);
  const r = await ctx.script('ticket_mark', { id: t.id, action: last ? 'failed' : 'requeued', commentFile: file });
  markQuietly(r, t, last ? '标记失败' : '退回队列');
  console.error(`✖ ${t.ref} ${head}`);
  return plain ? 'infra' : 'failed';
}

function countMergeFails(ticketFile) {
  let text = '';
  try { text = readFileSync(ticketFile, 'utf8'); } catch { /* 读不到当 0 次 */ }
  return text.split(MERGE_MARK).length - 1;
}

// 完成 / 未推送的评论：开头一句 + 合并 Agent 的回帖稿（没写就用它回话的 reason）+ 工作流落款
async function report(t, ctx, notes, { head, base, sha, verified, round }) {
  const st = await ctx.script('git_state', { cwd: ctx.root, baseSha: base });
  const files = st.data?.changed ?? [];
  const parts = [head];
  for (const { who, reply, answer } of notes) {
    const draft = readDraft(reply);
    const reason = String(answer?.reason ?? '').trim();
    if (draft) parts.push(`**${who}**\n${draft}`);
    else if (reason) parts.push(`**${who}**（没写回帖稿，这是它的回话）\n${reason}`);
  }
  const shown = files.slice(0, 15).map((f) => `- \`${f}\``);
  if (files.length > shown.length) shown.push(`- ……等共 ${files.length} 个`);
  parts.push([
    '---',
    `改动 ${files.length} 个文件${st.data?.stat ? `（${st.data.stat}）` : ''}：`,
    ...shown,
    '',
    `验证：${!VERIFY ? '没配验证命令，工作流没有跑编译或测试' : verified === 'skipped' ? '跳过（工人开工以来主分支没动过，代码就是工人验证过的那份）' : `\`${Array.isArray(VERIFY) ? VERIFY.join(' ') : VERIFY}\` 通过${round ? `（验证不过后修了 ${round} 轮）` : ''}`}`,
    `提交：${short(sha)}（已推送，单子分支已删）`
  ].join('\n'));
  const file = path.join(path.dirname(t.file), 'comment.md');
  writeFileSync(file, `${parts.join('\n\n')}\n`);
  return file;
}

// 回帖稿放工单快照同目录：reply-1.md、reply-2.md …（图片也放这里，相对路径引用）
const replies = new Map();
function nextReply(t) {
  const k = replies.get(t.file) ?? 0;
  replies.set(t.file, k + 1);
  return path.join(path.dirname(t.file), `reply-${k + 1}.md`);
}

function markQuietly(r, t, what) {
  if (r.status === 'ok') return;
  console.error(`  ${t.ref} ${what}没成功：${firstLine(r.error)}`);
}

function readDraft(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

// 调 Agent：区分「Agent 说不行」（原样交回）和「Agent 根本没跑完」（按 AGENT_RETRY_DELAYS 退避重试）
async function callAgent(ctx, goal, opts) {
  for (let i = 0; ; i++) {
    const r = await ctx.agent(goal, { ...opts, budget: { idleSec: AGENT_IDLE_SEC, ...opts.budget } });
    const kind = infraKind(r);
    if (!kind) return r;
    const why = firstLine(r.reason) || r.choice;
    if (kind === 'stop' || i >= AGENT_RETRY_DELAYS.length) return { ...r, infra: why };
    const wait = AGENT_RETRY_DELAYS[i];
    console.error(`  Agent 没跑完，第 ${i + 1} 次重试（等 ${Math.round(wait / 1000)} 秒）：${why}`);
    await sleep(wait);
  }
}

// 'stop'：连不上 / 没配 / 被强制结束（重试也白搭）；'retry'：崩了、什么都没吐；null：Agent 自己给的结论
function infraKind(r) {
  if (['agent_unavailable', 'agent_idle', 'agent_timeout', 'agent_bad_config'].includes(r.choice)) return 'stop';
  if (r.choice === 'agent_cli_failed') return 'retry';
  if (r.choice === 'agent_invalid_json' && !String(r.data?.stdout ?? '').trim()) return 'retry';
  return null;
}

const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean)?.split(/(?<=[。！？.!?])\s*/)[0] ?? '';
const lastLines = (text, n = 5) => String(text ?? '').split('\n').filter(Boolean).slice(-n).join(' / ');
const short = (sha) => String(sha ?? '').slice(0, 7);

// ── 提示词：解冲突在 prompts/merge.md，修验证复用 prompts/fix.md；项目补充要求 prompts/local/<名字>.md ──
const PROMPTS = {
  merge: fileURLToPath(new URL('../prompts/merge.md', import.meta.url)),
  fix: fileURLToPath(new URL('../prompts/fix.md', import.meta.url))
};

const localPrompt = (kind) => {
  let text = '';
  try { text = readFileSync(fileURLToPath(new URL(`../prompts/local/${kind}.md`, import.meta.url)), 'utf8').trim(); } catch { /* 没有就不加 */ }
  return text ? `\n项目补充要求（与上面冲突时以这里为准）：\n${text}\n` : '';
};

function render(kind, vars) {
  const all = { ...vars, local: localPrompt(kind) };
  return readFileSync(PROMPTS[kind], 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in all ? String(all[k]) : m));
}

function mergePrompt(t, root, branch, main, conflicts, commits) {
  return render('merge', {
    cwd: root,
    branch,
    main,
    conflicts: conflicts.length ? conflicts.map((f) => `- ${f}`).join('\n') : '（没有冲突文件了）',
    commits: commits || '（没有）',
    ticket: t.file
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
