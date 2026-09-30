# MiWorkflow

Agent 工作流极简方案 —— **确定性外壳 + 智能内核 + 受控进化 + 人类可见**。

完整规范见 [Core.md](Core.md)。这里只讲怎么用。

## 一句话

> 用 mjs 做任务和脚本，用三个原语编排，用 Agent 做开放推理，用 Git 做进化。
> Agent 输出选择，不输出 actions（但自己动手）；任务不存在就报错；不自造 DSL。

## 装一次

零依赖，Node.js 18+。每台机器装一次全局命令：

```bash
npm i -g github:Yogioo/MiWorkflow
```

### 开发机：用本地内核（npm link）

要改内核，就不装 GitHub 上的那份，把全局命令链到本地克隆：

```bash
git clone git@github.com:Yogioo/MiWorkflow.git
cd MiWorkflow
npm link                  # 全局 miworkflow → 这个目录
```

之后在任何项目里跑 `miworkflow`，用的都是这份源码：改完直接生效，不用重装。

- 确认链上了：`npm ls -g miworkflow` 显示 `-> <本地路径>`
- 取消：`npm unlink -g miworkflow`，再按上面的方式装 GitHub 版
- Windows 控制台中文乱码：先 `chcp 65001`

## 在项目里用

项目里什么都不用手建，也没有 `package.json`：

```bash
miworkflow init                  # 建 .workflow/，并往项目根 AGENTS.md 追加 AI 入口（终端里可选模板）
miworkflow new fix_tests         # 建任务骨架 .workflow/tasks/fix_tests.mjs
miworkflow fix_tests --filter login   # 跑；项目里任意子目录都行，往上找 .workflow/
miworkflow fix_tests --every 5m  # 常驻循环：每轮一次全新的 run，间隔从上轮结束算（30s / 5m / 1h）；Ctrl+C 退出
miworkflow view                  # 网页：点「运行」、看每一步、点「通过 / 拒绝」
miworkflow skill                 # 打印写任务的完整说明（给 AI 看）
```

```text
<项目>/
  AGENTS.md      # AI 的入口：init 建或追加的一段，指向 .workflow/AGENTS.md
  .workflow/
    .gitignore   # 只有 logs/
    AGENTS.md    # 硬规则 + 「先跑 miworkflow skill」
    tasks/       # 任务
    scripts/     # 原子能力
    tests/       # 沉淀自己的测试
    logs/        # 运行记录，不进 Git
```

任务不 import 内核，原语和命令行参数由 `run.mjs` 传进来：

```js
export const title = '跑测试，挂了就修';

export default async function ({ script, agent, human, args }) {
  const r = await script('run_tests', { filter: args.filter });
  // ...
}
```

### 接上 Agent

`agent()` 由内核适配器起本机的 pi / codex / Cursor CLI（三家都全权限）。设一次本机缺省就能用：

```bash
AGENTFLOW_AGENT=codex miworkflow fix_tests     # PowerShell：$env:AGENTFLOW_AGENT='codex'
```

也可以每次调用单独选：`agent(goal, { agent: { cli: 'pi', model: 'sonnet', thinking: 'high' } })`。
终端里能看到 Agent 每一步（`· 工具`、`» 说了什么`）；提示词、原始输出、事件落在 `.workflow/logs/<runId>/`。
默认超时 2 小时，想早点失败就给 `budget.timeoutSec`。完整说明见 [Core.md](Core.md) §10.1。

让 AI 写任务：`init` 往项目根的 `AGENTS.md` 追加一段入口（没有就建、有就追加，项目原有内容一个不动），
Cursor / Codex / Claude Code / pi 从 cwd 往上就能读到，它让 AI 先跑 `miworkflow skill` 读完整写法（即内核的 [SKILL.md](SKILL.md)）；也可以把内核目录链成技能。
进化的 commit 落在业务仓库，跟业务代码一起回滚（[Core.md](Core.md) §3、§14）。

## 开箱即用：GitHub 开发

`init` 选「GitHub 开发」模板（`--template github`），`.workflow/` 里就有一整条流水线：

