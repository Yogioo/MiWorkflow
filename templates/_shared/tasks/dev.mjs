// 开发工作流：把就绪工单逐个「认领 → 开发 → 审查 → 验证 → 提交 → 关单」。
// 只通过工单源接口 ticket_ready / ticket_view / ticket_mark 碰工单系统，不知道背后是哪家（入队、标记的规则见各工单源的脚本）。
// 失败就回滚 + 贴评论 + 标记失败，等人看完再重新入队。
//
// 用法：
//   miworkflow dev                    按队列一直跑到空
//   miworkflow dev --max 3            最多做 3 个
//   miworkflow dev --max-failures 1   连续失败 1 次就停（默认 3）
//   miworkflow dev --issue 42         只做工单 42（不看入队和依赖，人点名就跑）
//   miworkflow dev --confirm          每次发布（推送 + 关单）前 human 确认
//   miworkflow dev --dry-run          只报会做哪些工单、哪些被挡住，不改工单、不改 git
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV, REVIEWER, VERIFY, ROUNDS, PUSH } from '../config.mjs';
import { commitMessage } from '../source.mjs';

export const title = '开发：认领工单 → 开发 → 审查 → 验证 → 提交 → 关单';

// .workflow/ 的上一级 = 项目根
const PROJECT = fileURLToPath(new URL('../..', import.meta.url));

export default async function ({ script, agent, human, args }) {
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
  let stop = '队列空';

  for (;;) {
    if (done >= max) { stop = `到上限（--max ${args.max}）`; break; }
    if (failures >= maxFailures) { stop = `连续失败 ${failures} 次`; break; }
    if (only && done + failures > 0) break;

    const t = await pick(only, ctx);
    if (!t) { stop = '队列空'; break; }

    const outcome = await runTicket(t, ctx);
    if (outcome === 'done') { done++; failures = 0; }
    else if (outcome === 'push_failed') {
      pushStopped = true;
      stop = `推送失败（工单 ${t.ref}）：本地提交保留，留给人处理`;
      break;
    } else if (outcome === 'unpushed') {
      pushStopped = true;
      stop = `未推送（PUSH=false，工单 ${t.ref}）：本地提交保留，留给人处理`;
      break;
    } else { failures++; }
  }

  console.log(`本轮结束：完成 ${done} 个，失败 ${failures} 个；${stop}`);
  if (failures > 0) throw new Error(`本轮有 ${failures} 个工单失败（停止原因：${stop}）`);
  if (pushStopped) throw new Error(stop);
}

// 挑下一张要做的工单：--issue 直接读那张；否则列就绪队列取第一张
async function pick(only, ctx) {
  const { script } = ctx;
  const id = only ?? await (async () => {
    const r = await script('ticket_ready', {});
    if (r.status !== 'ok') throw new Error(`列就绪工单失败：${r.error}`);
    return r.data.ready[0]?.id ?? null;
  })();
  if (id === null) return null;
  const v = await script('ticket_view', { id });
  if (v.status !== 'ok') throw new Error(`读工单 ${id} 失败：${v.error}`);
  return v.data;
}

// 一张工单走完全程；返回 'done' | 'failed' | 'push_failed' | 'unpushed'
async function runTicket(t, ctx) {
  const { script, agent, human, args, root } = ctx;

  if ((await script('ticket_mark', { id: t.id, action: 'claimed' })).status !== 'ok') {
    console.error(`${t.ref} 认领失败`);
    return 'failed';
  }

  const base = (await script('git_state', { cwd: root })).data.sha;

  // 1. 开发（每次调 Agent 都分配一份新的回帖稿；失败时它写了就跟着评论发回工单）
  let reply = nextReply(t);
  const dev = await agent(devPrompt(t, root, reply), {
    ...(DEV ? { agent: DEV } : {}),
    inputs: { cwd: root, ticket: t.file, reply, choices: ['done', 'no_change'] }
  });
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
  const rev = await agent(reviewPrompt(t, root, changed, reply), {
    ...(REVIEWER ? { agent: REVIEWER } : {}),
    inputs: { cwd: root, ticket: t.file, reply, changed, choices: ['clean', 'refined', 'reject'] }
  });
  if (rev.status === 'need_human') return fail(t, `审查者提问：${rev.reason}`, base, ctx, reply);
  if (rev.status !== 'ok' || !['clean', 'refined'].includes(rev.choice)) {
    return fail(t, `审查未通过（${rev.choice}）：${rev.reason}`, base, ctx, reply);
  }

  // 4. 验证（配了才跑）；不过就把输出交回 DEV 再改，最多 ROUNDS 轮
  if (VERIFY) {
    let round = 0;
    for (;;) {
      const v = await script('run_cmd', { cmd: VERIFY, cwd: root }, { timeoutMs: 1_800_000 });
      if (v.status === 'ok') break;
      if (round >= ROUNDS) {
        return fail(t, `验证不过（已重试 ${round} 轮）：${lastLines(v.data?.tail)}`, base, ctx);
      }
      round++;
      reply = nextReply(t);
      const fix = await agent(fixPrompt(t, root, VERIFY, v.data?.tail, reply), {
        ...(DEV ? { agent: DEV } : {}),
        inputs: { cwd: root, ticket: t.file, reply, verify: VERIFY, output: v.data?.tail, choices: ['fixed', 'give_up'] }
      });
      if (fix.status !== 'ok' || fix.choice !== 'fixed') {
        return fail(t, `验证失败后放弃：${fix.reason}`, base, ctx, reply);
      }
    }
  }

  // 5. 带 --confirm 才找人点头；不带就无人值守。
  // 注意：提交是本地的（Agent 已经提交过，或下面会补），这道门卡的是「发布」——推送 + 关单。
  if (args.confirm) {
    const h = await human(`${t.ref} 改动就绪（提交已在本地），推送并关单？`);
    if (h.status !== 'ok') return fail(t, '人工拒绝提交', base, ctx);
  }

  // 6. 提交 + 推送：Agent 一般已经自己提交了（提示词要求的），这里兜底；已提交就用当前 HEAD 走推送。
  const msg = commitMessage(t, 'dev');
  const c = await script('git_commit', {
    message: msg.message,
    ...(msg.body ? { body: msg.body } : {}),
    push: PUSH,
    cwd: root
  });
  if (c.status !== 'ok') {
    // 推送失败：本地提交保留，不关单、保留 afk-claimed、整轮停下
    if (c.data?.committed) return notPublished('push_failed', t, c.data.sha, ctx);
    return fail(t, `提交失败：${c.error}`, base, ctx);
  }

  // 提交成功但没推送（PUSH=false）：跟推送失败同款语义——没发布就不算做完
  if (c.data.pushed === false) return notPublished('unpushed', t, c.data.sha, ctx);

  // 7. 关单
  const marked = await script('ticket_mark', { id: t.id, action: 'done', sha: c.data.sha });
  if (marked.status !== 'ok') {
    // 已经提交推送出去了，回滚反而更糟；留着让人看
    console.error(`${t.ref} 已提交但关单失败：${marked.error}`);
    return 'failed';
  }

  console.log(`✔ ${t.ref} ${t.title}（${c.data.sha.slice(0, 7)}）`);
  return 'done';
}

