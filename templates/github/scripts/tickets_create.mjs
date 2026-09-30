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
const LIST_LIMIT = 1000;

// `## Parent` 标题下第一行非空内容里的 #N，或 `Parent: #N`
function parentOf(body) {
  const text = String(body ?? '');
  const m = /^#{1,6}\s*Parent\s*\r?\n(?:\s*\r?\n)*\s*(?:-\s+\[[ xX]\]\s+)?#(\d+)\b/im.exec(text)
    ?? /^\s*Parent\s*[:：]\s*#(\d+)\b/im.exec(text);
  return m ? Number(m[1]) : null;
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

  const list = runGh(['issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number,title,body,labels', ...repoArg]);
  const parsed = JSON.parse(list);
  if (!Array.isArray(parsed)) throw new Error('gh issue list 返回的不是数组');
  const found = parsed
    .map((i) => ({ number: Number(i.number), title: i.title ?? '', body: i.body ?? '', labels: i.labels ?? [] }))
    .filter((i) => i.number !== parent && parentOf(i.body) === parent)
    .sort((a, b) => a.number - b.number);

  const check = [];
  if (!found.length) check.push(`没找到 Parent 指向 ${refOf(parent)} 的打开的开发单`);
  const deps = new Map();
  for (const t of found) {
    const refs = parseTaskList(t.body).map((r) => r.number);
    deps.set(t.number, refs.filter((n) => found.some((x) => x.number === n)));
    if (!hasLabel(t, READY)) check.push(`${refOf(t.number)} 没贴 ${READY}`);
    const ps = t.labels.map(labelName).filter((l) => /^P[0-4]$/i.test(l));
    if (ps.length !== 1) check.push(`${refOf(t.number)} 优先级标签要恰好一个 P0~P4，现在是 ${ps.length ? ps.join('、') : '没有'}`);
    if (refs.includes(parent)) check.push(`${refOf(t.number)} 的任务列表引用了讨论单 ${refOf(parent)}，会被它挡住`);
    if (refs.includes(t.number)) check.push(`${refOf(t.number)} 依赖了自己`);
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