```bash
miworkflow init --template github      # 复制模板（已有文件一个不覆盖）
miworkflow dev                         # 把就绪 issue 逐个做完
miworkflow dev --issue 42              # 只做 #42（不看标签和依赖，人点名就跑）
miworkflow dev --max 3                 # 最多 3 个；--max-failures 1 连续失败就停
miworkflow dev --confirm               # 每次发布（推送 + 关单）前 human 确认；--dry-run 只报会做什么
```

issue 约定（机器标签名在 `source.mjs` 的 `LABELS` 里可改；仓库里没有时脚本第一次贴会先建）：

- 入队：issue 贴 `ready-for-agent`；带任一机器标签的排除：`afk-claimed`（认领中）、`afk-delivered`（已交付）、`afk-failed`（失败待人看）
- 优先级：标签 `P0`~`P4`，没有就当 `P2`；同级按 issue 号升序
- 依赖：正文里 `- [ ] #123` 表示被 #123 挡着，勾上、#123 关掉或贴了 `afk-delivered` 就算满足

每个 issue 走：认领（贴 `afk-claimed`）→ Agent 开发 → Agent 审查（有问题直接改）→ 验证（`VERIFY` 配了才跑）→
提交（默认推送，正文带 `Closes #N`）→ 关单 + 贴 `afk-delivered`、摘 `ready-for-agent` / `afk-claimed`。失败就 `git reset --hard` + `clean -fd` 回滚，
摘 `afk-claimed`、贴 `afk-failed` + 评论原因，保留 `ready-for-agent`（人摘掉 `afk-failed` 就重新入队）。
推送失败不关单、整轮停下，本地提交保留，留给人处理。`PUSH = false`（只本地提交）同款语义：
没发布就不算做完——评论注明「本地提交（未推送）：<sha>」、不关单、保留 `afk-claimed`、整轮停下。

失败分两类：

- **业务失败**（Agent 说不行）：`need_human`、`no_change`、审查 `reject`、验证放弃或不过、输出不合契约等，照上面回滚 + 贴 `afk-failed` + 评论。
- **Agent 没跑完**（基础设施故障）：CLI 起不来 / 非 0 退出 / 没回话（`agent_cli_failed`），或进程被杀什么都没吐（空输出的 `agent_invalid_json`）。
  按 `config.mjs` 的 `AGENT_RETRY_DELAYS`（缺省 30 秒、2 分钟，空数组 = 不重试）重试同一步，开发重试前先回到本轮起点；
  还不行，或没配 Agent（`agent_unavailable`）、超时，就回滚（提交先备份成 `refs/afk-backup/*`）、摘 `afk-claimed`、**不贴** `afk-failed`、
  评论「Agent 连接失败，已回滚并释放，下轮重做：<原因>」，整轮立即停下（退出码非 0，不计入 `--max-failures`），下一轮自动重做。

Agent 不直接碰 GitHub：认领 / 读单 / 标记全由 `.workflow/scripts/` 里的 `ticket_ready` / `ticket_view` / `ticket_mark` 做。
读单读的是**工单快照**（正文 + 全部评论转成的 Markdown，图片下到旁边，在 `.workflow/logs/<runId>/tickets/<id>/`）；
Agent 要对人说的话（提问、不改的理由、失败原因）写进**回帖稿**（同目录的 `reply-<n>.md`，可带图），由脚本发成评论。
回帖稿带图时靠 `gh issue comment --attach` 上传，要 `gh` ≥ 2.99.0；版本不够只是图不上传（评论里留占位并提示升级），评论照发。

### 讨论单：先把需求问清楚

给 issue 贴 `agent-discuss`，跑 `miworkflow github_discuss`（`--max N` 限张数；适合定时跑），
AI 就在评论区按 `.workflow/prompts/grilling.md` 逐轮追问：一轮一条评论，问题全部编号、每题附推荐答案；
问完会提示「回复 /spec 生成」。首次处理贴 `discuss:grilling`；讨论期间 Agent 对仓库只读。

