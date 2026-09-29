// index.mjs — 按名字取 runner
import { createPiRunner } from './pi.mjs';
import { createCodexRunner } from './codex.mjs';
import { createCursorRunner } from './cursor.mjs';

export const RUNNERS = ['pi', 'codex', 'cursor'];

export function createRunner(name, opts = {}) {
  switch (String(name || '').toLowerCase()) {
    case 'pi': return createPiRunner(opts);
    case 'codex': return createCodexRunner(opts);
    case 'cursor': return createCursorRunner(opts);
    default: throw new Error(`不认识的 Agent CLI：${name}（可选：${RUNNERS.join(' / ')}）`);
  }
}

// 续会话能力：'create-or-resume'（pi）/ 'resume'（codex，只能续）/ 'none'（cursor）。
// v1.7 不开放续会话（Core.md §19.2），留着以后接 inputs.session
export function runnerSessionMode(name) {
  return createRunner(name).sessionMode;
}
