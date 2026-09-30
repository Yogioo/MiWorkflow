// TAPD 工单源的测试支撑：假 tapd-cli（MIWORKFLOW_TAPD）+ 假 OpenAPI（TAPD_API_ENDPOINT），共用一份状态 JSON。
// 真实网络不进测试。
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_TAPD = path.join(HERE, 'fake-tapd-cli.mjs');
export const FAKE_OPENAPI = path.join(HERE, 'fake-tapd-openapi.mjs');
export const FAKE_TOKEN = '0123456789abcdef0123456789abcdef';

export const story = (id, { name = `story ${id}`, label = '', priority = '', description = `<p>做 ${id}</p>`, status = 'open', owner = 'bot', workspace_id = '1000' } = {}) => ({
  id: String(id), name, label, priority, description, status, owner, workspace_id
});

// files：{ '/tfl/…': base64 }，假 OpenAPI 在 /files/tfl/… 上给出这些字节（get-image 换出来的下载地址）
export function writeTapdState(file, { stories = [], comments = [], files, fail } = {}) {
  writeFileSync(file, JSON.stringify({ stories, comments, ...(files ? { files } : {}), ...(fail ? { fail } : {}), calls: [] }, null, 2));
}

export const readTapdState = (file) => JSON.parse(readFileSync(file, 'utf8'));

export const openApiLog = (file) => {
  try { return readFileSync(`${file}.openapi.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

// 起假 OpenAPI（独立进程），出 { endpoint, close }
export function startFakeOpenApi(stateFile, token = FAKE_TOKEN) {
  const child = spawn(process.execPath, [FAKE_OPENAPI, stateFile, token], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  return new Promise((resolve, reject) => {
    let buf = '';
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`假 OpenAPI 提前退出：${code}`)));
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /listening (\d+)/.exec(buf);
      if (!m) return;
      child.removeAllListeners('exit');
      resolve({
        endpoint: `http://127.0.0.1:${m[1]}`,
        close: () => new Promise((r) => { child.once('exit', r); child.kill(); })
      });
    });
  });
}

// 给被测进程的环境变量
export const tapdEnv = (stateFile, endpoint, token = FAKE_TOKEN) => ({
  MIWORKFLOW_TAPD: FAKE_TAPD,
  FAKE_TAPD_STATE: stateFile,
  ...(endpoint ? { TAPD_API_ENDPOINT: endpoint, TAPD_TOKEN: token } : {})
});
