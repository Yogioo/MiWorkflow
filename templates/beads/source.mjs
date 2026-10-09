// beads 工单源的常量。init 复制进 .workflow/ 后归项目所有，直接改这里。
// 共用常量（DEV / REVIEWER / VERIFY / ROUNDS / PUSH）在 config.mjs。
// 每个工单源的 source.mjs 都要导出 COMMIT_TYPES 与 commitMessage(ticket, { type, summary })，开发任务靠它拼提交信息。
// miworkflow init --upgrade 会保留这里「一行写完的 export const」，所以项目要改的值都写成一行。

// bd 命令。空 = 自动找：PATH 上的 bd；Windows 上 npm 全局装的 bd 是 .cmd / .ps1 包装、不经 shell 起不来，
// 改找 %APPDATA%/npm/node_modules/@beads/bd/bin/ 里的 bd.exe / bd.js。写 .js / .mjs 路径就用 node 跑它。
export const BD = '';

// 以谁的名义改单、发评论（bd --actor）。空 = bd 自己的缺省（环境变量 BD_ACTOR，再退到 git user.name）。
export const ACTOR = '';

// issue 约定。机器标签（claimed / delivered / failed）各家工单源同名；带任一机器标签的不入队。
// 只接状态为 open 的单：人改成 in_progress / blocked / deferred 的不碰。
export const LABELS = {
  ready: 'ready-for-agent',     // 入队
  claimed: 'afk-claimed',       // 认领中（同时把状态改成 in_progress）
  merging: 'afk-merging',       // 工人在工位里交了单子分支，等 merge 合入（不算交付：依赖它的单仍被挡住）
  delivered: 'afk-delivered',   // 已交付（完成时贴，并 bd close）
  failed: 'afk-failed',         // 失败，等人看（摘掉它才重新入队）
  review: 'needs-review'        // 要审查（REVIEW='auto' 时，贴了才起审查 Agent；见 config.mjs）
};

// bd 调用暂时失败（库被别的 bd 进程锁住、dolt server 连不上、超时）时的退避间隔（毫秒），一项一次重试；[] = 不重试。
export const BD_RETRY_DELAYS = [1_000, 5_000, 15_000];

// 工单引用：日志、评论、human() 提问里用。beads 的 ID 自带项目前缀（如 demo-a3f2），原样用。
export const refOf = (id) => String(id);

// 提交：Agent 不提交，工作流在审查、验证之后统一提交，一张工单一笔（Agent 自己提交了也会被压成这一笔）。
// Agent 在回话 data 里给 summary（一句话），COMMIT_TYPES 非空时再给 type；给错或没给，type 取第一个、summary 取工单标题。
// COMMIT_FORMAT / COMMIT_BODY 的占位：{type}、{id}（beads ID）、{summary}、{title}。COMMIT_BODY 空 = 不写正文。
// beads 习惯把 ID 写在标题末尾的括号里，要这样就改成 '{summary} ({id})'。
export const COMMIT_TYPES = [];
export const COMMIT_FORMAT = '{id} {summary}';
export const COMMIT_BODY = '';

export function commitMessage(ticket, { type = '', summary = '' } = {}) {
  const vars = { type, id: ticket.id, summary, title: ticket.title };
  const fill = (tpl) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return { message: fill(COMMIT_FORMAT), ...(COMMIT_BODY ? { body: fill(COMMIT_BODY) } : {}) };
}

// 谁来在讨论单（discuss）里追问：写法同 config.mjs 的 DEV，null = 本机缺省。
// pi 能续会话最省；cursor 每轮重放完整正文 + 全部评论。
export const DISCUSS = null;
