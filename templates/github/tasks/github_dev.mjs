// GitHub 开发工作流：把就绪 issue 逐个「认领 → 开发 → 审查 → 验证 → 提交 → 关单」。
// 人是把 issue 贴上 ready-for-agent 标签；失败就回滚 + 贴评论 + afk-failed，等人看完摘标签重新入队。
//
// 用法：
//   miworkflow github_dev                    按队列一直跑到空
//   miworkflow github_dev --max 3            最多做 3 个
//   miworkflow github_dev --max-failures 1   连续失败 1 次就停（默认 3）
//   miworkflow github_dev --issue 42         只做 #42（不看标签和依赖，人点名就跑）
//   miworkflow github_dev --confirm          每次提交前 human 确认
//   miworkflow github_dev --dry-run          改 GitHub / git 的脚本只报会做什么
import { fileURLToPath } from 'node:url';
import { DEV, REVIEWER, VERIFY, ROUNDS, PUSH, LABELS } from '../config.mjs';

export const title = 'GitHub 开发：认领 issue → 开发 → 审查 → 验证 → 提交 → 关单';

// .workflow/ 的上一级 = 项目根
const PROJECT = fileURLToPath(new URL('../..', import.meta.url));

export default async function ({ script, agent, human, args }) {
  const max = args.max ? Number(args.max) : Infinity;
  const maxFailures = args['max-failures'] ? Number(args['max-failures']) : 3;
  const only = args.issue ? String(args.issue) : null;
  const ctx = { script, agent, human, args, labels: LABELS };

  // 开跑前工作区必须干净，免得把人的改动混进提交或被回滚掉
  const pre = await script('git_state', { cwd: PROJECT });
  if (pre.status !== 'ok') throw new Error(`看不了 git 状态：${pre.error}`);
  if (!pre.data.clean) throw new Error('工作区有未提交改动，先处理干净再跑（免得把人改的东西提交或回滚掉）');
  const root = pre.data.root || PROJECT;
  ctx.root = root;

  // --dry-run：只报「今天会做哪几个 issue」，不叫 Agent、不改 GitHub、不改 git。
  // （写脚本自己也支持 dryRun，但那挡不住 Agent 改文件，所以这里直接不进流程。）
  // --dry-run 不进 args（§5），从 env 读。
  if (process.env.AGENTFLOW_DRY_RUN === '1') {
    if (only) {
      const v = await script('gh_issue_view', { number: only });
      console.log(v.status === 'ok' ? `干跑：会做 #${only} ${v.data.title}` : `干跑：读不到 #${only}：${v.error}`);
    } else {
      const r = await script('gh_ready', { labels: LABELS });
      const list = r.status === 'ok' ? r.data.issues : [];
      console.log(list.length
        ? `干跑：就绪 ${list.length} 个：${list.map((i) => `#${i.number}(P${i.priority})`).join('、')}`
        : `干跑：队列空${r.status === 'ok' ? '' : `（列不出来：${r.error}）`}`);
    }
    console.log('干跑：不改 GitHub、不改 git、不叫 Agent');
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

    const issue = await pick(only, ctx);
    if (!issue) { stop = '队列空'; break; }

    const outcome = await runIssue(issue, ctx);
    if (outcome === 'done') { done++; failures = 0; }
    else if (outcome === 'push_failed') {
      pushStopped = true;
      stop = `推送失败（issue #${issue.number}）：本地提交保留，留给人处理`;
      break;
    } else { failures++; }
  }

  console.log(`本轮结束：完成 ${done} 个，失败 ${failures} 个；${stop}`);
  if (failures > 0) throw new Error(`本轮有 ${failures} 个 issue 失败（停止原因：${stop}）`);
  if (pushStopped) throw new Error(stop);
}

