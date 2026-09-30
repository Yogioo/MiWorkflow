// 回查讨论单拆出的开发单：找出正文 Parent 指向讨论单的打开的 issue，确认开发队列能解析它们的标签与依赖。
// 入：{ parent, ready?, repo? }
// 出：{ status, say, data: { tickets: [{ number, title }], problems: string[] } }，tickets 按 issue 号升序
import { main, readStdin, emit } from './_lib.mjs';
import { runGh, hasLabel, labelName, parseTaskList } from './_gh.mjs';

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
  const parent = Number(args.parent);
  if (!Number.isSafeInteger(parent) || parent <= 0) throw new Error(`parent 要 issue 号：${args.parent}`);
  const ready = args.ready ?? 'ready-for-agent';
  const repoArg = args.repo ? ['--repo', args.repo] : [];

  const raw = runGh([
    'issue', 'list', '--state', 'open', '--limit', String(LIST_LIMIT),
    '--json', 'number,title,body,labels', ...repoArg
  ]);
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('gh issue list 返回的不是数组');

  const tickets = parsed
    .map((i) => ({ number: Number(i.number), title: i.title ?? '', body: i.body ?? '', labels: i.labels ?? [] }))
    .filter((i) => i.number !== parent && parentOf(i.body) === parent)
    .sort((a, b) => a.number - b.number);

  const problems = [];
  if (!tickets.length) problems.push(`没找到 Parent 指向 #${parent} 的打开的开发单`);
  const deps = new Map();
  for (const t of tickets) {
    const refs = parseTaskList(t.body).map((r) => r.number);
    deps.set(t.number, refs.filter((n) => tickets.some((x) => x.number === n)));
    if (!hasLabel(t, ready)) problems.push(`#${t.number} 没贴 ${ready}`);
    const ps = t.labels.map(labelName).filter((l) => /^P[0-4]$/i.test(l));
    if (ps.length !== 1) problems.push(`#${t.number} 优先级标签要恰好一个 P0~P4，现在是 ${ps.length ? ps.join('、') : '没有'}`);
    if (refs.includes(parent)) problems.push(`#${t.number} 的任务列表引用了讨论单 #${parent}，会被它挡住（Parent 要写成普通一行）`);
    if (refs.includes(t.number)) problems.push(`#${t.number} 依赖了自己`);
  }
  const cycle = findCycle(deps);
  if (cycle) problems.push(`开发单互相依赖成环：${cycle.map((n) => `#${n}`).join(' → ')}`);

  emit({
    status: 'ok',
    say: problems.length
      ? `#${parent} 的开发单回查不通过：${problems.length} 个问题`
      : `#${parent} 的开发单回查通过：${tickets.map((t) => `#${t.number}`).join('、')}`,
    data: { tickets: tickets.map(({ number, title }) => ({ number, title })), problems }
  });
});

function findCycle(deps) {
  const state = new Map();
  const stack = [];
  const visit = (n) => {
    if (state.get(n) === 'done') return null;
    if (state.get(n) === 'open') return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 'open');
    stack.push(n);
    for (const d of deps.get(n) ?? []) {
      if (d === n) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 'done');
    return null;
  };
  for (const n of deps.keys()) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}
