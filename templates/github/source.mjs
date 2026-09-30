// GitHub 工单源的常量。init 复制进 .workflow/ 后归项目所有，直接改这里。
// 共用常量（DEV / REVIEWER / VERIFY / ROUNDS / PUSH）在 config.mjs。
// 每个工单源的 source.mjs 都要导出 commitMessage(ticket, kind)，开发任务靠它拼提交信息。

// issue 约定。机器标签（claimed / delivered / failed）两家工单源同名；带任一机器标签的不入队。
// 仓库里没有的机器标签，ticket_mark 第一次贴时先建。
export const LABELS = {
  ready: 'ready-for-agent',     // 入队
  claimed: 'afk-claimed',       // 认领中
  delivered: 'afk-delivered',   // 已交付（完成时贴；依赖判定认它，跟关单等价）
  failed: 'afk-failed'          // 失败，等人看（摘掉它才重新入队）
};

// 工单系统故障（网络、5xx、GraphQL 通用服务端报错、限流）时 gh 调用的退避间隔（毫秒），一项一次重试；[] = 不重试。
export const GH_RETRY_DELAYS = [5_000, 20_000, 60_000];

// 提交信息：kind 为 dev（开发 / 工作流兜底提交）、review（审查修正）、fix（验证不过修正）。
// 出 { message, body? }；<一句话> 原样交给 Agent 自己填。
export function commitMessage(ticket, kind) {
  if (kind === 'dev') return { message: `${ticket.ref} ${ticket.title}`, body: `Closes ${ticket.ref}` };
  if (kind === 'review') return { message: `${ticket.ref} 审查修正：<一句话>` };
  if (kind === 'fix') return { message: `${ticket.ref} 验证不过修正：<一句话>` };
  throw new Error(`commitMessage 不认 kind：${kind}`);
}

// 谁来在讨论单（github_discuss）里追问：写法同 config.mjs 的 DEV，null = 本机缺省。
// pi 能续会话最省；cursor 每轮重放完整正文 + 全部评论。
export const DISCUSS = null;