- 人回复评论或改正文 → 下一次运行接着问；没新内容就不重复回复（AI 评论里的隐藏标记记着它读到的内容哈希）
- 一轮失败会发一条评论写明原因，不自动重试、不贴 `afk-failed`；回复任意内容即重试
- 回复 `/spec` → AI 按 `.workflow/prompts/spec.md` 把 spec 写进正文末尾的 spec 标记区域（原文留在上面），阶段改为 `discuss:spec`；
  之后的评论（或再次 `/spec`）都是修改意见，AI 只重写那一段。spec 区域不算「人的内容」，AI 写 spec 不会触发它自己；spec 不贴 `ready-for-agent`
- 追问的 Agent 由 `source.mjs` 的 `DISCUSS` 指定

改行为就改 `.workflow/config.mjs`（共用：`DEV` / `REVIEWER` / `VERIFY` / `ROUNDS` / `PUSH`）与 `.workflow/source.mjs`（GitHub：标签名 `LABELS` / `DISCUSS` / 提交信息 `commitMessage`）；
开发 / 审查 / 验证修正的提示词在 `.workflow/prompts/dev.md` / `review.md` / `fix.md`；
模板复制出去后归项目所有，各自演进，不回头同步内核。

## 开箱即用：TAPD 开发

同一条 `dev` 流水线换成 TAPD 需求当工单（`--template tapd`，开发任务与提示词跟 GitHub 模板共用）：

```bash
miworkflow init --template tapd        # 复制模板（已有文件一个不覆盖）
miworkflow dev --dry-run               # 先干跑：只报会做哪些需求、哪些被挡住，不叫 Agent、不改 TAPD、不碰 git
miworkflow dev                         # 把就绪需求逐个做完；--issue <需求ID> / --max / --confirm 同 GitHub
```

跑之前要配好：

- `.workflow/source.mjs`：`WORKSPACE_ID` 填项目 ID（URL 里 `tapd.cn/<这串数字>/…`）；评论人 `COMMENTER`（留空就读环境变量 `TAPD_NPC_ROLE`，
  认领 / 完成 / 失败都要发评论，缺了在动标签之前就报错）
- `tapd-cli` 已装好并登录（认领、改标签、发评论、传图走它）
- 环境变量 `TAPD_API_ENDPOINT` + `TAPD_TOKEN`（个人令牌）：读评论、查前后置依赖、取结束类状态走 OpenAPI，`tapd-cli` 没封装这些

需求约定（标签名在 `source.mjs` 的 `LABELS` 里可改；TAPD 标签多值用 `|` 分隔，脚本写完都回读校验）：

- 只接**需求**，缺陷不处理；入队只看标签：贴 `ready-for-agent`、没贴任何机器标签（`afk-claimed` / `afk-delivered` / `afk-failed`），不要求处理人
- 优先级：`高` 1 / `中` 2 / 空 2 / `低` 3（`source.mjs` 的 `PRIORITY`），不认识的当 2 并提示；同级按需求 ID 升序
- 依赖：TAPD 原生前后置关系；前置需求贴了 `afk-delivered` 或已到结束类状态（先按项目工作流取，取不到退回 `source.mjs` 的 `END_STATUSES`）才算满足；
  不认识的前置（缺陷、别的项目、已删除、查不到）当挡住，原因写进 `blocked`，由人解开
- 空壳拒单：描述与评论都空的需求不做，贴 `afk-failed` + 评论请人补充（`--dry-run` 只报不改）
- 工单引用写成 `story <需求ID>`；提交信息按 `source.mjs` 的 `commitMessage`（先用 `--story=<需求ID> --user=<评论人> <标题>`，源码关联写法待实测）

**完成不关单**：做完贴 `afk-delivered`、摘 `afk-claimed`、发评论（`ready-for-agent` 留着，有机器标签就不再入队），需求状态不动——人验收后自己在 TAPD 里流转状态。
失败、未推送的处理与 GitHub 相同（失败保留 `ready-for-agent`、贴 `afk-failed`；未推送保留 `afk-claimed`、评论注明本地提交）；
失败分类也相同：Agent 没跑完就退避重试，还不行回滚、撤 `afk-claimed`、不贴 `afk-failed`、评论后整轮停下（不关单、不改状态），下轮重做。
工单快照里的图片经 `tapd-cli attachment get-image` 下载；回帖稿的图逐张 `upload-image` 后随评论发出。

