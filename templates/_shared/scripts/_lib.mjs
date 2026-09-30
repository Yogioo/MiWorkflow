// 模板共用工具：stdin/stdout 契约（Core §6.1）、git 调用。工单系统相关的助手在各工单源里（如 GitHub 的 _gh.mjs）。
// 这是模板内容，复制进项目后归项目所有。
import { execFileSync } from 'node:child_process';

// stdin 读一段 JSON；空输入当 {}
export async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw.trim() ? JSON.parse(raw) : {};
}

export function emit(result) {
  process.stdout.write(JSON.stringify(result));
}

// 脚本外壳：出错也回一个合法的 failed（§6.1），别让 core 只能从 stderr 猜
export async function main(handler) {
  try {
    await handler();
  } catch (err) {
    const message = String(err?.message ?? err);
    process.stdout.write(JSON.stringify({
      status: 'failed',
      say: `出错了：${message.split('\n')[0]}`,
      error: message
    }));
  }
}

// ── git ───────────────────────────────────────────────────────────────────
export function git(argv, cwd) {
  return execFileSync('git', argv, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
}
