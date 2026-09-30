// session.mjs — 会话进出的纯函数（Core.md §10.1）
// 能力由 runner 的 sessionMode 给：'create-or-resume'（pi）/ 'resume'（codex）/ 'none'（cursor）

// 续不上：status failed + choice session_not_found，reason 写明哪家、哪个会话号
export function sessionNotFound(cli, session, why) {
  return {
    status: 'failed',
    choice: 'session_not_found',
    reason: `${cli} 续不上会话 ${session}${why ? `：${why}` : ''}`,
    data: {}
  };
}

// 开跑前就能判定续不上的情况：CLI 不支持续
export function precheckSession(cli, sessionMode, session) {
  if (session && sessionMode === 'none') return sessionNotFound(cli, session, '这家 CLI 不支持续会话');
  return null;
}

// CLI 失败时的错误文本像不像「会话不存在」
export function looksLikeSessionNotFound(text) {
  const s = String(text ?? '');
  return /\b(session|thread|rollout|conversation)\b[^\n]*\b(not found|does not exist|doesn't exist|no such|unknown|missing)\b/i.test(s)
    || /\bno (saved |matching )?(session|thread|rollout|conversation)s?\b[^\n]*\bfound\b/i.test(s)
    || /(会话|session)[^\n]*(不存在|找不到)/i.test(s);
}

// 交回的会话号：pi 续的就是给的那个；codex 取事件流里报的（续时同号），没报就用给的；cursor 不交回
export function sessionOut(sessionMode, given, seen) {
  if (sessionMode === 'create-or-resume') return given || '';
  if (sessionMode === 'resume') return seen || given || '';
  return '';
}
