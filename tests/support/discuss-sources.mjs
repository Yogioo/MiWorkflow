// 讨论流程的两家假工单源，接成同一套接口：场景只写一遍（tests/support/discuss-scenarios.mjs），对 GitHub、TAPD 各跑一次。
// 讨论单写成 { key, labels?, body?, spec?, parent? }：key 是场景里的小编号，各家换成自己的工单号；spec 给了就预置一份当前 spec；
// parent 给了就是挂在那张讨论单下的已有子需求（GitHub 写正文 `## Parent`，TAPD 写 parent_id）。
// 读法按源各自实现，场景只认：
//   comments   讨论评论的原文（含标记）；TAPD 的 kind=spec 评论不算（它是 spec 的存放处）
//   original   人写的原文；spec 当前 spec 或 null
//   devTickets 建出来的开发单 [{ key, title, labels, body }]；blockedBy 某张开发单的前置 key
// 各家特有的存放方式：GitHub spec 写进正文标记区域、标记是 HTML 注释、依赖写进正文 `- [ ] #N`；
// TAPD spec 落成 kind=spec 评论、标记是评论末尾一行纯文本、依赖落成原生前后置关系。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setup, issue, readState } from './github-template.mjs';
import { readTapdState, startFakeOpenApi, story, tapdEnv, writeTapdState } from './tapd-fakes.mjs';

const MARK_FIELDS = '(?: \\w+=\\S+)*';
const SPEC_BEGIN = '<!-- miworkflow:spec:begin -->';
const SPEC_AREA = /<!-- miworkflow:spec:begin -->\n([\s\S]*?)\n<!-- miworkflow:spec:end -->/;

const github = {
  name: 'github',
  ref: (key) => `#${key}`,
  markRe: (fields = MARK_FIELDS) => new RegExp(`<!-- miworkflow:discuss hash=[0-9a-f]+ seen=\\d+${fields} -->`),
  async open({ issues = [] } = {}) {
    const list = issues.map((t) => {
      const text = `${t.parent ? `## Parent\n\n#${t.parent}\n\n` : ''}${t.body ?? `做 ${t.key}`}`;
      return issue(t.key, {
        labels: t.labels ?? [],
        body: t.spec === undefined ? text : `${text}\n\n${SPEC_BEGIN}\n${t.spec}\n<!-- miworkflow:spec:end -->`
      });
    });
    return { ...setup({ source: 'github', issues: list }), close: async () => {} };
  },
  thinkStep: (text) => ({ ghComment: text }),
  comments: (s, key) => ghIssue(s, key).comments.map((c) => c.body),
  labels: (s, key) => ghIssue(s, key).labels.map((l) => l.name),
  original: (s, key) => ghIssue(s, key).body.split(`\n\n${SPEC_BEGIN}`)[0],
  spec: (s, key) => SPEC_AREA.exec(ghIssue(s, key).body)?.[1] ?? null,
  reply(s, key, body, { beforeLast = false } = {}) {
    ghEdit(s, key, (i) => i.comments.splice(beforeLast ? i.comments.length - 1 : i.comments.length, 0, { author: 'human', at: '', body }));
  },
  editOriginal(s, key, text) {
    ghEdit(s, key, (i) => { i.body = [text, ...i.body.split(`\n\n${SPEC_BEGIN}`).slice(1)].join(`\n\n${SPEC_BEGIN}`); });
  },
  setLabels: (s, key, labels) => ghEdit(s, key, (i) => { i.labels = labels.map((name) => ({ name })); }),
  devTickets: (s, parent) => readState(s).issues.filter((i) => i.number !== parent)
    .map((i) => ({ key: i.number, title: i.title, labels: i.labels.map((l) => l.name), body: i.body })),
  blockedBy: (s, key) => [...(/## Blocked by\n\n([\s\S]*)$/.exec(ghIssue(s, key).body)?.[1] ?? '').matchAll(/- \[ \] #(\d+)/g)].map((m) => Number(m[1])),
  readyLabels: (priority, review) => ['ready-for-agent', priority, ...(review ? ['needs-review'] : [])]
};

const ghIssue = (s, key) => readState(s).issues.find((i) => i.number === key);
const ghEdit = (s, key, fn) => {
  const st = readState(s);
  fn(st.issues.find((i) => i.number === key));
  writeFileSync(s.stateFile, JSON.stringify(st));
};

const TAPD_BASE = '1152360842001006';
const tapdId = (key) => `${TAPD_BASE}${String(key).padStart(3, '0')}`;
const tapdKey = (id) => Number(String(id).slice(TAPD_BASE.length));
const TAPD_MARK = /\n*\[miworkflow:discuss [^\]]*\]\s*$/;
const isSpecComment = (c) => /\[miworkflow:discuss [^\]]* kind=spec\]\s*$/.test(c.description);

