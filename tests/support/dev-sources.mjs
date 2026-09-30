// 两家假工单源，接成同一套接口：场景和契约测试只写一遍，对 GitHub、TAPD 各跑一次（TODO.md F5）。
// 工单写成 { key, title?, body?, labels?, deps? }：key 是场景里的小编号，各家换成自己的工单号；
// deps 是前置工单的 key（GitHub 写进正文 `- [ ] #N`，TAPD 写成前后置关系）。
// 两家「完成」含义不同是有意的：GitHub 关单 + 只留 afk-delivered；TAPD 不关单、ready 保留、贴 afk-delivered。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, issue, readState } from './github-template.mjs';
import { readTapdState, startFakeOpenApi, story, tapdEnv, writeTapdState } from './tapd-fakes.mjs';

const github = {
  name: 'github',
  id: (key) => String(key),
  ref: (key) => `#${key}`,
  commitPrefix: (key) => `#${key} `,
  // GitHub 缺省不分类型（COMMIT_TYPES 空），Agent 给了也不用
  commitSubject: (key, type, summary) => `#${key} ${summary}`,
  async open({ tickets = [], ...opts } = {}) {
    const issues = tickets.map((t) => issue(t.key, {
      title: t.title,
      body: [t.body ?? `做 ${t.key}`, ...(t.deps ?? []).map((d) => `- [ ] #${d}`)].join('\n'),
      labels: t.labels ?? []
    }));
    return { ...setup({ source: 'github', issues, ...opts }), close: async () => {} };
  },
  view(s, key) {
    const i = readState(s).issues.find((x) => x.number === key);
    return { closed: i.state === 'CLOSED', labels: i.labels.map((l) => l.name), comments: (i.comments ?? []).map((c) => c.body) };
  },
  // 工单系统一直 5xx：之后每条 gh / tapd-cli 调用都报错
  down(s) {
    const st = readState(s);
    const fail = { times: 999, message: 'HTTP 500: Something went wrong while executing your query' };
    st.ghFail = Object.fromEntries(['list', 'view', 'edit', 'comment', 'close', 'create'].map((a) => [a, { ...fail }]));
    writeFileSync(s.stateFile, JSON.stringify(st));
  },
  deliveredLabels: ['afk-delivered']
};

const TAPD_BASE = '1152360842001006';
const tapdId = (key) => `${TAPD_BASE}${String(key).padStart(3, '0')}`;

const tapd = {
  name: 'tapd',
  id: tapdId,
  ref: (key) => `story ${tapdId(key)}`,
  commitPrefix: (key) => `feat:${tapdId(key).slice(-7)} `,
  commitSubject: (key, type = 'feat', summary) => `${type}:${tapdId(key).slice(-7)} ${summary}`,
  async open({ tickets = [], ...opts } = {}) {
    const s = setup({ source: 'tapd', ...opts });
    s.tapdFile = path.join(s.base, 'tapd-state.json');
    writeTapdState(s.tapdFile, {
      stories: tickets.map((t) => story(tapdId(t.key), {
        name: t.title ?? `issue ${t.key}`,
        label: (t.labels ?? []).join('|'),
        description: `<p>${t.body ?? `做 ${t.key}`}</p>`
      })),
      relations: tickets.flatMap((t) => (t.deps ?? []).map((d) => ({
        workitem_id: tapdId(d), dst_workitem_id: tapdId(t.key), src_field: 'due', dst_field: 'begin'
      })))
    });
    const api = await startFakeOpenApi(s.tapdFile);
    Object.assign(s.env, tapdEnv(s.tapdFile, api.endpoint), { TAPD_NPC_ROLE: 'bot-npc' });
    s.close = () => api.close();
    return s;
  },
  view(s, key) {
    const st = readTapdState(s.tapdFile);
    const x = st.stories.find((y) => y.id === tapdId(key));
    return {
      closed: false,
      status: x.status,
      labels: String(x.label ?? '').split('|').filter(Boolean),
      comments: st.comments.filter((c) => c.entry_id === x.id).map((c) => c.description)
    };
  },
  down(s) {
    const st = readTapdState(s.tapdFile);
    st.fail = { times: 999, message: 'HTTP 500 Internal Server Error' };
    writeFileSync(s.tapdFile, JSON.stringify(st));
  },
  deliveredLabels: ['ready-for-agent', 'afk-delivered']
};

export const SOURCES = { github, tapd };
