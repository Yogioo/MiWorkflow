// GitHub 讨论单：人给 issue 贴 agent-discuss，AI 就在评论区按 prompts/grilling.md 逐轮追问；人回复后下一次运行接着问。
// GitHub 评论串是唯一事实来源，会话只是缓存；讨论期间 Agent 对仓库只读。
// 会话号记在 AI 评论的标记里（cli=、session=，适配器交回了才记），不存本地文件：
// 同一 CLI 能续上就只喂 AI 上次发言之后的新评论与正文变化；标记里没有会话号就重放完整正文 + 全部评论；
// 续会话返回 session_not_found（换机器、会话丢失、cursor 等）就改为重放。
// pi 的会话号由「仓库 + issue 号」算出，首轮就建出可续的会话。
//
// 轮到 AI 的判据：人的内容（正文 + 不带 AI 标记的评论）的哈希 ≠ 最近一条 AI 标记里记下的哈希。
// AI 评论的标记记的是该轮「开始时」读到的哈希，所以 AI 思考期间人补发的评论，下一次运行会被处理。
// 一轮失败也发一条带标记的评论（写明原因），哈希不变就不自动重试；人回复任意内容即重试。
//
// 用法：
//   miworkflow github_discuss            逐张处理轮到 AI 的讨论单
//   miworkflow github_discuss --max 3    最多处理 3 张
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DISCUSS } from '../config.mjs';

export const title = 'GitHub 讨论单：agent-discuss → 评论区逐轮追问';

const PROJECT = fileURLToPath(new URL('../..', import.meta.url));
const PROMPT = fileURLToPath(new URL('../prompts/grilling.md', import.meta.url));
const ENTER = 'agent-discuss';
const GRILLING = 'discuss:grilling';
// 标记必须在评论末尾：人引用 AI 评论时标记落在中间，不能把人的评论当成 AI 的。
const MARK = /<!--\s*miworkflow:discuss\s+hash=([0-9a-f]+)((?:\s+\w+=\S+?)*)\s*-->\s*$/;

export default async function ({ script, agent, args }) {
  const max = args.max === undefined ? Infinity : Number(args.max);
  if (max !== Infinity && !(Number.isInteger(max) && max >= 1)) throw new Error(`--max 要正整数：${args.max}`);
  const r = await script('gh_discuss_list', { enter: ENTER, grilling: GRILLING });
  if (r.status !== 'ok') throw new Error(`列讨论单失败：${r.error}`);

  let handled = 0;
  for (const item of r.data.issues) {
    if (handled >= max) break;
    const v = await script('gh_issue_view', { number: item.number });
    if (v.status !== 'ok') { console.error(`✖ 读 #${item.number} 失败：${v.error}`); continue; }
    const issue = v.data;
    const hash = humanHash(issue);
    const last = lastMark(issue);
    if (hash === last?.hash) continue;

    handled++;
    if (!issue.labels.some((l) => l.toLowerCase() === GRILLING)) {
      await script('gh_discuss_post', { number: issue.number, addLabel: GRILLING });
    }
    const out = await askRound(issue, last, agent);
    const mark = marker(hash, out.cli, out.session, bodyHash(issue));
    const body = out.ok
      ? `${out.comment}\n\n${mark}`
      : `这一轮追问失败：${out.reason}\n\n回复任意内容重试。\n\n${mark}`;
    const p = await script('gh_discuss_post', { number: issue.number, body });
    if (p.status !== 'ok') console.error(`✖ #${issue.number} 发评论失败：${p.error}`);
    else console.log(`${out.ok ? '✔' : '✖'} #${issue.number} ${out.ok ? '已追问' : `失败：${out.reason}`}`);
  }
  console.log(`本轮结束：处理 ${handled} 张讨论单`);
}

