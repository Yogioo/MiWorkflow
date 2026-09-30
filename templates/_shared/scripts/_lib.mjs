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

// 脚本外壳：出错也回一个合法的 failed（§6.1），别让 core 只能从 stderr 猜。
// 错误带 transient（工单系统暂时不可用，重试已用完）就在 data 里标 transient: true，调用方据此停下而不是记失败（Core §15）
export async function main(handler) {
  try {
    await handler();
  } catch (err) {
    const message = String(err?.message ?? err);
    const transient = err?.transient === true;
    process.stdout.write(JSON.stringify({
      status: 'failed',
      say: `${transient ? '工单系统暂时不可用' : '出错了'}：${message.split('\n')[0]}`,
      error: message,
      ...(transient ? { data: { transient: true } } : {})
    }));
  }
}

// 按魔数定图片扩展名（有的图扩展名写 .png、内容其实是 jpeg，读图工具认内容）；认不出给 bin
export function imageExt(buf) {
  const b = Buffer.from(buf ?? []);
  const at = (i, bytes) => bytes.every((v, k) => b[i + k] === v);
  if (at(0, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'jpg';
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  if (at(0, [0x42, 0x4d])) return 'bmp';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg\b/i.test(b.subarray(0, 512).toString('utf8'))) return 'svg';
  return 'bin';
}

// ── git ───────────────────────────────────────────────────────────────────
export function git(argv, cwd) {
  return execFileSync('git', argv, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
}
