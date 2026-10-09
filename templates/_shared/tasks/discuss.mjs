// 讨论单：人给工单贴 agent-discuss，AI 就在评论区按 prompts/grilling.md 逐轮追问；人回复后下一次运行接着问。
// 任务只认四个脚本名（discuss_list / discuss_view / discuss_post / tickets_create）与 prompts/ 里的三段提示词；
// 是哪家工单系统、正文与评论长什么样、标记与 spec 存在哪，全在每个工单源的那几个脚本里（Core.md §15）。
//
// 规范形状（任务只认它，源负责与自家存储形态互转）：
//   discuss_list 入 { enter, grilling, spec, cursor? }，出 { items: [{ id, ref, title, labels, changed? }], cursor? }
//     cursor 内容归源，任务原样存、下次原样带回；changed = false 的单子这轮不读
//   discuss_view 入 { id }，出 { id, ref, title, body, spec, labels, comments }
//     body     = 人写的正文（Markdown，机器区域/机器评论已去掉）
//     spec     = 当前 spec（Markdown）或 null
//     comments = [{ id, author, at, text, ai, mark }]；ai = 是不是 AI 发的；
//                mark（ai 才有）= { hash, seen, cli, session, body }，记账字段，没有就 null
//   discuss_post 入 { id, body?, mark?, spec?, setTickets?, addLabel?, removeLabel? }，出 { did: string[] }
//     源自己决定 body（评论，末尾由源附上 mark）、spec、清单各自落在哪
//   tickets_create 入 { parentId, tickets: [{ key, title, body, priority, review, blockedBy }] }，出 { tickets, problems }
//     Agent 只交结构，建单 / 贴标签 / 写依赖由脚本做（Agent 不该碰工单系统）
//
// 三家（grilling → spec → ticketed）：
//   追问：AI 按 grilling.md 写一条评论（data.comment），choice=ask
//   写 spec：人回复 /spec 或阶段已是 spec → AI 按 spec.md 交回完整 spec（data.spec），choice=spec
//   拆单：spec 阶段人回复 /tickets → AI 按 tickets.md 交回开发单结构（data.tickets），choice=tickets
//        脚本建单并回查；通过就写清单、阶段改为 ticketed，此后不再响应（人把阶段改回 spec 即恢复）
//   讨论单由人来关。
//
// 判轮：人的内容（body + 不带 mark 的评论）的哈希 ≠ 最近一条 AI 评论记下的哈希，就轮到 AI。
// AI 评论记的是该轮「开始时」读到的哈希，所以 AI 思考期间人补发的评论，下一次运行会被处理。
// AI 的 mark 里另记该轮读到的人评论条数（seen）与当时的正文哈希（body），续会话只喂之后的新内容。
// 一轮失败也发一条带 mark 的评论（写明原因），哈希不变就不自动重试；人回复任意内容即重试。
//
// 会话：按 CLI + 工单号算会话号（pi 首轮就建出可续的会话）。续不上（换机器、会话丢失、cursor 等）就重放完整正文 + 全部评论。
//
// 省着查（工单系统有调用额度）：退避对所有调用方生效，单跑也读 logs/discuss.pace.json。
//   只管自动循环（--every）的话，外面套一层 while 反复单跑就能把额度烧光——每轮都是实打实两次调用。
//   节奏：下次查的时刻记在 logs/discuss.pace.json，间隔 = 距上次有动静的时间 ÷ 4，最长 config.mjs 的 DISCUSS_IDLE_MAX_SEC；
//         没到点的那一轮直接结束，不碰工单系统。列单失败（如额度用完）按最长间隔退开。人的手动放行：--now。
//   只拦「上一轮没事干」：干过活的那一轮不记退避，免得人刚在工单上补完内容、重跑却被自己的上一轮挡住。
//   退避短于 PACE_MIN_GATE_MS 也当 0——刚有动静时间隔只有零点几秒，拦不住什么，反倒会挡住紧接着的手动重跑。
//   增量：只在 --every 循环里用（内核给每一轮设 AGENTFLOW_LOOP_PID）——单跑照旧全量看一遍，也不会动循环攒下的 cursor。
//         discuss_list 交回的 cursor 原样存着，下次带上；源据此给每张单标 changed，没变的不读。
//         源不支持增量（不交 cursor、不标 changed）就每张都读。本轮有单子没读成，cursor 不前进，下次重看。
//
// 用法：
//   miworkflow discuss                  逐张处理轮到 AI 的讨论单
//   miworkflow discuss --max 3          最多处理 3 张
//   miworkflow discuss --now            忽略退避，立刻就查一次（刚在工单上补了内容，不想等）
//   miworkflow discuss --every 30s      常驻：最快 30 秒查一次，没动静就逐步拉长
//   miworkflow stop discuss             手头这张讨论单处理完就停
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCUSS } from '../source.mjs';
import { DISCUSS_IDLE_MAX_SEC } from '../config.mjs';