const tapd = {
  name: 'tapd',
  ref: (key) => `story ${tapdId(key)}`,
  markRe: (fields = MARK_FIELDS) => new RegExp(`\\[miworkflow:discuss hash=[0-9a-f]+ seen=\\d+${fields}\\]$`),
  async open({ issues = [] } = {}) {
    const s = setup({ source: 'tapd' });
    s.tapdFile = path.join(s.base, 'tapd-state.json');
    writeTapdState(s.tapdFile, {
      stories: issues.map((t) => ({
        ...story(tapdId(t.key), { name: `issue ${t.key}`, label: (t.labels ?? []).join('|'), description: t.body ?? `做 ${t.key}` }),
        ...(t.parent ? { parent_id: tapdId(t.parent) } : {})
      })),
      comments: issues.filter((t) => t.spec !== undefined).map((t, i) => ({
        id: String(i + 1), entry_type: 'stories', entry_id: tapdId(t.key), author: 'bot-npc',
        description: `${t.spec}\n\n[miworkflow:discuss hash=deadbeef seen=0 kind=spec]`, created: `2026-01-01 00:00:${String(i).padStart(2, '0')}`
      }))
    });
    const api = await startFakeOpenApi(s.tapdFile);
    Object.assign(s.env, tapdEnv(s.tapdFile, api.endpoint), { TAPD_NPC_ROLE: 'bot-npc' });
    s.close = () => api.close();
    return s;
  },
  thinkStep: (text) => ({ tapdComment: text }),
  comments: (s, key) => tapdComments(s, key).filter((c) => !isSpecComment(c)).map((c) => c.description),
  labels: (s, key) => String(tapdStory(s, key).label ?? '').split('|').filter(Boolean),
  original: (s, key) => tapdStory(s, key).description,
  spec: (s, key) => tapdComments(s, key).filter(isSpecComment).at(-1)?.description.replace(TAPD_MARK, '') ?? null,
  reply(s, key, body, { beforeLast = false } = {}) {
    tapdEdit(s, (st) => {
      const n = st.comments.length;
      const last = st.comments.at(-1);
      const c = { id: String(n + 1), entry_type: 'stories', entry_id: tapdId(key), description: body, author: 'human', created: `2026-01-01 00:00:${String(n).padStart(2, '0')}` };
      // 插在最后一条之前：同一时刻、排在它前面（假 OpenAPI 按 created 稳定排序）
      if (beforeLast) st.comments.splice(st.comments.indexOf(last), 0, { ...c, created: last.created });
      else st.comments.push(c);
    });
  },
  editOriginal: (s, key, text) => tapdEdit(s, (st) => { st.stories.find((x) => x.id === tapdId(key)).description = text; }),
  setLabels: (s, key, labels) => tapdEdit(s, (st) => { st.stories.find((x) => x.id === tapdId(key)).label = labels.join('|'); }),
  devTickets: (s, parent) => readTapdState(s.tapdFile).stories.filter((x) => x.parent_id === tapdId(parent))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((x) => ({ key: tapdKey(x.id), title: x.name, labels: String(x.label ?? '').split('|').filter(Boolean), body: x.description })),
  blockedBy: (s, key) => (readTapdState(s.tapdFile).relations ?? [])
    .filter((r) => r.dst_workitem_id === tapdId(key) && r.src_field === 'due' && r.dst_field === 'begin')
    .map((r) => tapdKey(r.workitem_id)),
  readyLabels: (priority, review) => ['ready-for-agent', ...(review ? ['needs-review'] : [])]
};

const tapdStory = (s, key) => readTapdState(s.tapdFile).stories.find((x) => x.id === tapdId(key));
const tapdComments = (s, key) => readTapdState(s.tapdFile).comments
  .filter((c) => c.entry_id === tapdId(key))
  .sort((a, b) => String(a.created).localeCompare(String(b.created)));
const tapdEdit = (s, fn) => {
  const st = readTapdState(s.tapdFile);
  fn(st);
  writeFileSync(s.tapdFile, JSON.stringify(st, null, 2));
};

export const SOURCES = { github, tapd };
