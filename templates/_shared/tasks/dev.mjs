// 开发工作流：把就绪工单逐个「认领 → 开发 → 审查 → 验证 → 提交 → 关单」。
// 只通过工单源接口 ticket_ready / ticket_view / ticket_mark 碰工单系统，不知道背后是哪家（入队、标记的规则见各工单源的脚本）。
// 失败就回滚 + 贴评论 + 标记失败，等人看完再重新入队。
// Agent 根本没跑完（基础设施故障）不算工单失败：退避重试，还不行就回滚、释放工单（不贴失败）、整轮停下，下轮重做。
//
// 用法：
//   miworkflow dev                    按队列一直跑到空
//   miworkflow dev --max 3            最多做 3 个
//   miworkflow dev --max-failures 1   连续失败 1 次就停（默认 3）
//   miworkflow dev --issue 42         只做工单 42（不看入队和依赖，人点名就跑）
//   miworkflow dev --confirm          每次提交（+ 推送 + 标记完成）前 human 确认
//   miworkflow dev --dry-run          只报会做哪些工单、哪些被挡住，不改工单、不改 git
//
// 提交权在工作流：Agent 只改代码、在回话 data 里给 type / summary，审查、验证（和 --confirm）之后由这里统一提交，
// 一张工单一笔，提交信息按工单源的 commitMessage 拼（Agent 自己提交了会被 git_commit 压成这一笔）。
// 工单评论：每次调 Agent 都要它写回帖稿；完成 / 未推送时把各份回帖稿（没写就用它回话里的 reason）
// 拼起来，再由工作流补一段落款（改了哪些文件、审查、验证、提交号），整段交给 ticket_mark。
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DEV, REVIEWER, VERIFY, ROUNDS, PUSH, AGENT_RETRY_DELAYS } from '../config.mjs';
import * as source from '../source.mjs';

export const title = '开发：认领工单 → 开发 → 审查 → 验证 → 提交 → 关单';

// .workflow/ 的上一级 = 项目根
const PROJECT = fileURLToPath(new URL('../..', import.meta.url));

export default async function ({ script: rawScript, agent, human, args }) {
  // 工单脚本内部对工单系统故障退避重试（一次 ticket_mark 可能多条命令各自等），缺省 120 秒不够
  const script = (name, input, opts) =>
    rawScript(name, input, name.startsWith('ticket_') ? { timeoutMs: 900_000, ...opts } : opts);
  const max = args.max ? Number(args.max) : Infinity;
  const maxFailures = args['max-failures'] ? Number(args['max-failures']) : 3;
  const only = args.issue ? String(args.issue) : null;
  const ctx = { script, agent, human, args };

  // 开跑前工作区必须干净，免得把人的改动混进提交或被回滚掉
  const pre = await script('git_state', { cwd: PROJECT });
  if (pre.status !== 'ok') throw new Error(`看不了 git 状态：${pre.error}`);
  if (!pre.data.clean) throw new Error('工作区有未提交改动，先处理干净再跑（免得把人改的东西提交或回滚掉）');
  const root = pre.data.root || PROJECT;
  ctx.root = root;

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

  let done = 0;
  let failures = 0;
  let pushStopped = false;
  let infraStopped = false;
  let stop = '队列空';

  for (;;) {
    if (done >= max) { stop = `到上限（--max ${args.max}）`; break; }
    if (failures >= maxFailures) { stop = `连续失败 ${failures} 次`; break; }
    if (only && done + failures > 0) break;

    const t = await pick(only, ctx);
    if (t?.down) { infraStopped = true; stop = t.down; break; }
    if (!t) { stop = '队列空'; break; }

    const outcome = await runTicket(t, ctx);
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
    } else { failures++; }
  }

  console.log(`本轮结束：完成 ${done} 个，失败 ${failures} 个；${stop}`);
  if (failures > 0) throw new Error(`本轮有 ${failures} 个工单失败（停止原因：${stop}）`);
  if (pushStopped || infraStopped) throw new Error(stop);
}