export const title = '讨论单：agent-discuss → 评论区逐轮追问 → /spec 写 spec → /tickets 建开发单';

const PROJECT = fileURLToPath(new URL('../..', import.meta.url));
const PROMPTS = {
  grilling: fileURLToPath(new URL('../prompts/grilling.md', import.meta.url)),
  spec: fileURLToPath(new URL('../prompts/spec.md', import.meta.url)),
  tickets: fileURLToPath(new URL('../prompts/tickets.md', import.meta.url))
};
const ENTER = 'agent-discuss';
const GRILLING = 'discuss:grilling';
const SPEC = 'discuss:spec';
const TICKETED = 'discuss:ticketed';
const SPEC_CMD = /^\/spec(?![\w-])/i;
const TICKETS_CMD = /^\/tickets(?![\w-])/i;
const CONTRACT = {
  grilling: { choice: 'ask', key: 'comment' },
  spec: { choice: 'spec', key: 'spec' },
  tickets: { choice: 'tickets', key: 'tickets' }
};
// 节点短名（§13.1、§13.6）：提示词太长，不当节点名，viewer 里显示这几个
const LABELS = { grilling: '讨论Agent', spec: '规格Agent', tickets: '拆单Agent' };

export default async function ({ script, agent, args, stopping = () => false }) {
  const max = args.max === undefined ? Infinity : Number(args.max);
  if (max !== Infinity && !(Number.isInteger(max) && max >= 1)) throw new Error(`--max 要正整数：${args.max}`);
  // 退避对所有调用方生效（单跑也读）：不然外面套一层 while 反复单跑，每轮都实打实查工单系统。--now 是人的手动放行。
  const loop = Boolean(process.env.AGENTFLOW_LOOP_PID);
  const pace = readPace();
  if (!args.now && pace.idle && Date.now() < pace.nextAt) {
    console.log(`还没到点：${clock(pace.nextAt)} 再查（上一轮没事干；上次有动静：${pace.activeAt ? clock(pace.activeAt) : '无'}）；要立刻就查用 --now`);
    return;
  }
  // cursor（增量）只在循环里带：单跑按老规矩全量看一遍
  const cursor = loop ? pace.cursor : null;
  const r = await script('discuss_list', { enter: ENTER, grilling: GRILLING, spec: SPEC, ...(cursor ? { cursor } : {}) });
  if (r.status !== 'ok') {
    writePace({ ...pace, nextAt: Date.now() + DISCUSS_IDLE_MAX_SEC * 1000, idle: true });
    throw new Error(`列讨论单失败：${r.error}`);
  }

  let handled = 0;
  let complete = true;
  for (const item of r.data.items) {
    if (item.changed === false) continue;
    if (handled >= max || stopping()) { complete = false; break; }
    const v = await script('discuss_view', { id: item.id });
    if (v.status !== 'ok') { complete = false; console.error(`✖ 读 ${item.ref} 失败：${v.error}`); continue; }
    const issue = v.data;
    const hash = humanHash(issue);
    const last = lastMark(issue);
    if (hash === last?.hash) continue;

    handled++;
    const fresh = freshHuman(issue, last);
    const mode = hasLabel(issue, SPEC) && fresh.some((c) => TICKETS_CMD.test(c.text.trim())) ? 'tickets'
      : hasLabel(issue, SPEC) || fresh.some((c) => SPEC_CMD.test(c.text.trim())) ? 'spec' : 'grilling';
    if (mode === 'tickets') {
      await ticketsRound(issue, last, hash, agent, script);
      continue;
    }
    if (mode === 'spec') {
      if (!hasLabel(issue, SPEC) || hasLabel(issue, GRILLING)) {
        await script('discuss_post', { id: issue.id, addLabel: SPEC, ...(hasLabel(issue, GRILLING) ? { removeLabel: GRILLING } : {}) });
      }
    } else if (!hasLabel(issue, GRILLING)) {
      await script('discuss_post', { id: issue.id, addLabel: GRILLING });
    }
    const out = await askRound(issue, last, agent, mode, PROJECT);
    const mark = marker(hash, humanComments(issue).length, out.cli, out.session, bodyHash(issue));
    const post = { id: issue.id };
    if (!out.ok) {
      post.body = `这一轮${mode === 'spec' ? '写 spec ' : '追问'}失败：${out.reason}\n\n回复任意内容重试。`;
      post.mark = mark;
    } else if (mode === 'spec') {
      post.body = `${issue.spec === null ? '已写好 spec' : '已按评论改写 spec'}。继续评论修改意见，AI 会重写。`;
      post.mark = mark;
      post.spec = out.text;
    } else {
      post.body = out.text;
      post.mark = mark;
    }
    const p = await script('discuss_post', post);
    const done = mode === 'spec' ? '已写 spec' : '已追问';
    if (p.status !== 'ok') console.error(`✖ ${issue.ref} 回写失败：${p.error}`);
    else console.log(`${out.ok ? '✔' : '✖'} ${issue.ref} ${out.ok ? done : `失败：${out.reason}`}`);
  }
  const now = Date.now();
  // busy 的 cursor 那一路只在循环里算：单跑不带 cursor，源会把每张单都标 changed，据此判 busy 会永远算「有动静」
  const busy = handled > 0 || (loop && Boolean(pace.cursor) && r.data.items.some((i) => i.changed));
  const activeAt = busy ? now : pace.activeAt;
  const gap = Math.min(DISCUSS_IDLE_MAX_SEC * 1000, (now - activeAt) / 4);
  // 上一轮没事干才记退避；退避短于门槛就当 0（否则刚有动静时那几十毫秒的间隔也会挡住下一个调用）
  const idle = !busy;
  const nextAt = idle && gap >= PACE_MIN_GATE_MS ? now + gap : now;
  // cursor 归循环：单跑把它抹成 null，会毁掉循环攒下的增量状态
  writePace({ cursor: loop ? (complete ? r.data.cursor ?? null : pace.cursor) : pace.cursor, activeAt, nextAt, idle });
  console.log(`本轮结束：处理 ${handled} 张讨论单，${clock(nextAt)} 再查`);
}

