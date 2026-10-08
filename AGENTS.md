# AGENTS.md

给在**本仓库（MiWorkflow 内核）**里干活的编码 Agent 的约定。
业务项目里 `.workflow/AGENTS.md` 是另一份，别混。

规范以 `Core.md` 为准；怎么用看 `README.md`；写任务的完整写法跑 `miworkflow skill`（打印 `SKILL.md`）。

## 硬规则

- **在无终端的 shell 里跑任务之前，先想 `human()`。** 没有终端时 `human()` 等「决定文件」，默认一小时（`Core.md` §13.5）；
  没人能批就挂死。要么带 `--yes`，要么别跑带 `human()` 的任务（`examples/tasks/demo.mjs` 就有一个）。
  CI、定时、由 Agent 代跑，一律按「无终端」处理。
- **别嵌套跑 run：一次 shell 里的 run 就是一次 run。** 子 run 的身份全套靠环境变量从父 run 继承
  （`run.mjs` 的 `AGENTFLOW_RUN_ID ??=` 只是其中一处）：`runId`、HOME、锁、日志目录。HOME 相同时，
  子 run 会写进父 run 的同一个 JSONL，把父 run 的记录搅乱（`Core.md` §12）。
  要单独验证就退出父 run、在干净 shell 里跑；确实要嵌套，就显式换 `AGENTFLOW_HOME`，别让子 run 继承 `AGENTFLOW_RUN_ID`。
- **改内核，`node --test` 必须全绿。** 测试在 `tests/`。零依赖，只用 Node 内置模块，不加 npm 依赖。
- **`run.mjs` 是唯一入口**（`init` / `new` / `view` / `skill` / `stop` 是保留字）；`core.mjs` 放三个原语。
  `agents/`、`viewer/`、`templates/`、`examples/` 是外部工具、模板与示例，不是内核（§16）。
- **内核仓库不放 `tasks/`、`scripts/`。** 沉淀跟着业务项目走（`Core.md` §3、§16）；`examples/` 自己是一个 HOME，只作参考。
- **日志是 JSONL，每条带 `say`**（§12、§13.1）。`say` 只能由动作结果翻译出来，不许在任务里手写。
- 跨平台：别写死路径分隔符，换行统一 LF（`.gitattributes`）。

## 提交

- 一行说清落点：`run.mjs：同一任务在跑就跳过（按 task 建锁）`；对应 issue 就带上号：`#4 …`。

<!-- miworkflow:begin -->
## MiWorkflow

这个项目用 MiWorkflow 跑 Agent 工作流：任务在 `.workflow/tasks/`，脚本在 `.workflow/scripts/`。
这一段是 `miworkflow init` 追加的入口，要改请改 `.workflow/AGENTS.md`。

**动手写或改 `.workflow/` 之前，先读 `.workflow/AGENTS.md`，或运行 `miworkflow skill` 读完整写法。**

- 跑任务：`miworkflow <task> [--key value]`；看运行 / 审批 / 点运行：`miworkflow view`
- 只改 `.workflow/` 里的文件，不改内核（全局装的 `miworkflow`）
<!-- miworkflow:end -->
