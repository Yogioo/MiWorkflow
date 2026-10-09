// resolve-bin.mjs — Windows 上把 npm 全局命令的包装脚本解析成直接 `node <js>` 起进程
// （*.cmd / *.ps1 配管道 stdio 在新版 Node 上常见 EINVAL）
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const KNOWN_JS = {
  codex: ['@openai', 'codex', 'bin', 'codex.js'],
  pi: ['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js']
};

function appDataNpmJs(parts) {
  return process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules', ...parts) : '';
}

// cursor-agent 版本目录名 YYYY.MM.DD[-HH-MM-SS]-hash → 可排序整数
function cursorVersionKey(name) {
  const parts = String(name).split('-')[0].split('.');
  if (parts.length !== 3) return 0;
  const [y, m, d] = parts;
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return 0;
  return Number(y + m.padStart(2, '0') + d.padStart(2, '0'));
}

// 优先 %LOCALAPPDATA%/cursor-agent/versions/<最新>/{node.exe,index.js}，绕开 PowerShell 包装
function resolveCursorInstall() {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'cursor-agent') : '';
  if (!base || !existsSync(base)) return null;

  const direct = (dir) => {
    const node = path.join(dir, 'node.exe');
    const index = path.join(dir, 'index.js');
    return existsSync(node) && existsSync(index) ? { command: node, argsPrefix: [index], shell: false } : null;
  };
  const root = direct(base);
  if (root) return root;

  let dirs = [];
  try {
    dirs = readdirSync(path.join(base, 'versions'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && cursorVersionKey(d.name) > 0)
      .map((d) => d.name)
      .sort((a, b) => cursorVersionKey(b) - cursorVersionKey(a));
  } catch {
    return null;
  }
  for (const name of dirs) {
    const hit = direct(path.join(base, 'versions', name));
    if (hit) return hit;
  }
  return null;
}

export function resolveBin(bin, { knownName = '' } = {}) {
  const raw = String(bin || '').trim();
  const display = raw;

  if (/\.m?js$/i.test(raw)) {
    return { command: process.execPath, argsPrefix: [path.resolve(raw)], shell: false, display };
  }

  if (process.platform === 'win32') {
    const bare = !/[\\/]/.test(raw) && !/\.(cmd|exe|bat|ps1)$/i.test(raw);
    const baseName = raw.replace(/\\/g, '/').split('/').pop().replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();

    const knownParts = KNOWN_JS[knownName] || KNOWN_JS[baseName];
    const guess = knownParts ? appDataNpmJs(knownParts) : '';
    if (guess && existsSync(guess)) {
      return { command: process.execPath, argsPrefix: [guess], shell: false, display };
    }

    if (knownName === 'cursor' || baseName === 'agent' || baseName === 'cursor-agent') {
      const cursor = resolveCursorInstall();
      if (cursor) return { ...cursor, display };
    }

    if (bare || /\.(cmd|bat|ps1)$/i.test(raw)) {
      return { command: bare ? `${raw}.cmd` : raw.replace(/\.ps1$/i, '.cmd'), argsPrefix: [], shell: true, display };
    }
  }

  return { command: raw, argsPrefix: [], shell: false, display };
}

// 这个解析结果在本机起不起来（§10.1 的启动校验）：命令带路径就看文件在不在，
// 裸名字按 PATH（Windows 再拼 PATHEXT）找。只用来提前说清「装没装」，起不起得来仍以 spawn 为准。
export function binExists(resolved) {
  const { command, argsPrefix = [] } = resolved;
  if (/[\\/]/.test(command)) {
    if (!isFile(command)) return false;
    return argsPrefix.every((a) => !/[\\/]/.test(a) || isFile(a));
  }
  return findOnPath(command);
}

function findOnPath(name) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (isFile(path.join(dir, name + ext))) return true;
    }
  }
  return false;
}

function isFile(file) {
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  if (process.platform === 'win32') return true;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
