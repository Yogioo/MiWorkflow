#!/usr/bin/env node
// guard.mjs — 内核护栏（§14.1）
//
// 可写面：logs/ examples/ —— 随便改，不算数。沉淀（tasks/ scripts/）不在内核仓库，在 HOME（§3）。
// 内核  ：其余全部        —— 改了就得有人跑 approve 重新固化，
//                            否则 node --test 变红，run.mjs 也拒跑。
//
// 它拦的不是「恶意」，是「静默」：Agent 有写权限，想绕总能绕。
// 它保证的是：内核每次变动，都留下一条人写的理由和一条可回滚的 Git 记录。
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOCK = path.join(ROOT, 'core.lock.json');

// 可写面（§16：内核零业务）。内核根下冒出 tasks/ scripts/ 会被当成内核改动拦下
const WRITABLE_DIRS = new Set(['logs', 'examples']);
const SKIP_DIRS = new Set(['node_modules', '.git', ...WRITABLE_DIRS]);
// core.lock.json 不能进内核（哈希会自指）；.gitignore 从不被 npm pack 打包，
// 算进内核的话，装进业务仓库 node_modules 的那份永远判脏、run.mjs 永远拒跑
const skipFile = (name) => name === 'core.lock.json' || name === '.gitignore';

// ── 内核清单 ───────────────────────────────────────────────────────────────

export function coreFiles(dir = ROOT, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    if (skipFile(name)) continue;
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      coreFiles(abs, acc);
    } else {
      acc.push(path.relative(ROOT, abs).split(path.sep).join('/'));
    }
  }
  return acc;
}

// 换行归一化后再哈希：Windows 上检出成 CRLF 不该算「内核被改」（§11 跨平台优先）
export function hashFile(rel) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function computeCore() {
  const files = {};
  for (const rel of coreFiles()) files[rel] = hashFile(rel);
  return files;
}

export function loadLock() {
  if (!existsSync(LOCK)) return null;
  try {
    return JSON.parse(readFileSync(LOCK, 'utf8'));
  } catch {
    return null;
  }
}

export function diffCore(sealed, actual) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [f, h] of Object.entries(actual)) {
    if (!(f in sealed)) added.push(f);
    else if (sealed[f] !== h) changed.push(f);
  }
  for (const f of Object.keys(sealed)) if (!(f in actual)) removed.push(f);
  return { changed, added, removed };
}

// 唯一的判定入口：测试与 CLI 都走这里，避免两边规则漂移
export function inspect() {
  const lock = loadLock();
  const actual = computeCore();
  if (!lock) return { ok: false, reason: 'no_lock', lock: null, actual, diff: null };
  const diff = diffCore(lock.files ?? {}, actual);
  const dirty = diff.changed.length + diff.added.length + diff.removed.length;
  return { ok: dirty === 0, reason: dirty === 0 ? 'clean' : 'dirty', lock, actual, diff };
}

export function describe(diff) {
  const lines = [];
  if (diff.changed.length) lines.push(`  改了：${diff.changed.join('、')}`);
  if (diff.added.length) lines.push(`  新增：${diff.added.join('、')}`);
  if (diff.removed.length) lines.push(`  删除：${diff.removed.join('、')}`);
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────

function confirm(prompt) {
  process.stderr.write(`\n⏸ ${prompt} [y/N] `);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', (d) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(String(d).trim()));
    });
  });
}

function reasonOf(argv) {
  const inline = argv.find((a) => a.startsWith('--reason='));
  if (inline) return inline.slice('--reason='.length).trim();
  const i = argv.indexOf('--reason');
  return i >= 0 ? String(argv[i + 1] ?? '').trim() : '';
}

function cmdCheck() {
  const r = inspect();
  if (r.ok) {
    console.log(`✔ 内核已固化：${Object.keys(r.actual).length} 个文件与 core.lock.json 一致`);
    return 0;
  }
  if (r.reason === 'no_lock') {
    console.error('✖ 没有 core.lock.json：内核从未被审批过。');
    console.error('  请在终端跑：node guard.mjs approve --reason "为什么改内核"');
    return 1;
  }
  console.error('✖ 内核被改了，但没有审批记录（§14.1）：');
  console.error(describe(r.diff));
  console.error('  内核改动必须有人在场确认：');
  console.error('  node guard.mjs approve --reason "为什么改内核"');
  return 1;
}

async function cmdApprove(argv) {
  const reason = reasonOf(argv);
  if (!reason) {
    console.error('✖ approve 必须给理由：--reason "为什么改内核"');
    return 1;
  }
  // 审批必须在人在场时发生。Agent 通常在管道里跑，拿不到 TTY，所以过不来。
  if (!process.stdin.isTTY) {
    console.error('✖ 内核审批必须有人在终端：当前 stdin 不是 TTY，拒绝。');
    return 1;
  }

  const actual = computeCore();
  const lock = loadLock();
  if (lock) {
    const diff = diffCore(lock.files ?? {}, actual);
    if (diff.changed.length + diff.added.length + diff.removed.length === 0) {
      console.log('✔ 内核与固化记录一致，无事可做。');
      return 0;
    }
    console.log('本次要固化的内核改动：');
    console.log(describe(diff));
  } else {
    console.log(`首次固化内核：${Object.keys(actual).length} 个文件`);
  }

  if (!(await confirm(`确认固化内核？理由：${reason}`))) {
    console.log('已取消，内核未变更。');
    return 1;
  }

  writeFileSync(
    LOCK,
    JSON.stringify(
      {
        version: 1,
        approvedAt: new Date().toISOString(),
        approvedBy: 'human',
        reason,
        files: actual
      },
      null,
      2
    ) + '\n'
  );
  console.log(`✔ 已固化 ${Object.keys(actual).length} 个文件 → core.lock.json`);
  return 0;
}

function cmdInstall() {
  if (!existsSync(path.join(ROOT, '.git'))) {
    console.error('✖ 这里不是 git 仓库，装不了 pre-commit。');
    return 1;
  }
  const hook = path.join(ROOT, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nnode "$(dirname "$0")/../../guard.mjs" check\n', { mode: 0o755 });
  console.log(`✔ 已装 pre-commit：${hook}`);
  console.log('  之后内核未审批的改动会在 git commit 时被拦下（--no-verify 可绕，但那是显式的）。');
  return 0;
}

async function main() {
  const [cmd = 'check', ...argv] = process.argv.slice(2);
  const code =
    cmd === 'approve' ? await cmdApprove(argv)
    : cmd === 'install' ? cmdInstall()
    : cmd === 'check' ? cmdCheck()
    : (console.error(`usage: node guard.mjs [check|approve --reason "..."|install]`), 1);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
