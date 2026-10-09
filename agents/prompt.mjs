// prompt.mjs — 适配器的纯函数：解析命令行、把 §10 任务包渲染成提示词、剥围栏
// 输出形状三家都靠提示词：codex 的 --output-schema 走严格模式，不允许 §6.2 里自由形状的 data

// agent_cli.mjs <cli> [--model m] [--thinking t] [--provider p] [--session s] [--check] [-- 其余开关原样给 CLI]
// --check：只校验配置、不干活（§10.1），不读 stdin、不起模型。
export function parseCliArgv(argv) {
  const [cli, ...rest] = argv;
  const out = { cli, model: '', thinking: '', provider: '', session: '', check: false, extraArgs: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      out.extraArgs = rest.slice(i + 1);
      break;
    }
    if (a === '--check') {
      out.check = true;
      continue;
    }
    const m = a.match(/^--(model|thinking|provider|session)(?:=(.*))?$/);
    if (!m) throw new Error(`不认识的开关：${a}（给 CLI 的其它开关放在 -- 后面）`);
    out[m[1]] = m[2] ?? rest[++i] ?? '';
  }
  return out;
}

export function renderPrompt(pkg) {
  const inputs = pkg.inputs ?? {};
  const choices = Array.isArray(inputs.choices) ? inputs.choices : null;
  const constraints = pkg.constraints ?? [];
  const budget = pkg.budget ?? {};
  const lines = ['# 目标', '', String(pkg.goal ?? ''), ''];

  if (Object.keys(inputs).length) {
    lines.push('# 输入', '', '```json', JSON.stringify(inputs, null, 2), '```', '');
  }
  if (constraints.length) {
    lines.push('# 约束', '', ...constraints.map((c) => `- ${c}`), '');
  }
  const hints = [];
  if (budget.maxTokens) hints.push(`约 ${budget.maxTokens} tokens`);
  if (budget.maxTurns) hints.push(`约 ${budget.maxTurns} 轮`);
  if (budget.timeoutSec) hints.push(`${budget.timeoutSec} 秒后会被强制结束`);
  if (budget.idleSec) {
    hints.push(`连续 ${budget.idleSec} 秒没有任何动静（包括一条命令迟迟不出输出）会被当成卡死、强制结束：` +
      '别跑全盘搜索（如 find /）这类可能很久不返回的命令，长命令自己加超时');
  }
  if (hints.length) lines.push('# 预算', '', hints.join('；'), '');

  lines.push(
    '# 输出契约',
    '',
    '需要改文件、跑命令就自己动手，不要把待执行的命令列给别人。',
    '做完后，最后一条消息只回一段 JSON，不要任何别的文字：',
    '',
    '{"status": "...", "choice": "...", "reason": "...", "data": {}}',
    '',
    '- `status` 只能是 `ok`（做完了）、`need_human`（要人拍板，`reason` 写清要问什么）、`failed`（做不成）',
    choices
      ? `- \`choice\` 只能取其中之一：${choices.map((c) => `\`${c}\``).join(' / ')}`
      : '- `choice`：一个简短的英文标识，表示你的结论',
    '- `reason`：一句给人看的话，陈述发生了什么',
    '- `data`：需要交回的结构化数据，没有就给 `{}`',
    ''
  );
  return lines.join('\n');
}

// 剥掉至多一层代码围栏；别的不动（合不合契约由 core 判，Core.md §6.2）
export function stripFence(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : s;
}

// 是不是一个 JSON 对象（数组 / 标量不算）
function isJsonObject(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return false;
  try {
    const v = JSON.parse(t);
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

// 从一段话里取最后一段能解析的 JSON 对象（没有就 null）。
// 从后往前扫：先定右括号，再往前找能配平的左括号。优先带 "status" 的，最像契约。
export function extractJson(text) {
  const s = String(text ?? '');
  if (isJsonObject(s)) return s.trim();
  let fallback = null;
  for (let end = s.lastIndexOf('}'); end > 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.lastIndexOf('{', end); start >= 0; start = start > 0 ? s.lastIndexOf('{', start - 1) : -1) {
      const candidate = s.slice(start, end + 1).trim();
      if (!isJsonObject(candidate)) continue;
      if (candidate.includes('"status"')) return candidate;
      fallback ??= candidate;
    }
  }
  return fallback;
}

// 适配器回话归一（§10.1）：剥一层围栏；整段不是 JSON 就取最后一段 JSON；再没有就原样交回让 core 判（§6.2）。
// 只做传输层归一，不补字段、不猜形状。`extracted` 只用来在 stderr 说明一句。
export function normalizeReply(text) {
  const fenced = stripFence(text);
  if (isJsonObject(fenced)) return { text: fenced, extracted: false };
  const json = extractJson(fenced);
  return json ? { text: json, extracted: true } : { text: fenced, extracted: false };
}