## 内核仓库

```
run.mjs     唯一入口（bin: miworkflow）：init / new / view / skill / 跑任务
core.mjs    三个原语：script / agent / human
agents/     运行期 Agent 适配器（pi / codex / cursor），core 当命令起它
viewer/     实时视图 + 人工审批 + 运行按钮（外部工具）
templates/  init 可选的模板，只在 init 时复制
examples/   示例，本身就是一个 HOME，仅参考
SKILL.md    写给 AI 的建任务说明
tests/      node:test
```

内核仓库里**没有** `tasks/`、`scripts/`，这条由测试守着。

## 跑示例

`examples/` 就是一个 HOME，不用复制（PowerShell 用 `$env:AGENTFLOW_HOME='examples'`）：

```bash
AGENTFLOW_HOME=examples node run.mjs demo --who 你                  # 有终端 → 就地 y/N 确认
AGENTFLOW_HOME=examples AGENTFLOW_HUMAN=web node run.mjs demo      # 无终端 → 挂起等网页决定
AGENTFLOW_HOME=examples node run.mjs view                          # 另开一个终端，浏览器打开
```

`view` 会把本机与内网地址都打出来：内网设备能看实时 trace、点「通过 / 拒绝」；「运行」按钮默认只有本机能用。

## 测试

```bash
node --test
```

测试断言内核仓库里没有 `tasks/`、`scripts/`、示例任务不 import 内核，并端到端跑 `init` / `new` / 往上找 HOME / 网页起任务 ——
原则是被测出来的，不是写在文档里就算。

## 环境变量

| 变量 | 作用 |
|---|---|
| `AGENTFLOW_HOME` | 指定 HOME，优先于往上找 `.workflow/`；viewer 也读它 |
| `AGENTFLOW_AGENT` | 本机缺省 Agent：`pi` / `codex` / `cursor`，走内核适配器；单次调用的 `opts.agent` 优先 |
| `AGENTFLOW_AGENT_CMD` | 自定义 Agent 命令（stdin 任务包、stdout 选择），优先于 `AGENTFLOW_AGENT`；都不配则 `agent()` 返回 `agent_unavailable`，不假装思考 |
| `PI_BIN` / `CODEX_BIN` / `CURSOR_AGENT_BIN` | 覆盖三家 CLI 的可执行文件（默认 `pi` / `codex` / `agent`） |
| `AGENTFLOW_HUMAN` | `stdin` / `web`，默认按有没有 TTY 自动选 |
| `AGENTFLOW_YES=1` | CI 下自动通过所有 `human()` |
| `PORT` / `HOST` | viewer 监听，默认 `8787` / `0.0.0.0` |
| `MIWORKFLOW_REMOTE_RUN=1` | 允许非本机从网页起任务（能起任务 = 能起全权限 Agent） |
| `MIWORKFLOW_GH` | GitHub 模板改用它当 `gh`（一个 JS 文件，参数照传）；测试 / 替换 `gh` 用 |
| `MIWORKFLOW_TAPD` | TAPD 模板改用它当 `tapd-cli`（一个 JS 文件，参数照传）；测试 / 替换 `tapd-cli` 用 |
| `TAPD_NPC_ROLE` | TAPD 模板的评论人（`source.mjs` 的 `COMMENTER` 留空时读它） |
| `TAPD_API_ENDPOINT` / `TAPD_TOKEN` | TAPD 模板直连 OpenAPI 的地址与个人令牌（评论、前后置依赖、结束类状态） |

## 人类可见

每行 trace 都带一个人话字段 `say`，渲染留在外部：

```bash
tail -f .workflow/logs/$RUN.jsonl | jq -r .say
```

网页审批不需要改 `human()` 的签名 —— 它只是"决定通道"的第二个实现：
无终端时 `human()` 写一条 `pending` 记录并阻塞，网页写一个决定文件，它轮询到就继续。
