// cursor.mjs — Cursor CLI（agent）-p --output-format stream-json；提示词用「打开这个文件」的短指令喂入，
// 避开 Windows 命令行长度上限
import { spawnStreamTurn } from './spawn-turn.mjs';

// 思考等级折进模型的方括号参数：composer-2.5 + high → composer-2.5[effort=high]；已有 effort= 不覆盖
export function applyThinkingToModel(model, thinking) {
  const m = String(model || '').trim();
  const t = String(thinking || '').trim();
  if (!t || !m) return m;
  const bracket = m.match(/^([^[\]]+)\[(.*)\]\s*$/);
  if (!bracket) return `${m}[effort=${t}]`;
  const params = bracket[2].trim();
  if (/\beffort\s*=/.test(params)) return m;
  return `${bracket[1].trim()}[${params ? `${params},effort=${t}` : `effort=${t}`}]`;
}

export function buildCursorArgs(turn) {
  if (turn.provider) throw new Error('cursor 不认 provider（只有 pi 认）');
  if (turn.thinking && !turn.model) {
    throw new Error('cursor 的思考等级要折进模型名（model[effort=…]），只给 thinking 不给 model 没法用');
  }
  // 全权限（Core.md §10）：--force 放行命令，--approve-mcps 放行 MCP，--sandbox disabled
  const args = [
    '-p', '--output-format', 'stream-json',
    '--workspace', turn.workdir,
    '--trust', '--force', '--approve-mcps', '--sandbox', 'disabled'
  ];
  const model = applyThinkingToModel(turn.model, turn.thinking);
  if (model) args.push('--model', model);
  args.push(...(turn.extraArgs ?? []));
  args.push([
    `Open and follow every instruction in this file exactly: ${String(turn.promptFile).replace(/\\/g, '/')}`,
    'When finished, your final message must be only the JSON object required by those instructions (no extra prose).'
  ].join('\n'));
  return args;
}

export function createCursorRunner({ bin } = {}) {
  bin ||= process.env.CURSOR_AGENT_BIN || 'agent';
  return {
    name: 'cursor',
    bin,
    // 续会话接口没验证过：要续就报错，由调用方重建上下文
    sessionMode: 'none',
    runTurn(turn) {
      if (turn.session) throw new Error('cursor 不支持续会话（resume 接口未验证），请重建上下文');
      return spawnStreamTurn({
        bin,
        runner: 'cursor',
        workdir: turn.workdir,
        args: buildCursorArgs(turn),
        outFile: turn.outFile,
        logFile: turn.logFile,
        eventsFile: turn.eventsFile,
        signal: turn.signal,
        onEvent: turn.onEvent
      });
    }
  };
}
