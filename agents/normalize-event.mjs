// normalize-event.mjs — 三家 CLI 的 JSONL 事件归一成同一种形状
//   { kind: 'tool' | 'assistant' | 'assistant_partial' | 'thinking' | 'thinking_partial' | 'outcome' | 'error' | 'raw',
//     t, callId?, phase?: 'start' | 'done', toolName?, args?, result?, text?, payload }
// 输出事件上不出现是哪家 CLI。

export function normalizeEvent(raw, source) {
  if (!raw || typeof raw !== 'object') return { kind: 'raw', t: Date.now(), payload: raw };
  if (source === 'codex') return normalizeCodexEvent(raw);
  if (source === 'pi') return normalizePiEvent(raw);
  return normalizeCursorEvent(raw);
}

// ── cursor（stream-json）─────────────────────────────────────────────────

// readToolCall → read
function cursorToolName(raw) {
  const name = String(raw || 'unknown');
  return name.endsWith('ToolCall') ? name.slice(0, -'ToolCall'.length) : name;
}

function normalizeCursorEvent(ev) {
  const t = Date.now();
  const type = String(ev.type || '');

  if (type === 'thinking') {
    const text = typeof ev.text === 'string' ? ev.text : messageText(ev);
    const partial = ev.subtype === 'delta' || ev.subtype === 'partial';
    return { kind: partial ? 'thinking_partial' : 'thinking', t, text, payload: ev };
  }

  if (type === 'assistant') {
    const text = messageText(ev.message);
    const partial = ev.subtype === 'partial' || ev.partial === true;
    return { kind: partial ? 'assistant_partial' : 'assistant', t, text, payload: ev };
  }

  if (type === 'tool_call') {
    const toolCall = ev.tool_call && typeof ev.tool_call === 'object' ? ev.tool_call : {};
    const rawName = Object.keys(toolCall)[0] || 'unknown';
    // 工具体挂在原始键下（readToolCall / grepToolCall），不是短名
    const body = toolCall[rawName] && typeof toolCall[rawName] === 'object' ? toolCall[rawName] : {};
    return {
      kind: 'tool',
      t,
      callId: String(ev.call_id || ev.callId || ''),
      phase: ev.subtype === 'completed' ? 'done' : 'start',
      toolName: cursorToolName(rawName),
      args: body.args,
      result: body.result,
      payload: ev
    };
  }

  if (type === 'result') {
    return { kind: 'outcome', t, text: typeof ev.result === 'string' ? ev.result : '', payload: ev };
  }

  return { kind: 'raw', t, payload: ev };
}

// ── codex（exec --json）──────────────────────────────────────────────────

function normalizeCodexEvent(ev) {
  const t = Date.now();

  if (ev.msg && typeof ev.msg === 'object' && ev.msg.type === 'text' && ev.msg.content != null) {
    return { kind: 'assistant', t, text: String(ev.msg.content), payload: ev };
  }

  const method = String(ev.method || '');
  if (method.startsWith('item/')) {
    const item = ev.params?.item;
    if (item && typeof item === 'object') return codexItem(item, method.endsWith('completed') ? 'done' : 'start', t, ev);
  }

  const type = String(ev.type || '');
  if (type.startsWith('item.')) {
    const item = ev.item && typeof ev.item === 'object' ? ev.item : ev;
    return codexItem(item, type.includes('completed') ? 'done' : 'start', t, ev);
  }

  // codex 的错误走 stdout 事件流，不走 stderr
  if (type === 'error' || type === 'turn.failed') {
    return { kind: 'error', t, text: codexErrorText(ev.message ?? ev.error?.message), payload: ev };
  }

  return { kind: 'raw', t, payload: ev };
}

// message 常是一段 API 错误 JSON，取里面那句
function codexErrorText(message) {
  const s = String(message ?? '');
  try {
    return JSON.parse(s)?.error?.message ?? s;
  } catch {
    return s;
  }
}

