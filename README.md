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
miworkflow init                  # 在 git 仓库根建 .workflow/（终端里可选模板）
miworkflow new fix_tests         # 建任务骨架 .workflow/tasks/fix_tests.mjs
miworkflow fix_tests --filter login   # 跑；项目里任意子目录都行，往上找 .workflow/
miworkflow view                  # 网页：点「运行」、看每一步、点「通过 / 拒绝」
miworkflow skill                 # 打印写任务的完整说明（给 AI 看）
```

```text
<项目>/.workflow/
  .gitignore     # 只有 logs/
  AGENTS.md      # 给 AI 的入口：硬规则 + 「先跑 miworkflow skill」
  tasks/         # 任务
  scripts/       # 原子能力
  tests/         # 沉淀自己的测试
  logs/          # 运行记录，不进 Git
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

让 AI 写任务：`init` 放的 `.workflow/AGENTS.md` 会被 Cursor / Codex / Claude Code 自动读到，
它让 AI 先跑 `miworkflow skill` 读完整写法（即内核的 [SKILL.md](SKILL.md)）；也可以把内核目录链成技能。
进化的 commit 落在业务仓库，跟业务代码一起回滚（[Core.md](Core.md) §3、§14）。

## 开箱即用：GitHub 开发

`init` 选「GitHub 开发」模板（`--template github`），`.workflow/` 里就有一整条流水线：

```bash
miworkflow init --template github      # 复制模板（已有文件一个不覆盖）
miworkflow github_dev                  # 把就绪 issue 逐个做完
miworkflow github_dev --issue 42       # 只做 #42（不看标签和依赖，人点名就跑）
miworkflow github_dev --max 3          # 最多 3 个；--max-failures 1 连续失败就停
miworkflow github_dev --confirm        # 每次提交前 human 确认；--dry-run 只报会做什么
```

issue 约定与 afk-run 一致，同一个仓库两边可以换着跑：

- 入队：issue 贴 `ready-for-agent`；排除 `in-progress`（在跑）和 `afk-failed`（失败待人看）
- 优先级：标签 `P0`~`P4`，没有就当 `P2`；同级按 issue 号升序
- 依赖：正文里 `- [ ] #123` 表示被 #123 挡着，勾上或 #123 关掉就算满足

每个 issue 走：认领（贴 `in-progress`）→ Agent 开发 → Agent 审查（有问题直接改）→ 验证（`VERIFY` 配了才跑）→
提交（默认推送，正文带 `Closes #N`）→ 关单。失败就 `git reset --hard` + `clean -fd` 回滚，
摘 `in-progress`、贴 `afk-failed` + 评论原因，保留 `ready-for-agent`（人摘掉 `afk-failed` 就重新入队）。
推送失败不关单、整轮停下，本地提交保留，留给人处理。`PUSH = false`（只本地提交）同款语义：
没发布就不算做完——评论注明「本地提交（未推送）：<sha>」、不关单、保留 `in-progress`、整轮停下。

改行为就改 `.workflow/config.mjs`（`DEV` / `REVIEWER` / `VERIFY` / `ROUNDS` / `PUSH` / 标签名）；
模板复制出去后归项目所有，各自演进，不回头同步内核。

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

## 人类可见

每行 trace 都带一个人话字段 `say`，渲染留在外部：

```bash
tail -f .workflow/logs/$RUN.jsonl | jq -r .say
```

网页审批不需要改 `human()` 的签名 —— 它只是"决定通道"的第二个实现：
无终端时 `human()` 写一条 `pending` 记录并阻塞，网页写一个决定文件，它轮询到就继续。
