// GitHub 讨论单：人给 issue 贴 agent-discuss，AI 就在评论区按 prompts/grilling.md 逐轮追问；人回复后下一次运行接着问。
// 人回复 /spec，AI 按 prompts/spec.md 把 spec 写进正文末尾的 spec 标记区域（人写的原文留在上面），阶段改为 discuss:spec；
// 之后 spec 阶段的评论（或再次 /spec）都当作对 spec 的修改意见，AI 只重写 spec 区域。spec 不贴 ready-for-agent。
// GitHub 评论串是唯一事实来源，会话只是缓存；讨论期间 Agent 对仓库只读。
// 会话号记在 AI 评论的标记里（cli=、session=，适配器交回了才记），不存本地文件：
// 同一 CLI 能续上就只喂 AI 上次发言之后的新评论与正文变化；标记里没有会话号就重放完整正文 + 全部评论；
// 续会话返回 session_not_found（换机器、会话丢失、cursor 等）就改为重放。
// pi 的会话号由「仓库 + issue 号」算出，首轮就建出可续的会话。
//
// 轮到 AI 的判据：人的内容（去掉 spec 区域的正文 + 不带 AI 标记的评论）的哈希 ≠ 最近一条 AI 标记里记下的哈希。
// AI 评论的标记记的是该轮「开始时」读到的哈希，所以 AI 思考期间人补发的评论，下一次运行会被处理。
// spec 区域不计入哈希：AI 写 spec 不会触发它自己，人改原文仍会触发。
// 一轮失败也发一条带标记的评论（写明原因），哈希不变就不自动重试；人回复任意内容即重试。
//
// 用法：
//   miworkflow github_discuss            逐张处理轮到 AI 的讨论单
//   miworkflow github_discuss --max 3    最多处理 3 张
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DISCUSS } from '../config.mjs';

export const title = 'GitHub 讨论单：agent-discuss → 评论区逐轮追问 → /spec 写入正文';

const PROJECT = fileURLToPath(new URL('../..', import.meta.url));
const PROMPTS = {
  grilling: fileURLToPath(new URL('../prompts/grilling.md', import.meta.url)),
  spec: fileURLToPath(new URL('../prompts/spec.md', import.meta.url))
};
const ENTER = 'agent-discuss';
const GRILLING = 'discuss:grilling';
const SPEC = 'discuss:spec';
// 标记必须在评论末尾：人引用 AI 评论时标记落在中间，不能把人的评论当成 AI 的。
const MARK = /<!--\s*miworkflow:discuss\s+hash=([0-9a-f]+)((?:\s+\w+=\S+?)*)\s*-->\s*$/;
const SPEC_BEGIN = '<!-- miworkflow:spec:begin -->';
const SPEC_END = '<!-- miworkflow:spec:end -->';
const SPEC_AREA = /<!--\s*miworkflow:spec:begin\s*-->([\s\S]*?)<!--\s*miworkflow:spec:end\s*-->/g;
const SPEC_CMD = /^\/spec(?![\w-])/i;

export default async function ({ script, agent, args }) {
  const max = args.max === undefined ? Infinity : Number(args.max);
  if (max !== Infinity && !(Number.isInteger(max) && max >= 1)) throw new Error(`--max 要正整数：${args.max}`);
  const r = await script('gh_discuss_list', { enter: ENTER, grilling: GRILLING, spec: SPEC });
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
    const mode = hasLabel(issue, SPEC) || freshHuman(issue, last).some((c) => SPEC_CMD.test(c.body.trim())) ? 'spec' : 'grilling';
    if (mode === 'spec') {
      if (!hasLabel(issue, SPEC) || hasLabel(issue, GRILLING)) {
        await script('gh_discuss_post', { number: issue.number, addLabel: SPEC, ...(hasLabel(issue, GRILLING) ? { removeLabel: GRILLING } : {}) });
      }
    } else if (!hasLabel(issue, GRILLING)) {
      await script('gh_discuss_post', { number: issue.number, addLabel: GRILLING });
    }
    const out = await askRound(issue, last, agent, mode);
    const mark = marker(hash, humanComments(issue).length, out.cli, out.session, bodyHash(issue));
    const post = { number: issue.number };
    if (!out.ok) {
      post.body = `这一轮${mode === 'spec' ? '写 spec ' : '追问'}失败：${out.reason}\n\n回复任意内容重试。\n\n${mark}`;
    } else if (mode === 'spec') {
      post.setBody = withSpec(issue.body, out.text.replace(/<!--\s*miworkflow:spec:(?:begin|end)\s*-->/g, ''));
      post.body = `${specOf(issue.body) === null ? '已写好 spec' : '已按评论改写 spec'}，见正文的 spec 区域。继续评论修改意见，AI 会重写那一段。\n\n${mark}`;
    } else {
      post.body = `${out.text}\n\n${mark}`;
    }
    const p = await script('gh_discuss_post', post);
    const done = mode === 'spec' ? '已写 spec' : '已追问';
    if (p.status !== 'ok') console.error(`✖ #${issue.number} 回写失败：${p.error}`);
    else console.log(`${out.ok ? '✔' : '✖'} #${issue.number} ${out.ok ? done : `失败：${out.reason}`}`);
  }
  console.log(`本轮结束：处理 ${handled} 张讨论单`);
}

