// TAPD 工单源的常量。init 复制进 .workflow/ 后归项目所有，直接改这里。
// 共用常量（DEV / REVIEWER / VERIFY / ROUNDS / PUSH）在 config.mjs。
// 每个工单源的 source.mjs 都要导出 commitMessage(ticket, kind)，开发任务靠它拼提交信息。

// TAPD 项目 ID（URL 里 tapd.cn/<这串数字>/…）。
export const WORKSPACE_ID = '';

// 评论人：tapd-cli 写评论要它，缺了在动标签之前就报错。留空 = 读环境变量 TAPD_NPC_ROLE。
export const COMMENTER = process.env.TAPD_NPC_ROLE ?? '';

// 需求约定。机器标签（claimed / delivered / failed）两家工单源同名；带任一机器标签的不入队。
// TAPD 的 label 多值用 | 分隔，写逗号会被当成一个新标签名。
export const LABELS = {
  ready: 'ready-for-agent',     // 入队
  claimed: 'afk-claimed',       // 认领中
  delivered: 'afk-delivered',   // 已交付
  failed: 'afk-failed'          // 失败，等人看（摘掉它才重新入队）
};

// TAPD 的 priority 是中文档位；空和不认识的都当 2（不认识的由 ticket_ready 提示）。数字越小越先做。
export const PRIORITY = { 高: 1, 中: 2, 低: 3 };
export const priorityOf = (raw) => PRIORITY[String(raw ?? '').trim()] ?? 2;
export const knownPriority = (raw) => !String(raw ?? '').trim() || String(raw).trim() in PRIORITY;

// 工单引用：日志、评论、human() 提问里用。写全 ID：TAPD 界面上的短 ID 跨项目会重，
// 且不像 GitHub 的 #N 那样一看就知道是哪家，所以带上类型前缀 `story <需求ID>`。
export const refOf = (id) => `story ${id}`;

// 提交信息：kind 为 dev（开发 / 工作流兜底提交）、review（审查修正）、fix（验证不过修正）。
// 出 { message, body? }；<一句话> 原样交给 Agent 自己填。
// TAPD 源码关联写法待实测：先按 `--story=<需求ID> --user=<评论人> <标题>`。
const storyPrefix = (ticket) =>
  [`--story=${ticket.id}`, COMMENTER ? `--user=${COMMENTER}` : ''].filter(Boolean).join(' ');

export function commitMessage(ticket, kind) {
  if (kind === 'dev') return { message: `${storyPrefix(ticket)} ${ticket.title}` };
  if (kind === 'review') return { message: `${storyPrefix(ticket)} 审查修正：<一句话>` };
  if (kind === 'fix') return { message: `${storyPrefix(ticket)} 验证不过修正：<一句话>` };
  throw new Error(`commitMessage 不认 kind：${kind}`);
}