// 提交成功但没发布（PUSH=false 或推送失败）：评论注明未推送、保留 afk-claimed、不关单，整轮停下留给人处理
async function notPublished(outcome, t, sha, ctx) {
  await ctx.script('ticket_mark', { id: t.id, action: 'unpushed', sha });
  console.error(`✖ ${t.ref} 本地提交（未推送）：${String(sha ?? '').slice(0, 7)}，工单保持打开`);
  return outcome;
}

// 任何一步失败：回滚到起点，ticket_mark failed 并附原因（怎么落到工单上由工单源决定）
// 回滚如果要丢掉提交，git_restore 会先备份成 ref——把那个 ref 写进评论，人才能捞回来（TODO B7）
// reply：刚结束那次 Agent 调用的回帖稿路径（写没写由 ticket_mark 看）
async function fail(t, reason, base, ctx, reply) {
  const { script } = ctx;
  console.error(`✖ ${t.ref} ${reason}`);
  let note = '';
  if (base) {
    const r = await script('git_restore', { sha: base, cwd: ctx.root });
    if (r.data?.lost?.length) {
      note = `\n（回滚掉的 ${r.data.lost.length} 笔提交备份在 ${r.data.backup}：${r.data.lost.map((l) => l.split(' ')[0]).join(' ')}）`;
      console.error(`  回滚掉的提交备份在 ${r.data.backup}`);
    }
  }
  await script('ticket_mark', { id: t.id, action: 'failed', comment: `${reason}${note}`, ...(reply ? { commentFile: reply } : {}) });
  return 'failed';
}

// 回帖稿放工单快照同目录：reply-1.md、reply-2.md …（图片也放这里，相对路径引用）
const replies = new Map();
function nextReply(t) {
  const k = replies.get(t.file) ?? 0;
  replies.set(t.file, k + 1);
  return path.join(path.dirname(t.file), `reply-${k + 1}.md`);
}

const lastLines = (text, n = 5) => String(text ?? '').split('\n').filter(Boolean).slice(-n).join(' / ');

// ── 提示词：正文在 prompts/dev|review|fix.md，{{名字}} 占位；提交信息由工单源的 commitMessage 给 ──
const PROMPTS = {
  dev: fileURLToPath(new URL('../prompts/dev.md', import.meta.url)),
  review: fileURLToPath(new URL('../prompts/review.md', import.meta.url)),
  fix: fileURLToPath(new URL('../prompts/fix.md', import.meta.url))
};

// 一趟替换：填进去的值（快照路径、验证输出）里就算有 {{…}} 也不会再被替换
function render(kind, vars) {
  return readFileSync(PROMPTS[kind], 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function commitText(t, kind) {
  const c = commitMessage(t, kind);
  return c.body ? `\`${c.message}\`，正文写一行 \`${c.body}\`` : `\`${c.message}\``;
}

function devPrompt(t, root, reply) {
  return render('dev', { cwd: root, ticket: t.file, reply, commit: commitText(t, 'dev') });
}

function reviewPrompt(t, root, changed, reply) {
  return render('review', {
    cwd: root,
    reply,
    changed: changed.map((f) => `- ${f}`).join('\n'),
    ticket: t.file,
    commit: commitText(t, 'review')
  });
}

function fixPrompt(t, root, verify, output, reply) {
  return render('fix', {
    cwd: root,
    reply,
    verify: Array.isArray(verify) ? verify.join(' ') : verify,
    output: String(output ?? '').split('\n').slice(-60).join('\n'),
    ticket: t.file,
    commit: commitText(t, 'fix')
  });
}
