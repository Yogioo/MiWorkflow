// GitHub 讨论单：人给 issue 贴 agent-discuss，AI 就在评论区按 prompts/grilling.md 逐轮追问；人回复后下一次运行接着问。
// GitHub 评论串是唯一事实来源：每轮重放完整正文 + 全部评论；讨论期间 Agent 对仓库只读。
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
const MARK = /<!--\s*miworkflow:discuss\s+hash=([0-9a-f]+)\s*-->/;

export default async function ({ script, agent, args }) {
  const max = args.max ? Number(args.max) : Infinity;
  const r = await script('gh_discuss_list', { enter: ENTER, grilling: GRILLING });
  if (r.status !== 'ok') throw new Error(`列讨论单失败：${r.error}`);

  let handled = 0;
  for (const item of r.data.issues) {
    if (handled >= max) break;
    const v = await script('gh_issue_view', { number: item.number });
    if (v.status !== 'ok') { console.error(`✖ 读 #${item.number} 失败：${v.error}`); continue; }
    const issue = v.data;
    const hash = humanHash(issue);
    if (hash === lastMarkedHash(issue)) continue;

    handled++;
    if (!issue.labels.some((l) => l.toLowerCase() === GRILLING)) {
      await script('gh_discuss_post', { number: issue.number, addLabel: GRILLING });
    }
    const out = await askRound(issue, agent);
    const body = out.ok
      ? `${out.comment}\n\n${marker(hash)}`
      : `这一轮追问失败：${out.reason}\n\n回复任意内容重试。\n\n${marker(hash)}`;
    const p = await script('gh_discuss_post', { number: issue.number, body });
    if (p.status !== 'ok') console.error(`✖ #${issue.number} 发评论失败：${p.error}`);
    else console.log(`${out.ok ? '✔' : '✖'} #${issue.number} ${out.ok ? '已追问' : `失败：${out.reason}`}`);
  }
  console.log(`本轮结束：处理 ${handled} 张讨论单`);
}

async function askRound(issue, agent) {
  let res;
  try {
    res = await agent(prompt(issue), {
      ...(DISCUSS ? { agent: DISCUSS } : {}),
      inputs: { cwd: PROJECT, number: issue.number, issue: issue.text, choices: ['ask'] }
    });
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).split('\n')[0] };
  }
  if (res.status !== 'ok') return { ok: false, reason: `${res.status}：${res.reason || res.error || '无说明'}` };
  const comment = typeof res.data?.comment === 'string' ? res.data.comment.trim() : '';
  if (res.choice !== 'ask' || !comment) return { ok: false, reason: '输出不合契约（要 choice=ask 且 data.comment 非空）' };
  return { ok: true, comment };
}

const isAi = (c) => MARK.test(c.body ?? '');

function humanHash(issue) {
  const human = [issue.body ?? '', ...issue.comments.filter((c) => !isAi(c)).map((c) => `${c.author}\n${c.body}`)];
  return createHash('sha256').update(JSON.stringify(human)).digest('hex').slice(0, 16);
}

function lastMarkedHash(issue) {
  const ai = issue.comments.filter(isAi);
  return ai.length ? MARK.exec(ai[ai.length - 1].body)[1] : null;
}

const marker = (hash) => `<!-- miworkflow:discuss hash=${hash} -->`;

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