function codexItem(item, phase, t, raw) {
  const itemType = String(item.type || '');
  const callId = String(item.id || item.item_id || '');

  if (itemType === 'agent_message' || itemType === 'agentMessage') {
    const text = String(item.text || item.content || '');
    return phase === 'done' && text ? { kind: 'assistant', t, text, payload: raw } : { kind: 'raw', t, payload: raw };
  }

  if (itemType === 'command_execution' || itemType === 'commandExecution') {
    return {
      kind: 'tool', t, callId, phase, toolName: 'shell',
      args: { command: item.command },
      result: phase === 'done'
        ? { exit_code: item.exit_code ?? item.exitCode, output: item.output ?? item.aggregated_output }
        : undefined,
      payload: raw
    };
  }

  if (itemType === 'file_change' || itemType === 'fileChange') {
    return {
      kind: 'tool', t, callId, phase, toolName: 'edit',
      args: { path: item.path ?? item.changes?.map((c) => c.path).join(', '), action: item.action },
      payload: raw
    };
  }

  if (itemType === 'mcp_tool_call' || itemType === 'mcpToolCall') {
    return {
      kind: 'tool', t, callId, phase,
      toolName: String(item.tool_name || item.toolName || item.tool || 'mcp'),
      args: item.arguments ?? item.args,
      result: phase === 'done' ? item.result : undefined,
      payload: raw
    };
  }

  if (itemType === 'reasoning') {
    return { kind: phase === 'done' ? 'thinking' : 'thinking_partial', t, text: String(item.text || ''), payload: raw };
  }

  if (itemType) return { kind: 'tool', t, callId, phase, toolName: itemType, args: item, payload: raw };
  return { kind: 'raw', t, payload: raw };
}

// ── pi（--mode json）─────────────────────────────────────────────────────

function normalizePiEvent(ev) {
  const t = Date.now();
  const type = String(ev.type || '');

  if (type === 'message_end') {
    const text = piMessageText(ev.message);
    return text ? { kind: 'assistant', t, text, payload: ev } : { kind: 'raw', t, payload: ev };
  }

  if (type === 'tool_execution_start' || type === 'tool_execution_end') {
    const start = type === 'tool_execution_start';
    return {
      kind: 'tool', t,
      callId: String(ev.toolCallId || ''),
      phase: start ? 'start' : 'done',
      toolName: String(ev.toolName || 'tool'),
      args: start ? ev.args : undefined,
      result: start ? undefined : ev.result,
      payload: ev
    };
  }

  // message_end 已经把这段话报过一次，这里只标记收尾
  if (type === 'turn_end' || type === 'agent_end') {
    const text = piMessageText(ev.message) || piAgentEndText(ev);
    if (text) return { kind: 'outcome', t, text, payload: ev };
  }

  return { kind: 'raw', t, payload: ev };
}

function piMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.role && message.role !== 'assistant') return '';
  if (typeof message.text === 'string' && message.text) return message.text;
  return messageText(message);
}

function piAgentEndText(ev) {
  if (!Array.isArray(ev.messages)) return '';
  for (let i = ev.messages.length - 1; i >= 0; i--) {
    const text = piMessageText(ev.messages[i]);
    if (text) return text;
  }
  return '';
}

function messageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (typeof msg.text === 'string') return msg.text;
  if (!Array.isArray(msg.content)) return '';
  return msg.content.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text || '') : '')).join('');
}

// ── 会话号 ───────────────────────────────────────────────────────────────
// 从原始事件里取本次会话号（只有 codex 在事件流里报）：thread.started 的 thread_id，旧版 session_configured 的 session_id
export function extractSessionFromRaw(raw, runner) {
  if (!raw || typeof raw !== 'object' || runner !== 'codex') return '';
  if (raw.type === 'thread.started' && raw.thread_id) return String(raw.thread_id);
  const msg = raw.msg && typeof raw.msg === 'object' ? raw.msg : raw;
  if (msg.type === 'session_configured' && msg.session_id) return String(msg.session_id);
  return '';
}

// ── 最后一条回话 ─────────────────────────────────────────────────────────
// 从原始事件里取「可能是最后回话」的文本；流里越靠后的越新
export function extractReplyFromRaw(raw, runner) {
  if (!raw || typeof raw !== 'object') return '';

  if (runner === 'cursor') {
    return raw.type === 'result' && typeof raw.result === 'string' ? raw.result : '';
  }

  if (runner === 'pi') {
    if (raw.type === 'message_end') return piMessageText(raw.message);
    if (raw.type === 'turn_end' || raw.type === 'agent_end') return piMessageText(raw.message) || piAgentEndText(raw);
    return '';
  }

  if (runner === 'codex' && String(raw.type || '').startsWith('item.')) {
    const item = raw.item;
    if (item && (item.type === 'agent_message' || item.type === 'agentMessage')) return String(item.text || item.content || '');
  }

  return '';
}
