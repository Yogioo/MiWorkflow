// index.mjs — 按名字取 runner
import { createPiRunner, buildPiArgs } from './pi.mjs';
import { createCodexRunner, buildCodexArgs } from './codex.mjs';
import { createCursorRunner, buildCursorArgs } from './cursor.mjs';
import { binExists, resolveBin } from './resolve-bin.mjs';

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
// 会话号由 opts.agent.session 传入（Core.md §10.1），怎么进出见 ../session.mjs
export function runnerSessionMode(name) {
  return createRunner(name).sessionMode;
}

// 这份配置合不合法（§10.1 的启动校验）：试建一次命令行，让各家自己的校验说话
// （唯一的事实来源——参数组合的规矩写在 build*Args 里，这里不另抄一份）。
// 返回不合法的说明；空数组 = 合法。名字不认识也在这里判。
export function runnerConfigProblems(name, spec = {}) {
  const cli = String(name ?? '').toLowerCase();
  if (!RUNNERS.includes(cli)) return [`不认识的 Agent CLI：${name}（可选：${RUNNERS.join(' / ')}）`];
  const turn = { workdir: '.', outFile: 'out', promptFile: 'prompt', prompt: 'prompt', ...spec };
  try {
    if (cli === 'pi') buildPiArgs(turn);
    else if (cli === 'codex') buildCodexArgs(turn);
    else buildCursorArgs(turn);
  } catch (err) {
    return [String(err?.message ?? err)];
  }
  return [];
}

// 这家的 CLI 在本机找不找得到（§10.1 的启动校验）：按「实际会用哪个 bin、怎么解析」查一遍。
// 返回找不到时的说明；空数组 = 找得到。
const BIN_ENV = { pi: 'PI_BIN', codex: 'CODEX_BIN', cursor: 'CURSOR_AGENT_BIN' };

export function runnerBinProblems(name) {
  const cli = String(name ?? '').toLowerCase();
  const bin = createRunner(cli).bin;
  if (binExists(resolveBin(bin, { knownName: cli }))) return [];
  return [`本机找不到 ${cli} 的命令 ${bin}：不在 PATH 上，也不是已知的安装位置；装好它，或用 ${BIN_ENV[cli]} 指到它`];
}
