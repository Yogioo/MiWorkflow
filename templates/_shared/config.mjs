// 开发工作流的共用常量（与工单系统无关）。init 复制进 .workflow/ 后归项目所有，直接改这里。
// 工单系统相关的常量在 source.mjs。
// 规范见 `miworkflow skill`：按用途起名字用普通 JS 常量，不加配置机制（Core §10.1）。

// 谁来开发 / 谁来审查：null = 用本机缺省（AGENTFLOW_AGENT）。
// 要指定就写 { cli: 'codex', model: 'gpt-5.5', thinking: 'high' }，值原样转交给那家 CLI。
export const DEV = null;
export const REVIEWER = null;

// 谁来解合并冲突 / 修合并后的验证失败（merge 任务）；null = 用本机缺省（AGENTFLOW_AGENT）。写法同 DEV。
export const MERGER = null;

// 要不要叫审查 Agent（REVIEWER）
// 'auto'（缺省）：工单贴了「要审查」标签（各工单源 source.mjs 的 LABELS.review）才审，
//   或 DEV 在回话里选 done_review 主动升级；其余单子 DEV 自测 + VERIFY 就够，不起审查 Agent。
// 'always'：每张单都审（跟以前一样）。
export const REVIEW = 'auto';

// 工人名：接单评论里写谁接的、重启后靠它认自己没收尾的单。空 = `<主机名>/<工位目录名>`
// （不带 --dir 时是主目录的目录名）；几台机器共用一套工单源时改成一眼认得出是哪台的。
export const WORKER = '';

// 验证命令：跑在项目根，退出码 0 算过。空字符串 = 不验证，直接进提交流程。
// 字符串走 shell（可有管道、&&）；也可以写数组精确到参数，如 ['npm', 'test']。
export const VERIFY = '';

// 验证不过时，最多让 DEV 再改几轮（默认 2）
export const ROUNDS = 2;

// 提交后推送到当前分支的上游；false = 只本地提交。
// false 与「推送失败」同款语义：没发布就不算做完——不关单、保留 afk-claimed、整轮停下，
// 本地提交保留，评论注明「本地提交（未推送）」，留给人处理。
export const PUSH = true;

// Agent 根本没跑完（CLI 起不来 / 非 0 退出 / 没回话，或被杀掉什么都没吐）时，隔多久重试同一步（毫秒）。
// 缺省重试 2 次：30 秒、2 分钟；空数组 = 不重试。重试完还不行：回滚、释放工单（不贴 afk-failed）、整轮停下。
// 没配 Agent、被强制结束（卡死 / 超时，见下）不重试。
export const AGENT_RETRY_DELAYS = [30_000, 120_000];

// 看门狗：Agent 连续这么多秒没有任何动静（事件流不前进，比如一条命令迟迟不返回）就算卡死，杀掉整棵进程树。
// 0 = 不看。合法但长时间不出声的命令（Unity 批处理编译、装包）要比它短，不然会被误杀。
// 被强制结束（卡死，或到 agents/agent_cli.mjs 的 2 小时超时）后：诊断 Agent 查原因写成评论 →
// 回滚（半成品另存 diff）→ 释放工单、整轮停下，下轮带着诊断重做。
export const AGENT_IDLE_SEC = 1200;

// 同一张工单被强制结束（卡死、超时合并计数）第几次就不再重做，转人工（贴 afk-failed）
export const AGENT_KILL_LIMIT = 3;

// 同一张工单合并失败（退回队列让工人重做）第几次就不再自动重做，转人工（贴 afk-failed）
export const MERGE_FAIL_LIMIT = 3;

// 省着查（工单系统有调用额度，TAPD 个人令牌 2000 次 / 24 小时）：下次查的间隔 = 距上次有动静的时间 ÷ 4，
// 最长这么多秒；最短就是 --every 给的间隔。刚忙完那几分钟几乎每轮都查，没动静就逐步拉长到这个上限。
// 退避对所有调用方生效（单跑也读），也只拦「上一轮没事干」——免得人刚补完内容、重跑被自己上一轮挡住。
// 设 0 = 关掉退避（工单源没有调用额度时，比如本机 beads）。
// 实现在 scripts/_pace.mjs。
export const DISCUSS_IDLE_MAX_SEC = 600;

// 开发队列同理：队列空的时候别按 --every 一轮一轮查（每轮一次 ticket_ready，
// 队列里堆着被依赖挡住的单时每张还要加查一次前后置依赖）。
export const DEV_IDLE_MAX_SEC = 600;
