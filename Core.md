# Agent 工作流极简方案 v1.6

> 定位：最小可运行内核规范  
> 核心思想：确定性外壳 + 智能内核 + 受控进化 + 人类可见  

---

## 1. 一句话

> **一个入口，一类任务文件（mjs），一类脚本（mjs），三个原语，一个外部视图，Git 进化，人类可见。**

---

## 2. 核心原则

1. 能写规则就别用模型。
2. 已确定性的步骤，能用脚本就别让 Agent 自由发挥。
3. 只有模糊、异常、生成、规划才交给 Agent。
4. 按确定性分工：确定的事固化成脚本，不确定的事整段交给 Agent（含落地）。
5. 失败即需求，测试即护栏，Git 即进化。
6. 内核零业务，内容可沉淀。
7. 跨平台优先，统一用 mjs。
8. 流程语言就是编程语言，不自造 DSL。
9. 约定优于配置。
10. Agent 自己动手（默认全权限），只把结构化选择交回内核。
11. 薄协议必要，DSL 不必要。
12. 保持极简，能删就删，能不加就不加。
13. 人类可见：每次运行留下可读记录，分实时与事后两档，人与 AI 据此共同迭代工作流（§13）。

---

## 3. 目录

```text
MiWorkflow/
  run.mjs         # 唯一入口
  core.mjs        # 三个原语
  guard.mjs       # 内核护栏：改内核要人审批（§14.1）
  core.lock.json  # 内核指纹 + 最后一次审批的理由（§14.1）
  tasks/          # 任务，mjs，空
  scripts/        # 原子能力，mjs，空
  logs/           # 运行记录 JSONL（首跑时自动建，gitignore）
  viewer/         # 实时视图 + 人工审批页，外部工具，不默认加载
  examples/       # 示例，仅参考，不默认加载
  tests/          # 测试
  package.json    # type: module + npm test / npm run view
  README.md       # 怎么跑；规范以本文档为准
  .gitignore      # node_modules/、logs/
  .gitattributes  # 统一 LF（§11）
  .git/
```

`tasks/` 和 `scripts/` **初始为空，且不该被预置任何内容**（§16）。
两个目录里各放一个 `.gitkeep`，只是为了让空目录能进 Git。
内核只保证机制可用，不预置任何具体实现；示例一律放 `examples/`（§15）。

---

## 4. 三个概念

| 概念 | 是什么 | 放哪 |
|---|---|---|
| 任务 | 一个 mjs 文件，编排步骤，导出人类可读 `title` | `tasks/<name>.mjs` |
| 脚本 | 一个 mjs 文件，做原子动作 | `scripts/<action>.mjs` |
| Agent | 外部命令，处理开放推理，可整段独立完成（含落地），输出结构化选择 | 由 `core.mjs` 调用 |

没有 md，没有 YAML，没有 DSL，没有 schema 文件。  
任务文件就是流程，脚本就是能力，Agent 就是补缺。

---

## 5. 三个原语

`core.mjs` 只导出三个原语：

```js
export async function script(name, args, opts) { /* 调 scripts/name.mjs */ }
export async function agent(goal, opts) { /* goal 字符串 + opts.inputs/constraints/budget → §10 任务包 */ }
export async function human(prompt, opts) { /* 等人工确认 */ }
```

对任务而言只有这三个。另有 `log()` 供 `run.mjs` 写 run 级记录（run 开始 / 结束）。
另导出常量 `LOGS_DIR`（`logs/` 的绝对路径），只给需要定位日志目录的调用方用，不属于任务接口。

任务文件 import 它们，然后用 JS 自由组合：

- 顺序：`await`
- 分支：`if / else / switch`
- 循环：`for / while`
- 并行：`Promise.all`
- 重试：自己写
- 错误处理：`try / catch`

不再需要任何自造流程语言。

---

## 6. 最小契约

### 6.1 script

