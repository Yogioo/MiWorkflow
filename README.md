# MiWorkflow

Agent 工作流极简方案 —— **确定性外壳 + 智能内核 + 受控进化 + 人类可见**。

完整规范见 [Core.md](Core.md)。这里只讲怎么跑。

## 一句话

> 用 mjs 做任务和脚本，用三个原语编排，用 Agent 做开放推理，用 Git 做进化。
> Agent 输出选择，不输出 actions（但自己动手）；任务不存在就报错；不自造 DSL。

## 形态

```
run.mjs     唯一入口
core.mjs    三个原语：script / agent / human
tasks/      任务（编排步骤）        —— 空，用的时候自己写
scripts/    脚本（原子动作）        —— 空，用的时候自己写
logs/       运行记录 JSONL（gitignore）
viewer/     实时视图 + 人工审批页（外部工具）
examples/   示例，仅参考，不默认加载
tests/      node:test
```

内核零业务，`tasks/` 和 `scripts/` 里**不预置任何东西**，示例一律放 `examples/`。

## 快速开始

零依赖，Node.js 18+ 即可，不用 `npm install`。

```bash
cp examples/demo.task.mjs    tasks/demo.mjs
cp examples/hello.script.mjs scripts/hello.mjs

node run.mjs demo                        # 有终端 → 就地 y/N 确认
AGENTFLOW_HUMAN=web node run.mjs demo    # 无终端 → 挂起等网页决定

node viewer/serve.mjs                    # 另开一个终端，浏览器打开
```

`viewer` 会把本机与内网地址都打出来，内网设备直接访问即可看到实时 trace 并点「通过 / 拒绝」。

## 测试

```bash
node --test
```

测试里带三条护栏杆，断言 `tasks/`、`scripts/` 不预置任何实现 —— 这条原则是被测出来的，不是写在文档里就算。

## 环境变量

| 变量 | 作用 |
|---|---|
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