// 省着查的记账（所有调用方共用）：{ cursor, activeAt, nextAt, idle }，时间是毫秒时间戳；文件坏了当没有
const PACE = fileURLToPath(new URL('../logs/discuss.pace.json', import.meta.url));
// 退避短于这个就当 0：刚有动静时算出来的间隔只有零点几秒，拦不住什么，反倒会把紧接着的手动重跑挡住
const PACE_MIN_GATE_MS = 5_000;

function readPace() {
  try {
    const p = JSON.parse(readFileSync(PACE, 'utf8'));
    return { cursor: p.cursor ?? null, activeAt: Number(p.activeAt) || 0, nextAt: Number(p.nextAt) || 0, idle: Boolean(p.idle) };
  } catch {
    return { cursor: null, activeAt: 0, nextAt: 0, idle: false };
  }
}

function writePace(p) {
  mkdirSync(path.dirname(PACE), { recursive: true });
  writeFileSync(PACE, JSON.stringify(p, null, 2));
}

const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

// 拆单：Agent 只交结构（data.tickets），建单 / 贴标签 / 写依赖 / 回查都在脚本里
async function ticketsRound(issue, last, hash, agent, script) {
  const out = await askRound(issue, last, agent, 'tickets', PROJECT);
  const mark = marker(hash, humanComments(issue).length, out.cli, out.session, bodyHash(issue));
  const post = { id: issue.id, mark };
  let line;
  if (!out.ok) {
    post.body = `这一轮建开发单失败：${out.reason}\n\n回复 /tickets 重试。`;
    line = `✖ ${issue.ref} 失败：${out.reason}`;
  } else {
    const c = await script('tickets_create', { parentId: issue.id, tickets: out.tickets });
    const problems = c.status === 'ok' ? c.data.problems : [`建单失败：${c.error}`];
    if (problems.length) {
      post.body = `开发单没建好，没有改阶段，请修好后回复 /tickets 再试：\n\n${problems.map((p) => `- ${p}`).join('\n')}`;
      line = `✖ ${issue.ref} 建单不通过：${problems.length} 个问题`;
    } else {
      const list = c.data.tickets.map((t) => `- [ ] ${t.ref}`).join('\n');
      post.setTickets = `## 开发单\n\n${list}`;
      post.addLabel = TICKETED;
      post.removeLabel = SPEC;
      post.body = `已建开发单 ${c.data.tickets.map((t) => t.ref).join('、')}，阶段改为 ${TICKETED}，AI 不再响应评论（改回 ${SPEC} 即恢复）。讨论单请人来关。`;
      line = `✔ ${issue.ref} 已建开发单 ${c.data.tickets.length} 张`;
    }
  }
  const p = await script('discuss_post', post);
  if (p.status !== 'ok') console.error(`✖ ${issue.ref} 回写失败：${p.error}`);
  else console.log(line);
}

