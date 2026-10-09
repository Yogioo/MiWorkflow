// 省着查：工单系统有调用额度（TAPD 个人令牌 2000 次 / 24 小时），别把调用花在「有没有新东西」上。
//
// 所有调用方共用一份记账：logs/<name>.pace.json。**退避对所有调用方生效，单跑也读**——
// 只管自动循环（--every，内核给每一轮设 AGENTFLOW_LOOP_PID）的话，外面套一层 while 反复单跑
// 就能把额度烧光，每轮都是实打实一次查询。
//
// 节奏：间隔 = 距上次有动静的时间 ÷ 4，最长 maxSec 秒（config.mjs 的 *_IDLE_MAX_SEC）；
// 没到点的那些轮直接结束，不碰工单系统。
// 两条防止「退避挡住人」的规则：
//   1. 只拦「上一轮没事干」记下的退避：干过活的那一轮不记，免得人刚补完内容、重跑被自己上一轮挡住。
//   2. 间隔短于 PACE_MIN_GATE_MS 一律当 0：刚有动静时算出来只有零点几秒，拦不住什么，反倒会挡住手动重跑。
// maxSec 设 0 = 关掉退避（工单源不要额度时，比如本机 beads）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACE_MIN_GATE_MS = 5_000;

export function paceOf(name, maxSec) {
  const file = fileURLToPath(new URL(`../logs/${name}.pace.json`, import.meta.url));

  // 除 activeAt / nextAt / idle 外的字段（如讨论流的 cursor）原样带走
  const read = () => {
    try {
      const p = JSON.parse(readFileSync(file, 'utf8'));
      return { ...p, activeAt: Number(p.activeAt) || 0, nextAt: Number(p.nextAt) || 0, idle: Boolean(p.idle) };
    } catch {
      return { activeAt: 0, nextAt: 0, idle: false };   // 还没有这个文件、或文件坏了：当没退避
    }
  };

  const write = (p) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(p, null, 2));
    return p;
  };

  return {
    file,
    read,
    // 该不该跳过这一轮（人的强制放行由调用方判断）
    held: () => maxSec > 0 && read().idle && Date.now() < read().nextAt,
    // 这一轮的结果记账。busy = 干了活；patch 覆盖其它字段（如 cursor），其余原样保留
    settle(busy, patch = {}) {
      const p = read();
      const now = Date.now();
      const activeAt = busy ? now : p.activeAt;
      const gap = Math.min(maxSec * 1000, (now - activeAt) / 4);
      const idle = !busy;
      return write({ ...p, ...patch, activeAt, idle, nextAt: idle && gap >= PACE_MIN_GATE_MS ? now + gap : now });
    },
    // 列单失败（如额度用完）：退避几十秒没用，按最长间隔退开
    backoff() {
      return write({ ...read(), nextAt: Date.now() + maxSec * 1000, idle: true });
    },
  };
}

// 日志里给时刻，人的时区
export const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
