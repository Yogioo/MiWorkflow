// GitHub 开发工作流的常量。init 复制进 .workflow/ 后归项目所有，直接改这里。
// 规范见 `miworkflow skill`：按用途起名字用普通 JS 常量，不加配置机制（Core §10.1）。

// 谁来开发 / 谁来审查：null = 用本机缺省（AGENTFLOW_AGENT）。
// 要指定就写 { cli: 'codex', model: 'gpt-5.5', thinking: 'high' }，值原样转交给那家 CLI。
export const DEV = null;
export const REVIEWER = null;

// 验证命令：跑在项目根，退出码 0 算过。空字符串 = 不验证，直接进提交流程。
// 字符串走 shell（可有管道、&&）；也可以写数组精确到参数，如 ['npm', 'test']。
export const VERIFY = '';

// 验证不过时，最多让 DEV 再改几轮（默认 2）
export const ROUNDS = 2;

// 提交后推送到当前分支的上游；false = 只本地提交。
// false 与「推送失败」同款语义：没发布就不算做完——不关单、保留 in-progress、整轮停下，
// 本地提交保留，评论注明「本地提交（未推送）」，留给人处理。
export const PUSH = true;

// issue 约定（与 afk-run 的 gh 源一致，同一个仓库两边可以换着跑）
export const LABELS = {
  ready: 'ready-for-agent',   // 入队
  inProgress: 'in-progress',  // 认领中
  failed: 'afk-failed'        // 失败，等人看（摘掉它才重新入队）
};