async function askRound(issue, last, agent, mode) {
  const cli = agentCli();
  const own = cli === 'pi' ? piSession(issue.number) : undefined;
  const prev = last?.session && last.cli === cli && (!own || last.session === own) ? last.session : undefined;
  let res;
  try {
    if (prev) {
      res = await callAgent(agent, issue, deltaPrompt(issue, last, mode), prev, mode, { delta: true });
      if (res.choice === 'session_not_found') {
        res = await callAgent(agent, issue, `（续不上，改为重放：${res.reason || prev}）\n\n${prompt(issue, mode)}`, own, mode);
      }
    } else {
      res = await callAgent(agent, issue, prompt(issue, mode), own, mode);
    }
  } catch (err) {
    return { ok: false, cli, reason: String(err?.message ?? err).split('\n')[0] };
  }
  const session = typeof res.session === 'string' && res.session ? res.session : undefined;
  if (res.status !== 'ok') return { ok: false, cli, session, reason: `${res.status}：${res.reason || res.error || '无说明'}` };
  const { choice, key } = CONTRACT[mode];
  const text = typeof res.data?.[key] === 'string' ? res.data[key].trim() : '';
  if (res.choice !== choice || !text) return { ok: false, cli, session, reason: `输出不合契约（要 choice=${choice} 且 data.${key} 非空）` };
  return { ok: true, cli, session, text };
}

const CONTRACT = { grilling: { choice: 'ask', key: 'comment' }, spec: { choice: 'spec', key: 'spec' } };

const contractLine = (mode) => {
  const { choice, key } = CONTRACT[mode];
  return `最后只回一段 JSON：{status, choice, reason, data: {${key}}}；status 只能是 ok | failed；choice 只能是 ${choice}`;
};

// 会话进出走适配器（Core §10）；自定义命令（AGENTFLOW_AGENT_CMD）没有适配器，会话号只能放进 inputs。
// inputs 的原文与完整提示词：续会话时会话里已有，不再整段重喂。
function callAgent(agent, issue, goal, session, mode, { delta = false } = {}) {
  const spec = agentSpec();
  const inputs = { cwd: PROJECT, number: issue.number, ...(delta ? {} : { issue: issueText(issue) }), choices: [CONTRACT[mode].choice] };
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

const hasLabel = (issue, name) => issue.labels.some((l) => l.toLowerCase() === name);

const isAi = (c) => MARK.test(c.body ?? '');

// 人写的原文：正文去掉 spec 区域
const humanBody = (body) => String(body ?? '').replace(SPEC_AREA, '').trimEnd();

function specOf(body) {
  const m = [...String(body ?? '').matchAll(SPEC_AREA)];
  return m.length ? m[m.length - 1][1].trim() : null;
}

const withSpec = (body, spec) => [humanBody(body), `${SPEC_BEGIN}\n${spec}\n${SPEC_END}`].filter(Boolean).join('\n\n');

const humanComments = (issue) => issue.comments.filter((c) => !isAi(c));

// AI 上一轮开始后才出现的人的评论：按标记里的 seen（该轮读到的人评论条数）切；AI 思考期间补发的评论排在 AI 评论之前，也算新的。
function freshHuman(issue, last) {
  if (/^\d+$/.test(last?.seen ?? '')) return humanComments(issue).slice(Number(last.seen));
  const lastAi = issue.comments.map(isAi).lastIndexOf(true);
  return issue.comments.slice(lastAi + 1).filter((c) => !isAi(c));
}

function humanHash(issue) {
  const human = [humanBody(issue.body), ...issue.comments.filter((c) => !isAi(c)).map((c) => `${c.author}\n${c.body}`)];
  return createHash('sha256').update(JSON.stringify(human)).digest('hex').slice(0, 16);
}

function lastMark(issue) {
  const ai = issue.comments.filter(isAi);
  if (!ai.length) return null;
  const m = MARK.exec(ai[ai.length - 1].body);
  const fields = Object.fromEntries([...m[2].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
  return { hash: m[1], ...fields };
}

const bodyHash = (issue) => createHash('sha256').update(humanBody(issue.body)).digest('hex').slice(0, 16);

const marker = (hash, seen, cli, session, body) => session
  ? `<!-- miworkflow:discuss hash=${hash} seen=${seen} cli=${cli} session=${session} body=${body} -->`
  : `<!-- miworkflow:discuss hash=${hash} seen=${seen} -->`;

// 正文只给人写的原文；spec 区域单独给（spec 阶段才需要）
const issueText = (issue) => [
  `# #${issue.number} ${issue.title}`,
  '',
  humanBody(issue.body),
  ...issue.comments.map((c) => `\n---\n@${c.author} 评论（${c.at}）：\n${c.body}`)
].join('\n');

function specSection(issue, mode) {
  if (mode !== 'spec') return [];
  const cur = specOf(issue.body);
  return cur === null ? ['', '正文里还没有 spec，按上面的讨论写一份。'] : ['', '当前 spec（正文 spec 区域），按人的新评论修改：', cur];
}

// 续会话只喂 AI 上次发言之后的新评论与正文变化；spec 阶段额外带上写法与当前 spec。
function deltaPrompt(issue, last, mode) {
  return [
    ...(mode === 'spec' ? [readFileSync(PROMPTS.spec, 'utf8').trim(), ''] : []),
    `issue #${issue.number} 自你上次发言之后的新内容：`,
    ...(last.body !== bodyHash(issue) ? ['', '正文改成了：', humanBody(issue.body)] : []),
    ...freshHuman(issue, last).map((c) => `\n---\n@${c.author} 评论（${c.at}）：\n${c.body}`),
    ...specSection(issue, mode),
    '',
    mode === 'spec' ? '按上面的写法交回完整 spec。' : '按前面的规则接着追问。',
    contractLine(mode)
  ].join('\n');
}

function prompt(issue, mode) {
  return [
    readFileSync(PROMPTS[mode], 'utf8').trim(),
    '',
    `工作目录（只读）：${PROJECT}`,
    '',
    'issue（正文 + 全部评论；带 miworkflow:discuss 标记的是你之前的评论）：',
    issueText(issue),
    ...specSection(issue, mode),
    '',
    contractLine(mode)
  ].join('\n');
}
