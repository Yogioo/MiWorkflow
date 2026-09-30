// TAPD 工单源的常量。init 复制进 .workflow/ 后归项目所有，直接改这里。
// 共用常量（DEV / REVIEWER / VERIFY / ROUNDS / PUSH）在 config.mjs。
// 每个工单源的 source.mjs 都要导出 COMMIT_TYPES 与 commitMessage(ticket, { type, summary })，开发任务靠它拼提交信息。
// miworkflow init --upgrade 会保留这里「一行写完的 export const」，所以项目要改的值都写成一行。

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
  failed: 'afk-failed',         // 失败，等人看（摘掉它才重新入队）
  review: 'needs-review'        // 要审查（REVIEW='auto' 时，贴了才起审查 Agent；见 config.mjs）
};

// 前后置依赖的满足判据：前置需求贴了 LABELS.delivered，或已到结束类状态。
// 结束类状态先按项目工作流取：ticket_ready 调 OpenAPI `workflows/last_steps`（system=story），用它给的状态键与中文名；
// 取不到（接口报错、没权限、返回空）才退回下面这张表，按中文名比（经 `workflows/status_map` 把状态键翻成中文名，
// 那个也取不到就直接拿需求的 status 字段比）。缺省参考 tapd-pending 的写死判定。
export const END_STATUSES = ['已完成', '已拒绝', '取消', '已取消'];

// TAPD 的 priority 是中文档位；空和不认识的都当 2（不认识的由 ticket_ready 提示）。数字越小越先做。
export const PRIORITY = { 高: 1, 中: 2, 低: 3 };
export const priorityOf = (raw) => PRIORITY[String(raw ?? '').trim()] ?? 2;
export const knownPriority = (raw) => !String(raw ?? '').trim() || String(raw).trim() in PRIORITY;

// 工单系统故障（网络、5xx、限流）时 tapd-cli 调用的退避间隔（毫秒），一项一次重试；[] = 不重试。
export const TAPD_RETRY_DELAYS = [5_000, 20_000, 60_000];

// 工单引用：日志、评论、human() 提问里用。写全 ID：TAPD 界面上的短 ID 跨项目会重，
// 且不像 GitHub 的 #N 那样一看就知道是哪家，所以带上类型前缀 `story <需求ID>`。
export const refOf = (id) => `story ${id}`;

// 提交：Agent 不提交，工作流在审查、验证之后统一提交，一张工单一笔（Agent 自己提交了也会被压成这一笔）。
// Agent 在回话 data 里给 type（从 COMMIT_TYPES 里选）和 summary（一句话）；给错或没给，type 取第一个、summary 取工单标题。
// COMMIT_FORMAT / COMMIT_BODY 的占位：{type}、{short}（TAPD 界面上的 7 位短号）、{id}（完整需求 ID）、{summary}、{title}。
// 要 TAPD 源码关联识别，可写成 '--story={short} {summary}'。COMMIT_BODY 空 = 不写正文。
export const COMMIT_TYPES = ['feat', 'fix', 'refactor', 'perf', 'style', 'docs', 'test', 'chore'];
export const COMMIT_FORMAT = '{type}:{short} {summary}';
export const COMMIT_BODY = '';

export function commitMessage(ticket, { type = '', summary = '' } = {}) {
  const vars = { type, short: String(ticket.id).slice(-7), id: ticket.id, summary, title: ticket.title };
  const fill = (tpl) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return { message: fill(COMMIT_FORMAT), ...(COMMIT_BODY ? { body: fill(COMMIT_BODY) } : {}) };
}

// 谁来在讨论单（discuss）里追问：写法同 config.mjs 的 DEV，null = 本机缺省。
// pi 能续会话最省；cursor 每轮重放完整正文 + 全部评论。
export const DISCUSS = null;
