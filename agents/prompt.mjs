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

// 给裸键名补上双引号：只动 `{` 或 `,` 后面紧跟的 `标识符:`，字符串里的内容一个字节都不碰。
// 便宜模型偶尔把 `{status: "ok"}` 写成这样（#48），这是传输层写法问题，不是契约问题。
export function quoteBareKeys(text) {
  const s = String(text ?? '');
  let out = '';
  let inString = false;
  let escaped = false;
  let afterOpen = false; // 刚过了 `{` 或 `,`，这个位置允许出现裸键名
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      afterOpen = false;
      out += ch;
      continue;
    }
    if (ch === '{' || ch === ',') {
      afterOpen = true;
      out += ch;
      continue;
    }
    if (afterOpen) {
      if (/\s/.test(ch)) {
        out += ch;
        continue;
      }
      afterOpen = false;
      const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
      const colon = m && /^\s*:/.exec(s.slice(i + m[0].length));
      if (colon) {
        out += '"' + m[0] + '"' + colon[0];
        i += m[0].length + colon[0].length - 1; // for 的 i++ 会往前一格，这里退回去
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// 裸 `status` 键的廉价预筛（补引号只对能变成契约回话的候选有意义，别对整篇字反复扫）
const BARE_STATUS_KEY = /[{,]\s*status\s*:/;

// 能不能当契约回话：是 JSON 对象、且顶层有 status。返回归一后的文本，不是就 null。
// 只接受带 status 的：没有 status 的小对象不是回话（#48）。
function contractJson(text) {
  const t = String(text ?? '').trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const v = JSON.parse(t);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return Object.hasOwn(v, 'status') ? t : null;
  } catch {
    return null;
  }
}

// 从一段话里取最后一段能当契约回话的 JSON 对象（没有就 null）。
// 从后往前扫：先定右括号，再往前找能配平的左括号。键名没加引号的候选补一次引号再看。
// 取不到带 status 的就把原文交回让 core 判，不退到里面那段不带 status 的小对象（#48）。
export function extractJson(text) {
  const s = String(text ?? '');
  const whole = contractJson(s) ?? (BARE_STATUS_KEY.test(s) ? contractJson(quoteBareKeys(s)) : null);
  if (whole) return whole;
  for (let end = s.lastIndexOf('}'); end > 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.lastIndexOf('{', end); start >= 0; start = start > 0 ? s.lastIndexOf('{', start - 1) : -1) {
      const candidate = s.slice(start, end + 1).trim();
      const hit = contractJson(candidate)
        ?? (BARE_STATUS_KEY.test(candidate) ? contractJson(quoteBareKeys(candidate)) : null);
      if (hit) return hit;
    }
  }
  return null;
}

// 适配器回话归一（§10.1）：剥一层围栏；整段不是 JSON 就取最后一段带 status 的 JSON（裸键名补引号后也算）；
// 再没有就原样交回让 core 判（§6.2）。
// 只做传输层归一，不补字段、不猜形状。`extracted` 只用来在 stderr 说明一句。
export function normalizeReply(text) {
  const fenced = stripFence(text);
  if (isJsonObject(fenced)) return { text: fenced, extracted: false };
  const json = extractJson(fenced);
  return json ? { text: json, extracted: true } : { text: fenced, extracted: false };
}