// 挑下一张要做的工单：--issue 直接读那张；否则列就绪队列取第一张。
// 工单系统暂时不可用（出参 data.transient）时交回 { down: 停止原因 }，由主循环停下
async function pick(only, ctx) {
  const { script } = ctx;
  let id = only;
  if (id === null) {
    const r = await script('ticket_ready', {});
    if (r.status !== 'ok') {
      if (transient(r)) return { down: `工单系统暂时不可用（列就绪工单）：${firstLine(r.error)}` };
      throw new Error(`列就绪工单失败：${r.error}`);
    }
    id = r.data.ready[0]?.id ?? null;
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

// 一张工单走完全程；返回 'done' | 'failed' | 'push_failed' | 'unpushed' | 'infra_failed' | 'ticket_down'（停止原因在 ctx.down）
async function runTicket(t, ctx) {
  const { script, human, args, root } = ctx;

  const claim = await script('ticket_mark', { id: t.id, action: 'claimed' });
  if (claim.status !== 'ok') {
    console.error(`${t.ref} 认领失败：${claim.error}`);
    if (transient(claim)) {
      ctx.down = `工单系统暂时不可用（认领 ${t.ref}）：下轮重做`;
      return 'ticket_down';
    }
    return 'failed';
  }

  const base = (await script('git_state', { cwd: root })).data.sha;
  // 每次调 Agent 的回帖稿与回话，完成时拼进评论
  const notes = [];

  // 1. 开发（每次调 Agent 都分配一份新的回帖稿；失败时它写了就跟着评论发回工单）
  let reply = nextReply(t);
  // 重试前回到本轮起点，免得在半成品上续写；那时备份掉的提交也要写进释放评论
  let saved = '';
  const dev = await callAgent(ctx, devPrompt(t, root, reply), {
    ...(DEV ? { agent: DEV } : {}),
    inputs: { cwd: root, ticket: t.file, reply, choices: ['done', 'no_change'] }
  }, async () => { saved += await rollback(base, ctx); });
  notes.push({ who: '开发', reply, answer: dev });
  if (dev.infra) return release(t, dev.infra, base, ctx, saved);
  if (dev.status === 'need_human') return fail(t, `Agent 提问：${dev.reason}`, base, ctx, reply);
  if (dev.status !== 'ok' || !['done', 'no_change'].includes(dev.choice)) {
    return fail(t, `开发失败（${dev.choice}）：${dev.reason}`, base, ctx, reply);
  }
  if (dev.choice === 'no_change') return fail(t, `Agent 判断无需改动：${dev.reason}`, base, ctx, reply);

  // 2. 信 git，不信 Agent 自报
  const st = await script('git_state', { cwd: root, baseSha: base });
  if (st.status !== 'ok') return fail(t, `看不了改动：${st.error}`, base, ctx);
  const changed = st.data.changed;
  if (!changed.length) return fail(t, `Agent 报完成，但 git 看不到改动：${dev.reason}`, base, ctx, reply);

  // 3. 审查（有问题直接改）
  reply = nextReply(t);
  const rev = await callAgent(ctx, reviewPrompt(t, root, changed, reply), {
    ...(REVIEWER ? { agent: REVIEWER } : {}),
    inputs: { cwd: root, ticket: t.file, reply, changed, choices: ['clean', 'refined', 'reject'] }
  });
  notes.push({ who: '审查', reply, answer: rev });
  if (rev.infra) return release(t, rev.infra, base, ctx, saved);
  if (rev.status === 'need_human') return fail(t, `审查者提问：${rev.reason}`, base, ctx, reply);
  if (rev.status !== 'ok' || !['clean', 'refined'].includes(rev.choice)) {
    return fail(t, `审查未通过（${rev.choice}）：${rev.reason}`, base, ctx, reply);
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
        ...(DEV ? { agent: DEV } : {}),
        inputs: { cwd: root, ticket: t.file, reply, verify: VERIFY, output: v.data?.tail, choices: ['fixed', 'give_up'] }
      });
      notes.push({ who: '验证后修正', reply, answer: fix });
      if (fix.infra) return release(t, fix.infra, base, ctx, saved);
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

  // 6. 提交 + 推送：一张工单一笔（Agent 自己做的提交压进来），提交信息按工单源格式拼
  const msg = source.commitMessage(t, commitInfo(t, notes));
  const c = await script('git_commit', {
    message: msg.message,
    ...(msg.body ? { body: msg.body } : {}),
    baseSha: base,
    push: PUSH,
    cwd: root
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
// saved：重试时已经回滚备份过的提交备注
async function release(t, reason, base, ctx, saved = '') {
  console.error(`✖ ${t.ref} Agent 连接失败：${reason}`);
  const note = saved + await rollback(base, ctx);
  markQuietly(await ctx.script('ticket_mark', { id: t.id, action: 'released', comment: `Agent 连接失败，已回滚并释放，下轮重做：${reason}${note}` }), t, '释放');
  return 'infra_failed';
}

// 回滚到起点；丢掉的提交已由 git_restore 备份成 ref，返回写进评论的那句备注（没丢提交就是空串）
async function rollback(base, ctx) {
  if (!base) return '';
  const r = await ctx.script('git_restore', { sha: base, cwd: ctx.root });
  if (!r.data?.lost?.length) return '';
  console.error(`  回滚掉的提交备份在 ${r.data.backup}`);
  return `\n（回滚掉的 ${r.data.lost.length} 笔提交备份在 ${r.data.backup}：${r.data.lost.map((l) => l.split(' ')[0]).join(' ')}）`;
}

// 调 Agent：区分「Agent 说不行」（原样交回，照旧走 fail）和「Agent 根本没跑完」（基础设施故障）。
// 后者按 AGENT_RETRY_DELAYS 退避重试同一步（beforeRetry 给开发用来先回到起点）；
// 用完或不该重试就交回 { ...结果, infra: 原因首句 }，由调用方 release。
async function callAgent(ctx, goal, opts, beforeRetry) {
  for (let i = 0; ; i++) {
    const r = await ctx.agent(goal, opts);
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

// 'retry'：连不上 / 崩了 / 被杀了什么都没吐；'stop'：没配 Agent、超时（重试也白搭）；null：Agent 自己给的结论
const TIMEOUT_RE = /超时（\d+ 秒）/;
function infraKind(r) {
  if (r.choice === 'agent_unavailable') return 'stop';
  if (r.choice === 'agent_cli_failed') return TIMEOUT_RE.test(String(r.reason ?? '')) ? 'stop' : 'retry';
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
async function report(t, ctx, notes, { head, base, sha, subject, round, pushed = false }) {
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
  const shown = files.slice(0, 15).map((f) => `- \`${f}\``);
  if (files.length > shown.length) shown.push(`- ……等共 ${files.length} 个`);
  parts.push([
    '---',
    `改动 ${files.length} 个文件${st.data?.stat ? `（${st.data.stat}）` : ''}：`,
    ...shown,
    '',
    `审查：${review === 'refined' ? '审查者做了修正' : '审查者看过，没有改动'}`,
    `验证：${VERIFY ? `\`${Array.isArray(VERIFY) ? VERIFY.join(' ') : VERIFY}\` 通过${round ? `（验证不过后修了 ${round} 轮）` : ''}` : '没配验证命令，工作流没有跑编译或测试'}`,
    `提交：${short(sha)} ${subject}（${pushed ? '已推送' : '未推送'}）`
  ].join('\n'));
  const file = path.join(path.dirname(t.file), 'comment.md');
  writeFileSync(file, `${parts.join('\n\n')}\n`);
  return file;
}

function readDraft(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
}

// ── 提示词：正文在 prompts/dev|review|fix.md，{{名字}} 占位 ──
const PROMPTS = {
  dev: fileURLToPath(new URL('../prompts/dev.md', import.meta.url)),
  review: fileURLToPath(new URL('../prompts/review.md', import.meta.url)),
  fix: fileURLToPath(new URL('../prompts/fix.md', import.meta.url))
};

// 项目自己的补充要求：prompts/local/<dev|review|fix>.md，各接到对应提示词的 {{local}} 处；不在模板里，init --upgrade 不碰
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