- 输入：stdin JSON
- 输出：stdout 纯 JSON
- 返回：`{ status, data, error }`
- `status`：`'ok' | 'failed'`
- 日志：stderr
- 失败：返回 `status: 'failed'` 或非 0 退出码；退出码非 0 时，即使 stdout 是合法 JSON 也判 `failed`
- 支持 `dryRun`：`node run.mjs <task> --dry-run`（或 `AGENTFLOW_DRY_RUN=1`）时，core 在 args 里注入
  `dryRun: true`，脚本自己决定怎么干跑（写操作由脚本负责跳过）
- 人话层：可选返回 `say`，缺省由 core 回落（§13）

### 6.2 agent

- 输入：结构化任务包，字段精简
- 输出：`{ status, choice, reason, data }`
- `status`：`'ok' | 'need_human' | 'failed'`
- 必须结构化 JSON；缺 `status` / `choice` 或 `status` 不在枚举内 → core 直接判 `failed`
  （`choice: 'agent_bad_output'`），不补默认值、不猜
- 没配 `AGENTFLOW_AGENT_CMD` → 不假装思考：`status: 'failed'`、`choice: 'agent_unavailable'`，`reason` 说明原因
- 不输出 actions
- 可直接写，默认全权限
- 任务 JS 根据 `choice` 分支，再调 `script()`
- 人话层：`reason` 即 `say`，不新增字段（§13）

### 6.3 human

- 交互确认
- CI 下支持 `--yes` 或审批文件
- 返回：`{ status: 'ok' | 'skipped' | 'failed' }`
- 人话层：`prompt` 就是 `say`，且必须打到 stderr（§13）
- 决定通道：`opts.answer` → `--yes` → stdin（有终端）→ 决定文件（§13.5）

---

## 7. 任务示例

`tasks/fix_bug.mjs`

```js
import { script, agent, human } from '../core.mjs';

export const title = '修复 bug';

export default async function () {
  await script('prepare');

  const decision = await agent('阅读 issue，定位问题，修改代码');

  if (decision.status === 'need_human') {
    await human(decision.reason);
    return;
  }

  if (decision.choice !== 'fix_code') {
    throw new Error(`unexpected choice: ${decision.choice}`);
  }

  let result = await script('run_tests');

  for (let i = 0; i < 3 && result.status === 'failed'; i++) {
    const fix = await agent(`测试失败，修复：${result.error}`);

    if (fix.status === 'need_human') {
      await human(fix.reason);
      break;
    }

    result = await script('run_tests');
  }

  if (result.status === 'failed') {
    await human('连续失败，是否继续？');
  }

  await human('确认提交');
  await script('commit');
}
```

任务就是普通 JS。  
Agent 能写、能改、能 review。  
任务 JS 根据 Agent 返回的 `choice` 决定下一步。

---

## 8. 脚本示例

`scripts/run_tests.mjs`

```js
#!/usr/bin/env node
import { execa } from 'execa';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data ? JSON.parse(data) : {};
}

const args = await readStdin();

try {
  const { stdout } = await execa(process.execPath, ['--test'], { cwd: args.cwd });
  process.stdout.write(JSON.stringify({
    status: 'ok',
    say: '跑了测试：全部通过',
    data: { output: stdout }
  }));
} catch (err) {
  process.stdout.write(JSON.stringify({
    status: 'failed',
    say: '跑了测试：有失败',
    error: err.message
  }));
}
```

脚本约定：

- 按动作命名文件：`run_tests.mjs`、`commit.mjs`（调用写 `script('run_tests')`）
- 不按任务命名：避免 `fix_login_bug.mjs`
- 每个脚本配独立测试
- 返回人话 `say`，缺省 core 会回落（§13）
- 协议（stdin / stdout、返回结构）见 §6.1

---

## 9. core.mjs 与 run.mjs 极简逻辑

`core.mjs`