// 一轮 Agent 调用：续会话只喂增量，续不上就重放；回来的选择必须合契约
async function askRound(issue, last, agent, mode, project) {
  const cli = agentCli();
  const own = cli === 'pi' ? piSession(project, issue.id) : undefined;
  const prev = last?.session && last.cli === cli && (!own || last.session === own) ? last.session : undefined;
  let res;
  try {
    if (prev) {
      res = await callAgent(agent, issue, deltaPrompt(issue, last, mode), prev, mode, project, { delta: true });
      if (res.choice === 'session_not_found') {
        res = await callAgent(agent, issue, `（续不上，改为重放：${res.reason || prev}）\n\n${prompt(issue, mode, project)}`, own, mode, project);
      }
    } else {
      res = await callAgent(agent, issue, prompt(issue, mode, project), own, mode, project);
    }
  } catch (err) {
    return { ok: false, cli, reason: String(err?.message ?? err).split('\n')[0] };
  }
  const session = typeof res.session === 'string' && res.session ? res.session : undefined;
  if (res.status !== 'ok') return { ok: false, cli, session, reason: `${res.status}：${res.reason || res.error || '无说明'}` };
  const { choice, key } = CONTRACT[mode];
  if (res.choice !== choice) return { ok: false, cli, session, reason: `输出不合契约（要 choice=${choice}）` };
  if (mode === 'tickets') {
    const tickets = res.data?.tickets;
    if (!Array.isArray(tickets) || !tickets.length) return { ok: false, cli, session, reason: '输出不合契约（要 data.tickets 是非空数组）' };
    return { ok: true, cli, session, tickets };
  }
  const text = typeof res.data?.[key] === 'string' ? res.data[key].trim() : '';
  if (!text) return { ok: false, cli, session, reason: `输出不合契约（要 data.${key} 非空）` };
  return { ok: true, cli, session, text };
}

// 会话进出走适配器（Core §10）；自定义命令（AGENTFLOW_AGENT_CMD）没有适配器，会话号只能放进 inputs。
// inputs 的原文与完整提示词：续会话时会话里已有，不再整段重喂。
function callAgent(agent, issue, goal, session, mode, project, { delta = false } = {}) {
  const spec = agentSpec();
  const inputs = { cwd: project, id: issue.id, ref: issue.ref, ...(delta ? {} : { ticket: issueText(issue) }), choices: [CONTRACT[mode].choice] };
  const label = LABELS[mode];
  if (spec) return agent(goal, { label, agent: session ? { ...spec, session } : spec, inputs });
  return agent(goal, { label, inputs: session ? { ...inputs, session } : inputs });
}

function agentSpec() {
  const spec = DISCUSS ?? (process.env.AGENTFLOW_AGENT_CMD ? null : process.env.AGENTFLOW_AGENT);
  if (!spec) return null;
  return typeof spec === 'string' ? { cli: spec } : spec;
}

