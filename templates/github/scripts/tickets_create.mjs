// 工单源接口：建开发单（GitHub 实现，Core.md §15）。Agent 只交结构，这里建单 / 贴标签 / 写依赖，再回查系统实际状态。
// 入：{ parentId, tickets: [{ key, title, body, priority, review, blockedBy: [key] }], repo? }
//     key 是本次内的短编号；blockedBy 用 key 指别的开发单（先建被依赖的）。
// 出：{ status, say, data: { tickets: [{ key, id, ref, title }], problems: string[] } }
//     problems 非空 = 没建好（可能部分建出来了），不写清单、不改阶段，由人处理。
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, runGhWithLabels, hasLabel, labelName, parseTaskList, issueNumber, refOf } from './_gh.mjs';
import { normalizeTickets, orderTickets, findCycle } from './_tickets.mjs';

const READY = 'ready-for-agent';
const REVIEW = 'needs-review';

// `## Parent` 标题下第一行非空内容里的 #N，或 `Parent: #N` → { number, taskList }；taskList = 写成了 `- [ ] #N`
function parentOf(body) {
  const text = String(body ?? '');
  const m = /^#{1,6}\s*Parent\s*\r?\n(?:\s*\r?\n)*\s*(-\s+\[[ xX]\]\s+)?#(\d+)\b/im.exec(text);
  if (m) return { number: Number(m[2]), taskList: Boolean(m[1]) };
  const p = /^\s*Parent\s*[:：]\s*#(\d+)\b/im.exec(text);
  return p ? { number: Number(p[1]), taskList: false } : null;
}

await main(async () => {
  const args = await readStdin();
  const parent = issueNumber(args.parentId);
  const repoArg = args.repo ? ['--repo', args.repo] : [];
  const raw = Array.isArray(args.tickets) ? args.tickets : [];
  const tickets = normalizeTickets(raw);

  const { ordered, problems } = orderTickets(tickets);
  if (problems.length) {
    emit({ status: 'ok', say: `开发单结构有问题，没建：${problems.length} 个`, data: { tickets: [], problems } });
    return;
  }

  // 建单：先建被依赖的，拿到单号再建依赖它的
  const made = new Map();
  for (const t of ordered) {
    const blocked = (t.blockedBy ?? []).map((k) => made.get(k)).filter(Boolean);
    const body = [
      '## Parent', '', refOf(parent), '',
      t.body || '（Agent 没写正文）', '',
      '## Blocked by', '', blocked.length ? blocked.map((b) => `- [ ] ${refOf(b)}`).join('\n') : '无'
    ].join('\n');
    const labels = [READY, t.priority, ...(t.review ? [REVIEW] : [])].flatMap((l) => ['--label', l]);
    const url = runGhWithLabels(['issue', 'create', '--title', t.title, '--body', body, ...labels, ...repoArg]).trim();
    const m = /\/issues\/(\d+)\s*$/.exec(url);
    if (!m) throw new Error(`gh issue create 没给出单号：${url.split('\n').pop()}`);
    made.set(t.key, Number(m[1]));
  }

  // 回查只看这次建的那几张（讨论单下原有的子需求不归这次管），逐张按单号读回系统实际状态
  const check = [];
  const found = [];
  for (const t of ordered) {
    const number = made.get(t.key);
    try {
      const i = JSON.parse(runGh(['issue', 'view', String(number), '--json', 'number,title,body,labels', ...repoArg]));
      found.push({ key: t.key, review: t.review, number, title: i.title ?? '', body: i.body ?? '', labels: i.labels ?? [] });
    } catch (err) {
      check.push(`${refOf(number)} 建完读不到：${String(err?.message ?? err).split('\n')[0]}`);
    }
  }
  const batch = new Set(made.values());
  const deps = new Map();
  for (const t of found) {
    const p = parentOf(t.body);
    if (!p || p.number !== parent) check.push(`${refOf(t.number)} 的 Parent 没指向讨论单 ${refOf(parent)}`);
    else if (p.taskList) check.push(`${refOf(t.number)} 的 Parent 写成了任务列表，要写成普通一行 ${refOf(parent)}`);
    const refs = parseTaskList(t.body).map((r) => r.number);
    deps.set(t.number, refs.filter((n) => batch.has(n)));
    if (!hasLabel(t, READY)) check.push(`${refOf(t.number)} 没贴 ${READY}`);
    if (t.review && !hasLabel(t, REVIEW)) check.push(`${refOf(t.number)} 要审查却没贴 ${REVIEW}`);
    const ps = t.labels.map(labelName).filter((l) => /^P[0-4]$/i.test(l));
    if (ps.length !== 1) check.push(`${refOf(t.number)} 优先级标签要恰好一个 P0~P4，现在是 ${ps.length ? ps.join('、') : '没有'}`);
    if (refs.includes(parent)) check.push(`${refOf(t.number)} 的任务列表引用了讨论单 ${refOf(parent)}，会被它挡住`);
    if (refs.includes(t.number)) check.push(`${refOf(t.number)} 依赖了自己`);
    for (const n of refs.filter((n) => n !== parent && !batch.has(n))) check.push(`${refOf(t.number)} 依赖了不在这批里的工单 ${refOf(n)}`);
  }
  const cycle = findCycle(deps);
  if (cycle) check.push(`开发单互相依赖成环：${cycle.map((n) => refOf(n)).join(' → ')}`);

  const out = tickets.map((t) => {
    const number = made.get(t.key);
    const live = found.find((f) => f.number === number);
    return { key: t.key, id: String(number), ref: refOf(number), title: live?.title ?? t.title };
  });
  emit({
    status: 'ok',
    say: check.length
      ? `${refOf(parent)} 建了 ${out.length} 张开发单，回查不通过：${check.length} 个问题`
      : `${refOf(parent)} 建开发单 ${out.map((t) => t.ref).join('、')}`,
    data: { tickets: out, problems: check }
  });
});