```js
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// 一次运行一个 runId，三个原语共用（§12）
// 延迟解析：run.mjs 先写 env，再加载本模块
const rid = () => process.env.AGENTFLOW_RUN_ID || (cache ??= randomUUID());
let seq = 0;

// run.mjs 也用它写 run 级记录
export function log(record) {
  const row = { runId: rid(), task: process.env.AGENTFLOW_TASK,
                seq: ++seq, at: new Date().toISOString(), gitSha: gitSha(), ...record };
  appendFileSync(`logs/${row.runId}.jsonl`, JSON.stringify(row) + '\n');
  return row.seq;
}

export async function script(name, args = {}, opts = {}) {
  // dryRun 注入 args；parseOrFail 顺带把非 0 退出码判成 failed（§6.1）
  const out = await run(process.execPath, [`scripts/${name}.mjs`], JSON.stringify(args));
  const result = parseOrFail(out);
  // say 缺省由 core 回落，脚本可自行返回（§13.1）
  log({ primitive: 'script', name, ...result, say: result.say ?? `${name}: ${result.status}` });
  return result;
}

export async function agent(goal, opts = {}) {
  // 组任务包（§10）→ 调 AGENTFLOW_AGENT_CMD → 解析 { status, choice, reason, data }
  // 输出不合契约（§6.2）或未配置外部命令 → failed，不猜默认值
  log({ primitive: 'agent', status, choice, reason, say: reason || `agent: ${choice}` });
  return { status, choice, reason, data };
}

export async function human(prompt, opts = {}) {
  const seq = log({ primitive: 'human', status: 'pending', prompt, say: `⏸ ${prompt}` });
  const status = humanMode() === 'stdin'
    ? await askStdin(prompt)                                    // §13.4
    : await waitFile(`logs/${rid()}.decide.${seq}.json`);        // §13.5
  log({ primitive: 'human', ref: seq, status, prompt, say: `${prompt} → ${status}` });
  return { status };
}
```

`run.mjs`

```js
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const task = process.argv[2];

if (!task) {
  console.error('usage: node run.mjs <task> [--yes]');
  process.exit(1);
}

// 先定 runId，再加载 core（core 里 runId 延迟解析）
process.env.AGENTFLOW_TASK = task;
process.env.AGENTFLOW_RUN_ID ??= randomUUID();

const { log } = await import('./core.mjs');
const taskFile = path.join(ROOT, 'tasks', `${task}.mjs`);

if (!existsSync(taskFile)) {
  console.error(`task not found: ${task}`);
  process.exit(1);
}

const mod = await import(pathToFileURL(taskFile).href);
const title = mod.title ?? task;

log({ primitive: 'run', status: 'running', title, say: `▶ ${title}` });
console.log(title);               // 人类可见：这次运行在干什么（§13.3）

try {
  await mod.default();
  log({ primitive: 'run', status: 'ok', title, say: `✔ ${title} 完成` });
} catch (err) {
  log({ primitive: 'run', status: 'failed', title, error: String(err.message),
        say: `✖ ${title} 失败：${err.message}` });
  process.exitCode = 1;
}
```

这就是内核：

- **一次运行一个 `runId`，三个原语共用**（§12）——按运行复盘的唯一线索。
- **每条记录带 `say`**（§13.1）——人话层。
- **`human()` 的决定通道**（§13.5）——CLI 与网页是同一个原语的两种实现。
- **实时视图在 `viewer/`，内核不 import 它**（§13.6）。
- **没有 registry，没有 executor，没有 DSL。**
- **没有草案生成，没有隐式 fallback。**
- **只有薄协议：stdin / stdout JSON。**

---

## 10. Agent 接口

Agent 默认拥有全部权限，可自行执行（改代码、写文件、跑命令、调 MCP）。  
任务 JS 根据返回值做分支或处理。

Agent 输入：结构化任务包

```json
{
  "goal": "...",
  "inputs": {},
  "constraints": [],
  "budget": {
    "maxTokens": 20000,
    "timeoutSec": 120,
    "maxTurns": 8
  }
}
```

Agent 输出：结构化选择

```json
{
  "status": "ok | need_human | failed",
  "choice": "fix_code | retry | skip | ask_human | ...",
  "reason": "...",
  "data": {}
}
```

约束：

- 必须结构化 JSON
- 不输出 actions
- 任务 JS 根据 `choice` 分支，再调 `script()`
- 高风险业务步骤前加 `human()`

---

## 11. 跨平台约定

