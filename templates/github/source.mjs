// GitHub 工单源的常量。init 复制进 .workflow/ 后归项目所有，直接改这里。
// 共用常量（DEV / REVIEWER / VERIFY / ROUNDS / PUSH）在 config.mjs。

// issue 约定（与 afk-run 的 gh 源一致，同一个仓库两边可以换着跑）
export const LABELS = {
  ready: 'ready-for-agent',   // 入队
  inProgress: 'in-progress',  // 认领中
  failed: 'afk-failed'        // 失败，等人看（摘掉它才重新入队）
};

// 谁来在讨论单（github_discuss）里追问：写法同 config.mjs 的 DEV，null = 本机缺省。
// pi 能续会话最省；cursor 每轮重放完整正文 + 全部评论。
export const DISCUSS = null;
