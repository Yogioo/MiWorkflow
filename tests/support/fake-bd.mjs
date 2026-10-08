// 假的 bd：以 FAKE_BD_STATE 里的 JSON 为后端，经 MIWORKFLOW_BD 注入（node 本文件 <参数…>）。
// 状态：{ issues: [{ id, title, description, status, priority, issue_type, labels, dependencies: [{ depends_on_id, type }], parent?,
//                    design?, acceptance_criteria?, notes?, close_reason?, comments: [{ id, author, text, created_at }] }],
//         fail?: { times, message }, calls: [argv…] }
// 像真 bd（1.1.2）一样：list 只列没关的单、缺省 50 条；show 出一个元素的数组、不带评论、依赖写成前置单本身 { id, dependency_type }；
// 摘没贴的标签不报错；找不到单退出码 1；create --parent 不带 --no-inherit-labels 就继承父单的标签。
// 新单 ID 顺着已有的数字往下编（真 bd 的子单是 <父>.N，这里为了让场景按小编号对上，不照抄）。
import { readFileSync, writeFileSync } from 'node:fs';

const STATE = process.env.FAKE_BD_STATE;
let argv = process.argv.slice(2);
const state = JSON.parse(readFileSync(STATE, 'utf8'));
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const out = (v) => process.stdout.write(JSON.stringify(v, null, 2));
const die = (m) => { save(); process.stderr.write(m + '\n'); process.exit(1); };

state.calls = (state.calls ?? []).concat([argv]);
save();
let actor = 'bot';
if (argv[0] === '--actor') { actor = argv[1]; argv = argv.slice(2); }
if (state.fail?.times > 0) {
  state.fail.times--;
  die(state.fail.message ?? 'database is locked');
}

const json = argv.includes('--json');
const args = argv.filter((a) => a !== '--json');
const flag = (...names) => { for (const n of names) if (args.includes(n)) return args[args.indexOf(n) + 1]; return undefined; };
const find = (id) => state.issues.find((i) => i.id === id) ?? die(`Error: no issue found matching "${id}"`);
const listShape = ({ comments, ...i }) => ({ ...i, comment_count: (comments ?? []).length });
const showShape = (i) => ({
  ...listShape(i),
  dependencies: (i.dependencies ?? []).map((d) => ({
    id: d.depends_on_id, title: state.issues.find((x) => x.id === d.depends_on_id)?.title ?? '', dependency_type: d.type
  }))
});
const now = () => `2026-01-01T00:00:${String((state.calls.length % 60)).padStart(2, '0')}Z`;
const [cmd, sub] = args;

if (cmd === 'list') {
  const limit = Number(flag('--limit', '-n') ?? 50);
  const label = flag('--label', '-l');
  const rows = state.issues.filter((i) => i.status !== 'closed' && (!label || (i.labels ?? []).includes(label))).map(listShape);
  out(limit ? rows.slice(0, limit) : rows);
} else if (cmd === 'show') {
  out([showShape(find(sub))]);
} else if (cmd === 'create') {
  const parent = flag('--parent');
  const labels = String(flag('-l', '--labels') ?? '').split(',').filter(Boolean);
  // alwaysInherit：故障开关，不管 --no-inherit-labels 照样继承（测回查）
  if (parent && (state.alwaysInherit || !args.includes('--no-inherit-labels'))) for (const l of find(parent).labels ?? []) if (!labels.includes(l)) labels.push(l);
  const prefix = state.issues[0]?.id.replace(/-.*$/, '') ?? 'demo';
  const n = Math.max(0, ...state.issues.map((i) => Number(/^[^-]+-(\d+)$/.exec(i.id)?.[1] ?? 0))) + 1;
  const file = flag('--body-file');
  const issue = {
    id: `${prefix}-${n}`, title: flag('--title') ?? args[1], description: file ? readFileSync(file, 'utf8') : (flag('-d', '--description') ?? ''),
    status: 'open', priority: Number(String(flag('-p', '--priority') ?? '2').replace(/^P/i, '')), issue_type: 'task', labels,
    dependencies: parent ? [{ issue_id: `${prefix}-${n}`, depends_on_id: parent, type: 'parent-child' }] : [],
    ...(parent ? { parent } : {}), comments: []
  };
  state.issues.push(issue);
  save();
  if (json) out(listShape(issue)); else process.stdout.write(`✓ Created issue: ${issue.id}\n`);
} else if (cmd === 'dep' && sub === 'add') {
  const i = find(args[2]);
  find(args[3]);
  i.dependencies = (i.dependencies ?? []).concat([{ issue_id: i.id, depends_on_id: args[3], type: 'blocks' }]);
  save();
  process.stdout.write(`✓ Added dependency: ${i.id} depends on ${args[3]} (blocks)\n`);
} else if (cmd === 'comments' && sub === 'add') {
  const i = find(args[2]);
  const file = flag('-f', '--file');
  const text = file ? readFileSync(file, 'utf8') : args[3];
  i.comments = (i.comments ?? []).concat([{ id: `c${(i.comments ?? []).length + 1}`, author: actor, text, created_at: now() }]);
  save();
  if (json) out(i.comments.at(-1)); else process.stdout.write(`Comment added to ${i.id}\n`);
} else if (cmd === 'comments') {
  out(find(sub).comments ?? []);
} else if (cmd === 'label' && (sub === 'add' || sub === 'remove')) {
  const i = find(args[2]);
  const name = args[3];
  i.labels = i.labels ?? [];
  if (sub === 'add' && !i.labels.includes(name)) i.labels.push(name);
  if (sub === 'remove') i.labels = i.labels.filter((l) => l !== name);
  save();
  process.stdout.write(`✓ ${sub === 'add' ? 'Added' : 'Removed'} label '${name}' ${sub === 'add' ? 'to' : 'from'} ${i.id}\n`);
} else if (cmd === 'update') {
  const i = find(sub);
  if (flag('--status')) i.status = flag('--status');
  const file = flag('--body-file');
  if (file) {
    const text = readFileSync(file, 'utf8');
    if (!text.trim() && !args.includes('--allow-empty-description')) die('Error: refusing to replace description with empty content');
    i.description = text;
  }
  save();
  if (json) out([listShape(i)]); else process.stdout.write(`✓ Updated issue: ${i.id}\n`);
} else if (cmd === 'close') {
  const i = find(sub);
  i.status = 'closed';
  i.close_reason = flag('--reason') ?? '';
  save();
  if (json) out([listShape(i)]); else process.stdout.write(`✓ Closed ${i.id}\n`);
} else {
  die(`fake bd 不认：${argv.join(' ')}`);
}