- 所有任务与脚本用 `.mjs`
- Node.js 18+
- ESM 优先
- 无 shell 依赖
- 路径使用 `node:path`
- 子进程使用 `node:child_process` 或 `execa`
- 测试使用 `node:test` 或 `vitest`

---

## 12. 日志

JSONL 最小字段：

```json
{
  "runId": "...",
  "task": "...",
  "seq": 1,
  "at": "2026-01-01T00:00:00.000Z",
  "gitSha": "...",
  "primitive": "run | script | agent | human",
  "name": "...",
  "title": "...",
  "status": "running | ok | failed | pending | skipped",
  "choice": "...",
  "reason": "...",
  "say": "...",
  "error": "...",
  "ref": 3,
  "durationMs": 0
}
```

原则：

- 只记录必要信息（必要 = 足够让人复盘）
- 人可读、可复盘，人与 AI 据此共同迭代（UI 在外部，内核不内置）
- 每条记录带 `say`：一句话人话，规则见 §13
- 一次运行一个 `runId`，三个原语共用，可按运行复盘
- `seq` 在本次运行内单调递增，是稳定 key；`ref` 指向被解决的那条 `pending` 记录
- `primitive: 'run'` 的两条记录（开始 / 结束）由 `run.mjs` 写，`title` 只出现在这里
- 不引入错误指纹
- 不做自动聚类
- 不做 tokens 统计
- 日志用于排查和进化，不用于构建复杂系统

---

## 13. 人类可见的最小实现

可见性分两档：**实时**（人边跑边看）与**事后**（人复盘）。

内核只做一件事：**给每行 trace 带上人话**。渲染留在外部。

### 13.1 `say`

每条日志记录（§12）额外带一个 `say`：一句话人话，无术语、无路径、无 token。

来源不新增输入契约：

| 原语 | `say` 从哪来 |
|---|---|
| `script` | 脚本可选返回；缺省由 core 回落为 `<name>: <status>` |
| `agent` | 取 Agent 已有的 `reason` |
| `human` | 就是 `prompt` 本身 |

三条硬规则：

1. **动作发生后才写**，陈述已发生的事实，不是计划、不是承诺。
2. **不许凭空手写**：`say` 只能由动作结果翻译而来（脚本返回 / `reason` / `prompt`）；禁止在任务文件里写 `say('正在努力…')`。
3. 一句话，不懂技术的人也能看懂。

### 13.2 实时

两档，任选，看到的是同一份数据：

```bash
tail -f logs/$RUN.jsonl | jq -r .say      # CLI，零成本
node viewer/serve.mjs                     # 网页，§13.6
```

外部渲染器（包括 HTML）只消费 `say`，不必解析其它字段。

### 13.3 任务自述

任务文件导出人类可读标题：

```js
export const title = '修复登录 bug';
```

`run.mjs` 开头打印它。这是「这次运行要干什么」的唯一入口。

### 13.4 `human()` 必须有人脸

- `prompt` 打到 **stderr**，读 stdin 一行 `y/n`
- 卡住时人看到的是「请确认：xxx」，不是一个悬挂的进程
- CI 下 `--yes` 或审批文件不变（§6.3）

### 13.5 决定通道（HTML 审批）

`human()` 的回答来源，按序回落：

1. `opts.answer`（任务写死）
2. `--yes` / `AGENTFLOW_YES=1`（CI，§6.3）
3. 有终端 → stdin 一行 `y/n`（§13.4）
4. 没终端 → 决定文件 `logs/<runId>.decide.<seq>.json`（网页写）

第 4 条就是整个 HTML 审批的全部秘密：

```text
human() 写一条 status:'pending' 记录，阻塞
      → 网页看到它，渲染成「通过 / 拒绝」
      → 点击 → POST /api/decide → 服务端原子写决定文件
      → human() 轮询到文件 → 继续，再写一条 ref:<seq> 的解决记录
```

`human()` 的签名没变，CLI 体验也没变。网页只是**并行存在的第二个实现**。

决定文件固定两个值：`{ "decision": "ok" | "skipped", "by": "web", "at": "..." }`。
这是内核与服务之间唯一的写约定。

### 13.6 实时视图（`viewer/`）

