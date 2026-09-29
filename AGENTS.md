# AGENTS.md

给在**本仓库（MiWorkflow 内核）**里干活的编码 Agent 的约定。
业务项目里 `.workflow/AGENTS.md` 是另一份，别混。

规范以 `Core.md` 为准；怎么用看 `README.md`；写任务的完整写法跑 `miworkflow skill`（打印 `SKILL.md`）。

## 硬规则

- **在无终端的 shell 里跑任务之前，先想 `human()`。** 没有终端时 `human()` 等「决定文件」，默认一小时（`Core.md` §13.5）；
  没人能批就挂死。要么带 `--yes`，要么别跑带 `human()` 的任务（`examples/tasks/demo.mjs` 就有一个）。
  CI、定时、由 Agent 代跑，一律按「无终端」处理。
- **改内核，`node --test` 必须全绿。** 测试在 `tests/`。零依赖，只用 Node 内置模块，不加 npm 依赖。
- **`run.mjs` 是唯一入口**（`init` / `new` / `view` / `skill` 是保留字）；`core.mjs` 放三个原语。
  `agents/`、`viewer/`、`templates/`、`examples/` 是外部工具、模板与示例，不是内核（§16）。
- **内核仓库不放 `tasks/`、`scripts/`。** 沉淀跟着业务项目走（`Core.md` §3、§16）；`examples/` 自己是一个 HOME，只作参考。
- **日志是 JSONL，每条带 `say`**（§12、§13.1）。`say` 只能由动作结果翻译出来，不许在任务里手写。
- 跨平台：别写死路径分隔符，换行统一 LF（`.gitattributes`）。

## 提交

- 一行说清落点：`run.mjs：同一任务在跑就跳过（按 task 建锁）`；对应 issue 就带上号：`#4 …`。