// 挑下一个要做的 issue：--issue 直接读那个；否则列就绪队列取第一个
async function pick(only, ctx) {
  const { script } = ctx;
  if (only) {
    const v = await script('gh_issue_view', { number: only });
    if (v.status !== 'ok') throw new Error(`读 issue #${only} 失败：${v.error}`);
    return v.data;
  }
  const r = await script('gh_ready', { labels: ctx.labels });
  if (r.status !== 'ok') throw new Error(`列就绪 issue 失败：${r.error}`);
  if (!r.data.issues.length) return null;
  const v = await script('gh_issue_view', { number: r.data.issues[0].number });
  if (v.status !== 'ok') throw new Error(`读 issue #${r.data.issues[0].number} 失败：${v.error}`);
  return v.data;
}

// 一个 issue 走完全程；返回 'done' | 'failed' | 'push_failed'
async function runIssue(issue, ctx) {
  const { script, agent, human, args, root } = ctx;
  const num = issue.number;

  if ((await script('gh_issue_mark', { number: num, action: 'claimed', labels: ctx.labels })).status !== 'ok') {
    console.error(`#${num} 认领失败`);
    return 'failed';
  }

  const base = (await script('git_state', { cwd: root })).data.sha;

  // 1. 开发
  const dev = await agent(devPrompt(issue, root), {
    ...(DEV ? { agent: DEV } : {}),
    inputs: { cwd: root, issue: issue.text, choices: ['done', 'no_change'] }
  });
  if (dev.status === 'need_human') return fail(num, `Agent 提问：${dev.reason}`, base, ctx);
  if (dev.status !== 'ok' || !['done', 'no_change'].includes(dev.choice)) {
    return fail(num, `开发失败（${dev.choice}）：${dev.reason}`, base, ctx);
  }
  if (dev.choice === 'no_change') return fail(num, `Agent 判断无需改动：${dev.reason}`, base, ctx);

  // 2. 信 git，不信 Agent 自报
  const st = await script('git_state', { cwd: root, baseSha: base });
  if (st.status !== 'ok') return fail(num, `看不了改动：${st.error}`, base, ctx);
  const changed = st.data.changed;
  if (!changed.length) return fail(num, `Agent 报完成，但 git 看不到改动：${dev.reason}`, base, ctx);

  // 3. 审查（有问题直接改）
  const rev = await agent(reviewPrompt(issue, root, changed), {
    ...(REVIEWER ? { agent: REVIEWER } : {}),
    inputs: { cwd: root, issue: issue.text, changed, choices: ['clean', 'refined', 'reject'] }
  });
  if (rev.status === 'need_human') return fail(num, `审查者提问：${rev.reason}`, base, ctx);
  if (rev.status !== 'ok' || !['clean', 'refined'].includes(rev.choice)) {
    return fail(num, `审查未通过（${rev.choice}）：${rev.reason}`, base, ctx);
  }

  // 4. 验证（配了才跑）；不过就把输出交回 DEV 再改，最多 ROUNDS 轮
  if (VERIFY) {
    let round = 0;
    for (;;) {
      const v = await script('run_cmd', { cmd: VERIFY, cwd: root }, { timeoutMs: 1_800_000 });
      if (v.status === 'ok') break;
      if (round >= ROUNDS) {
        return fail(num, `验证不过（已重试 ${round} 轮）：${lastLines(v.data?.tail)}`, base, ctx);
      }
      round++;
      const fix = await agent(fixPrompt(issue, root, VERIFY, v.data?.tail), {
        ...(DEV ? { agent: DEV } : {}),
        inputs: { cwd: root, issue: issue.text, verify: VERIFY, output: v.data?.tail, choices: ['fixed', 'give_up'] }
      });
      if (fix.status !== 'ok' || fix.choice !== 'fixed') {
        return fail(num, `验证失败后放弃：${fix.reason}`, base, ctx);
      }
    }
  }

  // 5. 带 --confirm 才找人点头；不带就无人值守
  if (args.confirm) {
    const h = await human(`#${num} 改动就绪，提交并关单？`);
    if (h.status !== 'ok') return fail(num, '人工拒绝提交', base, ctx);
  }

  // 6. 提交 + 推送
  const c = await script('git_commit', {
    message: `#${num} ${issue.title}`,
    body: `Closes #${num}`,
    push: PUSH,
    cwd: root
  });
  if (c.status !== 'ok') {
    // 推送失败：本地提交保留，不关单、整轮停下
    if (c.data?.committed) return 'push_failed';
    return fail(num, `提交失败：${c.error}`, base, ctx);
  }

  // 7. 关单
  const marked = await script('gh_issue_mark', { number: num, action: 'done', sha: c.data.sha, labels: ctx.labels });
  if (marked.status !== 'ok') {
    // 已经提交推送出去了，回滚反而更糟；留着让人看
    console.error(`#${num} 已提交但关单失败：${marked.error}`);
    return 'failed';
  }

  console.log(`✔ #${num} ${issue.title}（${c.data.sha.slice(0, 7)}）`);
  return 'done';
}

