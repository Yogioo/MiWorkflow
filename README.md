# MiWorkflow

Agent 工作流极简方案 —— **确定性外壳 + 智能内核 + 受控进化 + 人类可见**。

完整规范见 [Core.md](Core.md)。这里只讲怎么跑。

## 一句话

> 用 mjs 做任务和脚本，用三个原语编排，用 Agent 做开放推理，用 Git 做进化。
> Agent 输出选择，不输出 actions（但自己动手）；任务不存在就报错；不自造 DSL。

## 形态

**内核装一份，沉淀跟着业务项目走。** 内核仓库（本仓库）：

```
run.mjs     唯一入口（bin: miworkflow）
core.mjs    三个原语：script / agent / human（包入口：import ... from 'miworkflow'）
guard.mjs   内核护栏
viewer/     实时视图 + 人工审批页（外部工具，bin: miworkflow-view）
examples/   示例，本身就是一个 HOME，仅参考
tests/      node:test
```

沉淀所在叫 **HOME**（`AGENTFLOW_HOME`，缺省为当前目录），里面是 `tasks/`、`scripts/`、`tests/`、`logs/`。
内核仓库里**没有** `tasks/`、`scripts/`，这条由测试守着。

## 快速开始：跑示例

零依赖，Node.js 18+ 即可。`examples/` 就是一个 HOME，不用复制（PowerShell 用 `$env:AGENTFLOW_HOME='examples'`）：

```bash
AGENTFLOW_HOME=examples node run.mjs demo                        # 有终端 → 就地 y/N 确认
AGENTFLOW_HOME=examples AGENTFLOW_HUMAN=web node run.mjs demo    # 无终端 → 挂起等网页决定

AGENTFLOW_HOME=examples node viewer/serve.mjs                    # 另开一个终端，浏览器打开
```

`viewer` 会把本机与内网地址都打出来，内网设备直接访问即可看到实时 trace 并点「通过 / 拒绝」。

## 在业务项目里用

以 Unity 项目为例，建一个 `.workflow/` 当 HOME：

```text
<Unity 项目>/.workflow/
  package.json   # { "type": "module", "private": true,
                 #   "devDependencies": { "miworkflow": "github:Yogioo/MiWorkflow" } }
  tasks/  scripts/  tests/
  logs/          # 加进 .gitignore
```

```bash
cd .workflow
npm install
npx miworkflow <task>        # 跑任务
npx miworkflow-view          # 看 trace、网页审批
```

任务写 `import { script, agent, human } from 'miworkflow'`。改内核时把依赖换成 `"file:<本机内核路径>"`。
进化的 commit 落在业务仓库，跟业务代码一起回滚（[Core.md](Core.md) §3、§14）。

## 测试

```bash
node --test
```

测试断言内核仓库里没有 `tasks/`、`scripts/`，并把 `examples/` 当 HOME 端到端跑一遍 —— 原则是被测出来的，不是写在文档里就算。

## 内核护栏

**内核**（`run.mjs`、`core.mjs`、`guard.mjs`、`viewer/`、`tests/`、`Core.md` …）改动需要有人在终端确认；内核仓库里只有 `logs/`、`examples/` 随便改：

```bash
npm run guard                                    # 只读检查（= node guard.mjs check）
node guard.mjs approve --reason "为什么改内核"
```

改了内核而没重新固化，`node --test` 会红，`run.mjs` 也会拒跑 —— 护栏不靠自觉（[Core.md](Core.md) §14.1）。
`approve` 要求 stdin 是 TTY：Agent 通常在管道里跑，拿不到 TTY，所以过不来。

可选，再拦一道提交：

```bash
node guard.mjs install      # 装 .git/hooks/pre-commit
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `AGENTFLOW_HOME` | 沉淀所在（`tasks/`、`scripts/`、`logs/`），缺省为当前目录；viewer 也读它 |
| `AGENTFLOW_AGENT_CMD` | 外部 Agent 命令，如 `pi -p`；不配则 `agent()` 返回明确的 stub，不假装思考 |
| `AGENTFLOW_HUMAN` | `stdin` / `web`，默认按有没有 TTY 自动选 |
| `AGENTFLOW_YES=1` | CI 下自动通过所有 `human()` |
| `PORT` / `HOST` | viewer 监听，默认 `8787` / `0.0.0.0` |

## 人类可见

每行 trace 都带一个人话字段 `say`，渲染留在外部：

```bash
tail -f logs/$RUN.jsonl | jq -r .say
```

网页审批不需要改 `human()` 的签名 —— 它只是"决定通道"的第二个实现：
无终端时 `human()` 写一条 `pending` 记录并阻塞，网页写一个决定文件，它轮询到就继续。
