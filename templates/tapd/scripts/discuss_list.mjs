// 工单源接口：列要处理的讨论单（TAPD 实现）。
// 只看标签：贴了 agent-discuss，且阶段标签（discuss:*）为空或是 grilling / spec。
// TAPD 没有「打开 / 关闭」这个开关（状态是人验收后自己流转的），所以讨论单结束时靠阶段标签（ticketed）或摘掉 agent-discuss 来退出。
// 入：{ enter, grilling, spec }
// 出：{ status, say, data: { items: [{ id, ref, title, labels }] } }
import { main, readStdin, emit } from './_lib.mjs';
import { tapdJson, labelsOf } from './_tapd.mjs';
import { WORKSPACE_ID, refOf } from '../source.mjs';

const LIST_LIMIT = 200;
const byId = (a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

await main(async () => {
  const args = await readStdin();
  const enter = args.enter ?? 'agent-discuss';
  const ok = new Set([args.grilling ?? 'discuss:grilling', args.spec ?? 'discuss:spec'].map((l) => l.toLowerCase()));

  const listed = tapdJson(['story', 'list', `label=${enter}`, `limit=${LIST_LIMIT}`, ...(WORKSPACE_ID ? [`workspace_id=${WORKSPACE_ID}`] : [])]);
  const items = (Array.isArray(listed.data) ? listed.data : [])
    .map((r) => r?.Story).filter((s) => s && s.id != null && String(s.id).trim())
    .map((s) => {
      const id = String(s.id).trim();
      return { id, ref: refOf(id), title: s.name || id, labels: labelsOf(s) };
    })
    .filter((i) => i.labels.some((l) => l.toLowerCase() === enter.toLowerCase()))
    .filter((i) => i.labels.filter((l) => /^discuss:/i.test(l)).every((l) => ok.has(l.toLowerCase())))
    .sort(byId);

  emit({
    status: 'ok',
    say: items.length ? `讨论单 ${items.length} 张：${items.map((i) => i.ref).join('、')}` : '没有讨论单',
    data: { items }
  });
});
