// GitHub 工单源的常量。init 复制进 .workflow/ 后归项目所有，直接改这里。
// 共用常量（DEV / REVIEWER / VERIFY / ROUNDS / PUSH）在 config.mjs。
// 每个工单源的 source.mjs 都要导出 COMMIT_TYPES 与 commitMessage(ticket, { type, summary })，开发任务靠它拼提交信息。
// miworkflow init --upgrade 会保留这里「一行写完的 export const」，所以项目要改的值都写成一行。

// issue 约定。机器标签（claimed / delivered / failed）两家工单源同名；带任一机器标签的不入队。
// 仓库里没有的机器标签，ticket_mark 第一次贴时先建。
export const LABELS = {
  ready: 'ready-for-agent',     // 入队
  claimed: 'afk-claimed',       // 认领中
  delivered: 'afk-delivered',   // 已交付（完成时贴；依赖判定认它，跟关单等价）
  failed: 'afk-failed',         // 失败，等人看（摘掉它才重新入队）
  review: 'needs-review'        // 要审查（REVIEW='auto' 时，贴了才起审查 Agent；见 config.mjs）
};

// 工单系统故障（网络、5xx、GraphQL 通用服务端报错、限流）时 gh 调用的退避间隔（毫秒），一项一次重试；[] = 不重试。
export const GH_RETRY_DELAYS = [5_000, 20_000, 60_000];

// 提交：Agent 不提交，工作流在审查、验证之后统一提交，一张工单一笔（Agent 自己提交了也会被压成这一笔）。
// Agent 在回话 data 里给 summary（一句话），COMMIT_TYPES 非空时再给 type；给错或没给，type 取第一个、summary 取工单标题。
// COMMIT_FORMAT / COMMIT_BODY 的占位：{type}、{ref}（#N）、{summary}、{title}。COMMIT_BODY 空 = 不写正文。
export const COMMIT_TYPES = [];
export const COMMIT_FORMAT = '{ref} {summary}';
export const COMMIT_BODY = 'Closes {ref}';

export function commitMessage(ticket, { type = '', summary = '' } = {}) {
  const vars = { type, ref: ticket.ref, summary, title: ticket.title };
  const fill = (tpl) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return { message: fill(COMMIT_FORMAT), ...(COMMIT_BODY ? { body: fill(COMMIT_BODY) } : {}) };
}

// 谁来在讨论单（github_discuss）里追问：写法同 config.mjs 的 DEV，null = 本机缺省。
// pi 能续会话最省；cursor 每轮重放完整正文 + 全部评论。
export const DISCUSS = null;
