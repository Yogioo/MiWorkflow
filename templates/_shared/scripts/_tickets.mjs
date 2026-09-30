// 讨论流程拆单的共用部分：Agent 交回的 `data.tickets` 结构是两家的公共契约（Core.md §15），
// 校验与依赖排序只有一份，建单本身各工单源自己写。
// 这是模板内容，复制进项目后归项目所有。

// 优先级：P0~P4，认不出就当 P2
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'];
export const priorityOf = (raw) => {
  const m = /^P([0-4])$/i.exec(String(raw ?? '').trim());
  return m ? `P${m[1]}` : 'P2';
};

// 把 Agent 交回的东西规整成内部形状；结构不对就抛错（任务会判成「输出不合契约」）
export function normalizeTickets(raw) {
  if (!Array.isArray(raw) || !raw.length) throw new Error('tickets 要是非空数组');
  const tickets = raw.map((t, i) => ({
    key: String(t?.key ?? `t${i + 1}`),
    title: String(t?.title ?? '').trim(),
    body: String(t?.body ?? '').trim(),
    priority: priorityOf(t?.priority),
    review: t?.review === true,
    blockedBy: (Array.isArray(t?.blockedBy) ? t.blockedBy : []).map(String)
  }));
  const noTitle = tickets.filter((t) => !t.title);
  if (noTitle.length) throw new Error(`开发单缺 title：${noTitle.map((t) => t.key).join('、')}`);
  const dup = tickets.map((t) => t.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dup.length) throw new Error(`开发单 key 重了：${[...new Set(dup)].join('、')}`);
  return tickets;
}

// 依赖顺序：被依赖的先建。成环、依赖自己、指向不认识的 key 都进 problems（此时不建任何一张）
export function orderTickets(tickets) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const problems = [];
  for (const t of tickets) {
    for (const k of t.blockedBy ?? []) {
      if (k === t.key) problems.push(`开发单 ${t.key} 依赖了自己`);
      else if (!byKey.has(k)) problems.push(`开发单 ${t.key} 依赖了不认识的 key：${k}`);
    }
  }
  const state = new Map();
  const out = [];
  const stack = [];
  const visit = (t) => {
    if (state.get(t.key) === 'done') return true;
    if (state.get(t.key) === 'open') {
      problems.push(`开发单互相依赖成环：${[...stack.slice(stack.indexOf(t.key)), t.key].join(' → ')}`);
      return false;
    }
    state.set(t.key, 'open');
    stack.push(t.key);
    for (const k of t.blockedBy ?? []) {
      const dep = byKey.get(k);
      if (dep && !visit(dep)) return false;
    }
    stack.pop();
    state.set(t.key, 'done');
    out.push(t);
    return true;
  };
  for (const t of tickets) if (!visit(t)) break;
  return { ordered: problems.length ? [] : out, problems: [...new Set(problems)] };
}

// 回查用：开发单之间有没有成环（键是工单号，值是它依赖的工单号）
export function findCycle(deps) {
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
