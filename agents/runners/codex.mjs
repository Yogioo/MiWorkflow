// codex.mjs — codex exec --json；提示词走 stdin，最后回话由 -o 写。
// 不用 --output-schema：它走严格模式，要求每个对象 additionalProperties:false，§6.2 的 data 是自由形状
import { spawnStreamTurn } from './spawn-turn.mjs';

export function buildCodexArgs(turn) {
  if (turn.provider) throw new Error('codex 不认 provider（只有 pi 认）');
  // 全权限（Core.md §10）。exec resume 不接受 -C / -s / --color：工作目录由 spawn 的 cwd 负责
  const args = turn.session
    ? ['exec', 'resume', String(turn.session), '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', turn.outFile, '--json']
    : ['exec', '-C', turn.workdir, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', turn.outFile, '--json', '--color', 'never'];
  if (turn.model) args.push('-m', turn.model);
  if (turn.thinking) args.push('-c', `model_reasoning_effort=${turn.thinking}`);
  args.push(...(turn.extraArgs ?? []));
  args.push('-'); // 从 stdin 读提示词
  return args;
}

export function createCodexRunner({ bin } = {}) {
  bin ||= process.env.CODEX_BIN || 'codex';
  return {
    name: 'codex',
    bin,
    // exec resume 只能续已有的 session，不能建
    sessionMode: 'resume',
    runTurn(turn) {
      return spawnStreamTurn({
        bin,
        runner: 'codex',
        workdir: turn.workdir,
        args: buildCodexArgs(turn),
        stdinText: turn.prompt,
        outFile: turn.outFile,
        logFile: turn.logFile,
        eventsFile: turn.eventsFile,
        writeOutFile: false,
        signal: turn.signal,
        onEvent: turn.onEvent
      });
    }
  };
}
