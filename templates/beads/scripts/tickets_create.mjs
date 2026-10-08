// 工单源接口：建开发单（beads 实现，Core.md §15）。Agent 只交结构，这里建单 / 贴标签 / 写依赖，再回查库里的实际状态。
// 开发单建成讨论单的子单（--parent），优先级 P0~P4 直接落成 beads 的 0~4，依赖落成 blocks（bd dep add <开发单> <前置>）。
// 子单缺省会继承父单的标签（agent-discuss、discuss:spec 也跟着来，开发单就成了讨论单），所以一定带 --no-inherit-labels，回查也核对。
// 入：{ parentId, tickets: [{ key, title, body, priority, review, blockedBy: [key] }] }
//     key 是本次内的短编号；blockedBy 用 key 指别的开发单（先建被依赖的）。
// 出：{ status, say, data: { tickets: [{ key, id, ref, title }], problems: string[] } }
//     problems 非空 = 没建好（可能部分建出来了），不写清单、不改阶段，由人处理。
import { main, readStdin, emit } from './_lib.mjs';
import { runBd, bdJson, showIssue, issueId, labelsOf, hasLabel, priorityOf, blockersOf, parentOf } from './_bd.mjs';
import { withTextFile } from './_discuss.mjs';
import { normalizeTickets, orderTickets, findCycle } from './_tickets.mjs';
import { LABELS, refOf } from '../source.mjs';

await main(async () => {
  const args = await readStdin();
  const parent = issueId(args.parentId);
  const tickets = normalizeTickets(Array.isArray(args.tickets) ? args.tickets : []);

  const { ordered, problems } = orderTickets(tickets);
  if (problems.length) {
    emit({ status: 'ok', say: `开发单结构有问题，没建：${problems.length} 个`, data: { tickets: [], problems } });
    return;
  }

  // 建单：先建被依赖的，拿到 ID 再建依赖它的
  const made = new Map();
  for (const t of ordered) {
    const labels = [LABELS.ready, ...(t.review ? [LABELS.review] : [])];
    const created = withTextFile(t.body || '（Agent 没写正文）', (file) => bdJson([
      'create', '--title', t.title, '--body-file', file, '-p', t.priority.slice(1),
      '-l', labels.join(','), '--parent', parent, '--no-inherit-labels'
    ]));
    const id = (Array.isArray(created) ? created[0] : created)?.id;
    if (!id) throw new Error(`bd create 没给出 ID：${JSON.stringify(created).slice(0, 200)}`);
    made.set(t.key, String(id));
    for (const k of t.blockedBy) runBd(['dep', 'add', String(id), made.get(k)]);
  }

  // 回查只看这次建的那几张（讨论单下原有的子单不归这次管），逐张按 ID 读回库里的实际状态
  const check = [];
  const found = [];
  for (const t of ordered) {
    const id = made.get(t.key);
    try {
      found.push({ t, id, issue: showIssue(id) });
    } catch (err) {
      check.push(`${refOf(id)} 建完读不到：${String(err?.message ?? err).split('\n')[0]}`);
    }
  }
  const inherited = new Set(labelsOf(showIssue(parent)).map((l) => l.toLowerCase()));
  const expected = new Set([LABELS.ready, LABELS.review].map((l) => l.toLowerCase()));
  const batch = new Set(made.values());
  const deps = new Map();
  for (const { t, id, issue } of found) {
    if (parentOf(issue) !== parent) check.push(`${refOf(id)} 没挂在讨论单 ${refOf(parent)} 下`);
    if (!hasLabel(issue, LABELS.ready)) check.push(`${refOf(id)} 没贴 ${LABELS.ready}`);
    if (t.review && !hasLabel(issue, LABELS.review)) check.push(`${refOf(id)} 要审查却没贴 ${LABELS.review}`);
    const extra = labelsOf(issue).filter((l) => inherited.has(l.toLowerCase()) && !expected.has(l.toLowerCase()));
    if (extra.length) check.push(`${refOf(id)} 继承了讨论单的标签：${extra.join('、')}`);
    if (priorityOf(issue) !== Number(t.priority.slice(1))) check.push(`${refOf(id)} 优先级是 ${issue.priority}，要 ${t.priority.slice(1)}`);
    const refs = blockersOf(issue);
    deps.set(id, refs.filter((n) => batch.has(n)));
    if (refs.includes(parent)) check.push(`${refOf(id)} 依赖了讨论单 ${refOf(parent)}，会被它挡住`);
    if (refs.includes(id)) check.push(`${refOf(id)} 依赖了自己`);
    for (const n of refs.filter((n) => n !== parent && n !== id && !batch.has(n))) check.push(`${refOf(id)} 依赖了不在这批里的工单 ${refOf(n)}`);
    const want = t.blockedBy.map((k) => made.get(k)).sort();
    if (JSON.stringify(refs.filter((n) => batch.has(n)).sort()) !== JSON.stringify(want)) {
      check.push(`${refOf(id)} 的前置对不上：要 ${want.map(refOf).join('、') || '无'}，库里是 ${refs.map(refOf).join('、') || '无'}`);
    }
  }
  const cycle = findCycle(deps);
  if (cycle) check.push(`开发单互相依赖成环：${cycle.map(refOf).join(' → ')}`);

  const out = tickets.map((t) => {
    const id = made.get(t.key);
    const live = found.find((f) => f.id === id)?.issue;
    return { key: t.key, id, ref: refOf(id), title: live?.title ?? t.title };
  });
  emit({
    status: 'ok',
    say: check.length
      ? `${refOf(parent)} 建了 ${out.length} 张开发单，回查不通过：${check.length} 个问题`
      : `${refOf(parent)} 建开发单 ${out.map((t) => t.ref).join('、')}`,
    data: { tickets: out, problems: check }
  });
});