// 任何一步失败：回滚到起点，摘 in-progress、贴 afk-failed + 评论原因，保留 ready-for-agent
async function fail(num, reason, base, ctx) {
  const { script } = ctx;
  console.error(`✖ #${num} ${reason}`);
  if (base) await script('git_restore', { sha: base, cwd: ctx.root });
  await script('gh_issue_mark', { number: num, action: 'failed', comment: reason, labels: ctx.labels });
  return 'failed';
}

const lastLines = (text, n = 5) => String(text ?? '').split('\n').filter(Boolean).slice(-n).join(' / ');

// ── 提示词（DEV / REVIEWER 各一段，写法参考 exec-review，不引用）────────────────
function devPrompt(issue, root) {
  return [
    '你在为一个 GitHub issue 开发代码。',
    '',
    `工作目录：${root}`,
    '',
    'issue：',
    issue.text,
    '',
    '要求：',
    '- 直接改工作目录里的代码，把 issue 做出来；改完自己检查一遍，别留半成品',
    '- issue 不需要任何改动（已经满足，或信息不足无法判断）时，choice 用 no_change，reason 说明原因',
    '- 需要人补充信息才能继续时，status 用 need_human，reason 写你要问的问题',
    '',
    '最后只回一段 JSON：{status, choice, reason, data}；status 只能是 ok | need_human | failed；choice 只能是 done | no_change'
  ].join('\n');
}

function reviewPrompt(issue, root, changed) {
  return [
    '你是代码审查者。刚有人为下面的 issue 改了代码，请审查并直接修正问题（你有全部权限）。',
    '',
    `工作目录：${root}`,
    '改动的文件：',
    ...changed.map((f) => `- ${f}`),
    '',
    'issue：',
    issue.text,
    '',
    '看实际改动（git diff 等），审查：是否正确、是否真的解决了 issue、有没有引入问题。有问题就直接改。',
    '- 审查后你认为干净：choice=clean',
    '- 你做了修改或补充：choice=refined',
    '- 方向根本错了、应当放弃：choice=reject，并说明',
    '',
    '最后只回一段 JSON：{status, choice, reason, data}；choice 只能是 clean | refined | reject'
  ].join('\n');
}

function fixPrompt(issue, root, verify, output) {
  return [
    '你之前为下面的 issue 做的改动没通过验证，请修到通过为止。',
    '',
    `工作目录：${root}`,
    `验证命令：${Array.isArray(verify) ? verify.join(' ') : verify}`,
    '输出（末尾）：',
    String(output ?? '').split('\n').slice(-60).join('\n'),
    '',
    'issue：',
    issue.text,
    '',
    '直接改代码。修好了 choice=fixed；判断做不到 choice=give_up 并说明原因。',
    '',
    '最后只回一段 JSON：{status, choice, reason, data}；choice 只能是 fixed | give_up'
  ].join('\n');
}
