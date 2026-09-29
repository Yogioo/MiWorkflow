// 跑一条验证命令，回 { code, tail }。退出码 0 算过。
// 入：{ cmd, cwd?, timeoutMs? }；cmd 是字符串（走 shell）或数组（精确到参数，不走 shell）
// 出：{ status, say, data: { code, tail } }
import { spawnSync } from 'node:child_process';
import { main, readStdin, emit } from './_lib.mjs';

await main(async () => {
  const args = await readStdin();
  if (!args.cmd) throw new Error('缺 cmd');
  const dir = args.cwd ?? process.cwd();
  const isArray = Array.isArray(args.cmd);
  const label = isArray ? args.cmd.join(' ') : String(args.cmd);

  if (args.dryRun) {
    emit({ status: 'ok', say: `干跑：会跑 ${label}`, data: { code: null, tail: '' } });
    return;
  }

  const r = spawnSync(isArray ? args.cmd[0] : args.cmd, isArray ? args.cmd.slice(1) : [], {
    cwd: dir,
    shell: !isArray,
    encoding: 'utf8',
    timeout: args.timeoutMs ?? 600_000,
    windowsHide: true
  });

  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tail = out.split('\n').slice(-40).join('\n');
  process.stderr.write(out);

  const code = r.status ?? (r.error ? -1 : 0);
  if (code === 0) {
    emit({ status: 'ok', say: `${label}：通过`, data: { code, tail } });
  } else {
    emit({
      status: 'failed',
      say: `${label}：失败（退出码 ${code}）`,
      error: r.error ? String(r.error.message) : `exit_${code}`,
      data: { code, tail }
    });
  }
});