`viewer/` 是仓库里的外部工具，不是内核（§16）：

```text
viewer/serve.mjs    零依赖静态服务 + 四个只读接口 + 一个写接口
viewer/index.html   单文件视图：run 列表 / trace 时间线 / 待决定卡片
```

接口只有五个：

| 接口 | 作用 |
|---|---|
| `GET /api/runs` | 列出 run：标题、状态、待决定数 |
| `GET /api/run/<id>?from=N` | 从第 N 字节起吐日志，只吐完整行 |
| `POST /api/decide` | 写决定文件（§13.5） |
| `GET /health` | 存活探针，给反代 / 脚本用 |
| `GET /` | 视图页 |

两个刻意的选择：

- **实时靠 1 秒轮询 + 字节偏移增量拉取，不用 SSE。** 反代零坑，断线重连天然正确，
  最后一行没写完就留到下次（服务端只吐完整行）。
- **服务端零业务判断。** 待决定状态由前端重放日志算出（`pending` 没被 `ref` 解决掉就算待决定）。

启动：`node viewer/serve.mjs`（`HOST=0.0.0.0` 即内网可访）。

### 13.7 不做什么

- 不内置 UI / TUI / Web（`viewer/` 是外部工具，内核不 import 它）
- 不做静态 HTML 报告（要复盘直接看 jsonl 的 `say`）
- 不加进度条、不加百分比
- 不加事件类型、不加 schema
- 不改 Agent 输出契约（`reason` 已经是人话）

一句话：**日志一行两用——`say` 给人，其余给机器。**

---

## 14. 自动进化（v2 待办）

v1.6 只保留原则：

> **失败即需求，测试即护栏，Git 即进化。**

v1.6 只要求：

1. 任务失败 → 记录日志。
2. 人工或 Agent 修改任务 / 脚本。
3. 测试通过。
4. `human()` 确认。
5. Git 提交，可回滚。

暂不实现（机制层面；日志与草案类禁令见 §12、§16）：

- 同一失败出现两次才允许改
- 新任务成功三次固化
- 自动生成候选 diff

这些放到 v2，等最小闭环跑稳后再加。

### 14.1 内核护栏（v1.6 已实现）

「只往 `tasks/` 和 `scripts/` 沉淀，不改内核」不靠自觉，靠 `core.lock.json` 加 `node --test`。

- **可写面**：`tasks/`、`scripts/`、`logs/`、`examples/` —— 沉淀的地方，随便改，不算数。
- **内核**：其余全部（`run.mjs`、`core.mjs`、`guard.mjs`、`viewer/`、`tests/`、`Core.md`、`package.json` …）。
- `core.lock.json` 记下内核每个文件的哈希，以及最后一次审批的时间、署名、理由。

改了内核而没重新固化，`node --test` 直接红；而「测试通过」是进化闭环的第 3 步（§14），
于是未审批的内核改动卡在门口。

重新固化必须有人在终端：

```bash
node guard.mjs check                                  # 只读检查，跑不坏东西
node guard.mjs approve --reason "修 agent 超时没杀掉子进程"
```

`approve` 要求 stdin 是 TTY。Agent 通常在管道里跑，拿不到 TTY，所以这道闸对它天然有效。
可选再加一道提交时的闸：

```bash
node guard.mjs install      # 装 .git/hooks/pre-commit
```

**边界要说清**：这不是防盗墙。Agent 有文件写权限，真想绕一定绕得过去。
它拦的是「无意识的静默改动」，逼出一句人写的理由和一条可回滚的 Git 记录。
要物理级隔离，用只读挂载 + 可写卷 —— 那是操作系统的事，不是打包的事。

---

## 15. 示例位置

示例只放 `examples/`，**不默认加载**（§16：不内置具体任务 / 不内置具体脚本）。

```text
examples/
  demo.task.mjs      # 任务示例 → 复制到 tasks/demo.mjs
  boom.task.mjs      # 任务示例 → 复制到 tasks/boom.mjs
  hello.script.mjs   # 脚本示例 → 复制到 scripts/hello.mjs
  README.md
```