const agentCli = () => String(agentSpec()?.cli ?? 'cmd');

const piSession = (project, id) => `discuss-${createHash('sha256').update(`${project}#${id}`).digest('hex').slice(0, 16)}`;

const hasLabel = (issue, name) => (issue.labels ?? []).some((l) => String(l).toLowerCase() === name.toLowerCase());

const isAi = (c) => c.ai === true;

const humanComments = (issue) => issue.comments.filter((c) => !isAi(c));

// AI 上一轮开始后才出现的人的评论：按 mark 里的 seen（该轮读到的人评论条数）切
function freshHuman(issue, last) {
  const humans = humanComments(issue);
  if (Number.isInteger(last?.seen)) return humans.slice(last.seen);
  const lastAi = issue.comments.map(isAi).lastIndexOf(true);
  return issue.comments.slice(lastAi + 1).filter((c) => !isAi(c));
}

function humanHash(issue) {
  const human = [issue.body, ...humanComments(issue).map((c) => `${c.author}\n${c.text}`)];
  return createHash('sha256').update(JSON.stringify(human)).digest('hex').slice(0, 16);
}

function lastMark(issue) {
  const ai = issue.comments.filter(isAi).filter((c) => c.mark);
  return ai.length ? ai[ai.length - 1].mark : null;
}

const bodyHash = (issue) => createHash('sha256').update(issue.body ?? '').digest('hex').slice(0, 16);

const marker = (hash, seen, cli, session, body) => ({ hash, seen, ...(cli ? { cli } : {}), ...(session ? { session } : {}), body });

const contractLine = (mode) => {
  const { choice, key } = CONTRACT[mode];
  if (mode === 'tickets') {
    return '最后只回一段 JSON：{status, choice, reason, data: {tickets}}；status 只能是 ok | failed；choice 只能是 tickets；'
      + 'data.tickets 是数组，每项 {key, title, body, priority, review, blockedBy}（key 是本次内的短编号，blockedBy 用 key）';
  }
  return `最后只回一段 JSON：{status, choice, reason, data: {${key}}}；status 只能是 ok | failed；choice 只能是 ${choice}`;
};

// 正文只给人写的原文；评论逐条列出（谁、什么时候、说了什么）
const issueText = (issue) => [
  `# ${issue.ref} ${issue.title}`,
  '',
  issue.body,
  ...issue.comments.map((c) => `\n---\n${isAi(c) ? '[AI] ' : ''}@${c.author} 评论（${c.at}）：\n${c.text}`)
].join('\n');

function specSection(issue, mode) {
  if (mode === 'grilling') return [];
  if (mode === 'tickets') return ['', `讨论单：${issue.ref}`, '', '要拆的 spec：', issue.spec ?? '（还没有 spec，按上面的讨论拆）'];
  return issue.spec === null ? ['', '还没有 spec，按上面的讨论写一份。'] : ['', '当前 spec，按人的新评论修改：', issue.spec];
}

// 续会话只喂 AI 上次发言之后的新评论与正文变化；spec 阶段额外带上写法与当前 spec。
function deltaPrompt(issue, last, mode) {
  return [
    ...(mode !== 'grilling' ? [readFileSync(PROMPTS[mode], 'utf8').trim(), ''] : []),
    `${issue.ref} 自你上次发言之后的新内容：`,
    ...(last.body !== bodyHash(issue) ? ['', '正文改成了：', issue.body] : []),
    ...freshHuman(issue, last).map((c) => `\n---\n@${c.author} 评论（${c.at}）：\n${c.text}`),
    ...specSection(issue, mode),
    '',
    { spec: '按上面的写法交回完整 spec。', tickets: '按上面的写法交回开发单结构。', grilling: '按前面的规则接着追问。' }[mode],
    contractLine(mode)
  ].join('\n');
}

function prompt(issue, mode, project) {
  return [
    readFileSync(PROMPTS[mode], 'utf8').trim(),
    '',
    `工作目录（只读）：${project}`,
    '',
    '工单（正文 + 全部评论；标了「AI」的是你之前的发言）：',
    issueText(issue),
    ...specSection(issue, mode),
    '',
    contractLine(mode)
  ].join('\n');
}
