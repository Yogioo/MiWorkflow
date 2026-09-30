// spawn-turn.mjs — 起一轮 CLI：stdout 是 JSONL 事件流，归一后逐行写 eventsFile，原始输出 tee 进 logFile
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, writeFileSync } from 'node:fs';
import { resolveBin } from './resolve-bin.mjs';
import { normalizeEvent, extractReplyFromRaw, extractSessionFromRaw } from '../normalize-event.mjs';

// 杀整棵进程树（Windows：taskkill /T；其它：进程组）
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch { /* 已退出 */ }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch { /* 已退出 */ }
  }
}

// 半行留到下一块；不是 JSON 的行跳过
export function parseJsonlChunk(chunkText, remainder, runner) {
  const lines = (remainder + chunkText).split('\n');
  const nextRemainder = lines.pop() || '';
  const rawEvents = [];
  let reply = '';
  let session = '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      rawEvents.push(raw);
      reply = extractReplyFromRaw(raw, runner) || reply;
      session = extractSessionFromRaw(raw, runner) || session;
    } catch { /* 非 JSON 行 */ }
  }
  return { remainder: nextRemainder, rawEvents, reply, session };
}

/**
 * @param {object} req
 * @param {string} req.bin
 * @param {'pi' | 'codex' | 'cursor'} req.runner
 * @param {string} req.workdir
 * @param {string[]} req.args
 * @param {string} [req.stdinText]
 * @param {string} req.outFile       最后回话；writeOutFile=false 时由 CLI 自己写（codex -o）
 * @param {string} req.logFile
 * @param {string} req.eventsFile
 * @param {boolean} [req.writeOutFile]
 * @param {AbortSignal} [req.signal] abort → 杀整棵进程树
 * @param {(ev: object) => void} [req.onEvent]
 * @returns {Promise<{ code: number, aborted?: boolean, stderr: string, error: string, session: string }>}
 *   error：事件流里最后一条错误事件的文本（codex 的错误不走 stderr）
 *   session：事件流里报出的会话号（只有 codex 报），没有就是空串
 */
export function spawnStreamTurn(req) {
  const { bin, runner, workdir, args, stdinText, outFile, logFile, eventsFile, writeOutFile = true, signal, onEvent } = req;
  const resolved = resolveBin(bin, { knownName: runner });

  return new Promise((resolve, reject) => {
    const logStream = createWriteStream(logFile, { flags: 'w' });
    logStream.write(`$ ${resolved.display} ${args.join(' ')}\n\n`);

    let remainder = '';
    let reply = '';
    let stderr = '';
    let error = '';
    let session = '';

    const child = spawn(resolved.command, [...resolved.argsPrefix, ...args], {
      cwd: workdir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: resolved.shell,
      // 非 Windows：自成进程组，abort 时连孙进程一起杀
      detached: process.platform !== 'win32'
    });

    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      killTree(child);
      logStream.end();
      resolve({ code: 124, aborted: true, stderr, error, session });
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const ingest = (parsed) => {
      remainder = parsed.remainder;
      reply = parsed.reply || reply;
      session = parsed.session || session;
      for (const raw of parsed.rawEvents) {
        const ev = normalizeEvent(raw, runner);
        if (ev.kind === 'error' && ev.text) error = ev.text;
        appendFileSync(eventsFile, JSON.stringify(ev) + '\n');
        onEvent?.(ev);
      }
    };

    child.stdout.on('data', (d) => {
      logStream.write(d);
      ingest(parseJsonlChunk(d.toString('utf8'), remainder, runner));
    });
    child.stderr.on('data', (d) => {
      logStream.write(d);
      stderr = (stderr + d).slice(-4000);
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      logStream.end();
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (remainder.trim()) ingest(parseJsonlChunk('\n', remainder, runner));
      if (writeOutFile) writeFileSync(outFile, reply);
      logStream.end();
      resolve({ code: code ?? 1, stderr, error, session });
    });

    if (stdinText != null) child.stdin.write(stdinText);
    child.stdin.end();
  });
}
