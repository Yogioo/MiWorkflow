// pi.mjs — pi -p --mode json；提示词用 @promptFile 喂入。全权限：pi 在 -p 下不拦工具，不加 --exclude-tools
import { spawnStreamTurn } from './spawn-turn.mjs';

export function buildPiArgs(turn) {
  // 续会话时不能带 --no-session，否则那一轮不会落进原 session
  const args = turn.session
    ? ['-p', '--session-id', String(turn.session), '--mode', 'json']
    : ['-p', '--no-session', '--mode', 'json'];
  args.push('--approve');
  if (turn.provider) args.push('--provider', turn.provider);
  if (turn.model) args.push('--model', turn.model);
  if (turn.thinking) args.push('--thinking', turn.thinking);
  args.push(...(turn.extraArgs ?? []));
  args.push(`@${turn.promptFile}`);
  return args;
}

export function createPiRunner({ bin } = {}) {
  bin ||= process.env.PI_BIN || 'pi';
  return {
    name: 'pi',
    bin,
    // --session-id 有就续、没有就建
    sessionMode: 'create-or-resume',
    runTurn(turn) {
      return spawnStreamTurn({
        bin,
        runner: 'pi',
        workdir: turn.workdir,
        args: buildPiArgs(turn),
        outFile: turn.outFile,
        logFile: turn.logFile,
        eventsFile: turn.eventsFile,
        signal: turn.signal,
        onEvent: turn.onEvent
      });
    }
  };
}
