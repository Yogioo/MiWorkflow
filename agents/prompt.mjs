// prompt.mjs — 适配器的纯函数：解析命令行、把 §10 任务包渲染成提示词、剥围栏
// 输出形状三家都靠提示词：codex 的 --output-schema 走严格模式，不允许 §6.2 里自由形状的 data

// agent_cli.mjs <cli> [--model m] [--thinking t] [--provider p] [-- 其余开关原样给 CLI]
export function parseCliArgv(argv) {
  const [cli, ...rest] = argv;
  const out = { cli, model: '', thinking: '', provider: '', extraArgs: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      out.extraArgs = rest.slice(i + 1);
      break;
    }
    const m = a.match(/^--(model|thinking|provider)(?:=(.*))?$/);
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