async function askRound(issue, last, agent) {
  const cli = agentCli();
  const own = cli === 'pi' ? piSession(issue.number) : undefined;
  const prev = last?.session && last.cli === cli && (!own || last.session === own) ? last.session : undefined;
  let res;
  try {
    if (prev) {
      res = await callAgent(agent, issue, deltaPrompt(issue, last), prev);
      if (res.choice === 'session_not_found') {
        res = await callAgent(agent, issue, `续不上，改为重放（${res.reason || prev}）\n\n${prompt(issue)}`, own);
      }
    } else {
      res = await callAgent(agent, issue, prompt(issue), own);
    }
  } catch (err) {
    return { ok: false, cli, reason: String(err?.message ?? err).split('\n')[0] };
  }
  const session = typeof res.session === 'string' && res.session ? res.session : undefined;
  if (res.status !== 'ok') return { ok: false, cli, session, reason: `${res.status}：${res.reason || res.error || '无说明'}` };
  const comment = typeof res.data?.comment === 'string' ? res.data.comment.trim() : '';
  if (res.choice !== 'ask' || !comment) return { ok: false, cli, session, reason: '输出不合契约（要 choice=ask 且 data.comment 非空）' };
  return { ok: true, cli, session, comment };
}

// 会话号是适配器参数（Core §10）；自定义命令（AGENTFLOW_AGENT_CMD）没有适配器参数，只能放进 inputs。
function callAgent(agent, issue, goal, session) {
  const spec = agentSpec();
  const inputs = { cwd: PROJECT, number: issue.number, issue: issue.text, choices: ['ask'] };
  if (spec) return agent(goal, { agent: session ? { ...spec, session } : spec, inputs });
  return agent(goal, { inputs: session ? { ...inputs, session } : inputs });
}

function agentSpec() {
  const spec = DISCUSS ?? (process.env.AGENTFLOW_AGENT_CMD ? null : process.env.AGENTFLOW_AGENT);
  if (!spec) return null;
  return typeof spec === 'string' ? { cli: spec } : spec;
}

const agentCli = () => String(agentSpec()?.cli ?? 'cmd');

const piSession = (number) => `discuss-${createHash('sha256').update(`${PROJECT}#${number}`).digest('hex').slice(0, 16)}`;

const isAi = (c) => MARK.test(c.body ?? '');

function humanHash(issue) {
  const human = [issue.body ?? '', ...issue.comments.filter((c) => !isAi(c)).map((c) => `${c.author}\n${c.body}`)];
  return createHash('sha256').update(JSON.stringify(human)).digest('hex').slice(0, 16);
}

function lastMark(issue) {
  const ai = issue.comments.filter(isAi);
  if (!ai.length) return null;
  const m = MARK.exec(ai[ai.length - 1].body);
  const fields = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
  return { hash: m[1], ...fields };
}

const bodyHash = (issue) => createHash('sha256').update(issue.body ?? '').digest('hex').slice(0, 16);

const marker = (hash, cli, session, body) => session
  ? `<!-- miworkflow:discuss hash=${hash} cli=${cli} session=${session} body=${body} -->`
  : `<!-- miworkflow:discuss hash=${hash} -->`;

// 续会话只喂 AI 上次发言之后的新评论与正文变化。
function deltaPrompt(issue, last) {
  const lastAi = issue.comments.map(isAi).lastIndexOf(true);
  const fresh = issue.comments.slice(lastAi + 1).filter((c) => !isAi(c));
  return [
    `issue #${issue.number} 在你上次发言之后的新内容：`,
    ...(last.body !== bodyHash(issue) ? ['', '正文改成了：', issue.body ?? ''] : []),
    ...fresh.map((c) => `\n---\n@${c.author} 评论（${c.at}）：\n${c.body}`),
    '',
    '按前面的规则接着追问。最后只回一段 JSON：{status, choice, reason, data: {comment}}；status 只能是 ok | failed；choice 只能是 ask'
  ].join('\n');
}

function prompt(issue) {
  return [
    readFileSync(PROMPT, 'utf8').trim(),
    '',
    `工作目录（只读）：${PROJECT}`,
    '',
    'issue（正文 + 全部评论，带 miworkflow:discuss 标记的是你之前的评论）：',
    issue.text,
    '',
    '最后只回一段 JSON：{status, choice, reason, data: {comment}}；status 只能是 ok | failed；choice 只能是 ask'
  ].join('\n');
}