文件名后缀就是目标位置：`*.task.mjs` → `tasks/`，`*.script.mjs` → `scripts/`。

**为什么平铺，而不按 `tasks/`、`scripts/` 分目录**：示例任务 import 的是 `'../core.mjs'`。
`examples/` 与 `tasks/` 同在根目录下一层，所以复制过去**一个字都不用改**；
若放进 `examples/tasks/`，就得写 `'../../core.mjs'`，复制时必须回来改路径。

`tasks/` 与 `scripts/` 保持为空，正式内容由使用中沉淀：

```bash
cp examples/demo.task.mjs    tasks/demo.mjs
cp examples/hello.script.mjs scripts/hello.mjs
node run.mjs demo
```

---

## 16. 内核明确不做

- 不内置具体任务（示例只在 `examples/`，§15）
- 不内置具体脚本（示例只在 `examples/`，§15）
- 不内置 md / YAML / DSL 解析器
- 不内置 registry / executor / schema
- 不内置 DAG 引擎
- 不内置数据库、向量库、UI、进度渲染
- 不内置 HTTP 服务（`viewer/` 是外部工具）
- 不自动改生产
- 不预置任何业务逻辑
- 不自研 apply_patch
- 不执行 Agent 输出的 actions
- 不替 Agent 补默认值：输出不合契约就判 failed（§6.2）
- 不自动生成任务草案，不隐式 fallback
- 不内置 MCP 层

内核只保证：

- 任务发现与执行
- 三个原语：`script` / `agent` / `human`
- 可读 Trace 记录（每行含人话 `say`，§13）
- 决定文件约定（§13.5）
- Git 进化约定
- 跨平台 mjs 运行

---

## 17. 实施路线

1. ✅ `core.mjs`：三原语、stdin/stdout 协议、最小日志（含 `say`、决定通道，§13）。
2. ✅ `run.mjs`：发现任务、执行任务、run 级记录，任务不存在直接报错。
3. ✅ 目录：`tasks/`、`scripts/`（保持为空）、`logs/`、`tests/`、`examples/`、`viewer/`。
4. ✅ `viewer/`：实时视图 + Web 审批（外部工具，§13.6）。
5. ✅ 跑通「任务不存在 → 明确报错；把 `examples/*.task.mjs` 复制进 `tasks/` → 执行 → 记录 → 网页可见可审批」。
6. ✅ 把原则变成护栏：`node --test` 里断言 `tasks/`、`scripts/` 不预置任何实现（§3、§16）。
7. ✅ Git 固化：`git init` + 首次提交，此后每条 trace 的 `gitSha` 都有值（§12）。
8. ✅ v1.6 收口：`--dry-run` 注入 `args.dryRun`、脚本非 0 退出码即 failed、Agent 输出不合契约即 failed；
   文档同步实现（§6.1、§6.2、§13.6）。
9. ✅ 内核护栏：`core.lock.json` + `guard.mjs`，改内核要在终端显式 `approve`，否则 `node --test` 变红（§14.1）。
10. 后续只往 `tasks/` 和 `scripts/` 沉淀（从复制 `examples/` 起步），不改内核。
11. 自动进化 v2 再议。

---

## 18. 总结

> **内核零业务，内容可沉淀，示例仅参考。**

- 任务 → `tasks/<name>.mjs`
- 能力 → `scripts/<action>.mjs`
- 智能 → Agent + 三个原语
- 编排 → 普通 JS
- 写操作 → Agent 直接写，默认全权限
- 护栏 → 测试、`human()`、Git 回滚
- 可见 → 每行 trace 带人话 `say`；`viewer/` 起一个网页，实时看 + 顺手审批；渲染在外部
- 进化 → 失败驱动 + 人机共读记录，Agent 写 diff，测试通过入库
- 任务不存在 → 直接报错，不自动生成草案

一句话：

> **用 mjs 做任务和脚本，用三个原语编排，用 Agent 做开放推理，用 Git 做进化。**  
> **Agent 输出选择，不输出 actions（但自己动手）；任务不存在就报错；不自造 DSL，就是最好的极简。**
