# Agent 工作流极简方案 v1.7

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

**内核装一份，沉淀跟着业务项目走。** 两边是两个仓库。

内核仓库：

```text
MiWorkflow/
  run.mjs         # 唯一入口（bin: miworkflow）
  core.mjs        # 三个原语（包入口：import ... from 'miworkflow'）
  guard.mjs       # 内核护栏：改内核要人审批（§14.1）
  core.lock.json  # 内核指纹 + 最后一次审批的理由（§14.1）
  viewer/         # 实时视图 + 人工审批页，外部工具，不默认加载（bin: miworkflow-view）
  examples/       # 示例，本身就是一个 HOME，仅参考（§15）
  tests/          # 内核测试
  package.json    # type: module + exports + bin + npm test / npm run view
  README.md       # 怎么跑；规范以本文档为准
  .gitignore      # node_modules/、logs/
  .gitattributes  # 统一 LF（§11）
```

沉淀所在叫 **HOME**：`AGENTFLOW_HOME`，缺省为当前目录。以 Unity 项目为例：

```text
<Unity 项目>/.workflow/
  package.json    # { "type": "module", "private": true,
                  #   "devDependencies": { "miworkflow": "github:Yogioo/MiWorkflow" } }
                  # 改内核时换成 "file:<本机内核路径>"
  tasks/          # 任务，mjs
  scripts/        # 原子能力，mjs
  tests/          # 沉淀自己的测试
  logs/           # 运行记录 JSONL（首跑时自动建，gitignore）
```

- `tasks/`、`scripts/`、`logs/` 都在 HOME 下找；脚本与 Agent 子进程的 cwd 是 HOME；viewer 读 HOME 的 `logs/`。
- 跑：`cd .workflow && npx miworkflow <task>`。进化的 commit 落在业务仓库，跟业务代码一起回滚（§14）。
- **内核仓库里没有 `tasks/`、`scripts/`**，测试断言它（§16）；冒出来会被 guard 当成内核改动拦下（§14.1）。
- 同一次运行里 `run.mjs` 与任务必须加载**同一份** `core.mjs`（`seq` 在模块里）：用 `npx miworkflow` 跑，
  不要拿另一份内核的 `run.mjs` 去跑装了别的内核的 HOME。

---

## 4. 三个概念

| 概念 | 是什么 | 放哪 |
|---|---|---|
| 任务 | 一个 mjs 文件，编排步骤，导出人类可读 `title` | `<HOME>/tasks/<name>.mjs` |
| 脚本 | 一个 mjs 文件，做原子动作 | `<HOME>/scripts/<action>.mjs` |
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
另导出常量 `HOME`、`LOGS_DIR`（HOME 与它的 `logs/` 的绝对路径），只给需要定位目录的调用方用，不属于任务接口。

任务文件用包名 import 它们（`import { script, agent, human } from 'miworkflow'`），然后用 JS 自由组合：

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
- 必须结构化 JSON；stdout 不是 JSON → core 直接判 `failed`（`choice: 'agent_invalid_json'`）；
  缺 `status` / `choice` 或 `status` 不在枚举内 → `failed`（`choice: 'agent_bad_output'`），不补默认值、不猜
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
import { script, agent, human } from 'miworkflow';

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

// HOME：沉淀所在（§3）；子进程 cwd、gitSha 都取它
export const HOME = path.resolve(process.env.AGENTFLOW_HOME || process.cwd());
export const LOGS_DIR = path.join(HOME, 'logs');

// 一次运行一个 runId，三个原语共用（§12）
// 延迟解析：run.mjs 先写 env，再加载本模块
const rid = () => process.env.AGENTFLOW_RUN_ID || (runIdCache ??= randomUUID());
let seq = 0;

// run.mjs 也用它写 run 级记录
export function log(record) {
  const row = { runId: rid(), task: process.env.AGENTFLOW_TASK,
                seq: ++seq, at: new Date().toISOString(), gitSha: gitSha(), ...record };
  appendFileSync(path.join(LOGS_DIR, `${row.runId}.jsonl`), JSON.stringify(row) + '\n');
  return row.seq;
}

export async function script(name, args = {}, opts = {}) {
  // dryRun 注入 args；parseOrFail 顺带把非 0 退出码判成 failed（§6.1）
  const out = await run(process.execPath, [path.join(HOME, 'scripts', `${name}.mjs`)], JSON.stringify(args));
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
    : await waitFile(path.join(LOGS_DIR, `${rid()}.decide.${seq}.json`)); // §13.5
  log({ primitive: 'human', ref: seq, status, prompt, say: `${prompt} → ${status}` });
  return { status };
}
```

`run.mjs`

```js
#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { inspect } from './guard.mjs';

const task = process.argv[2];

if (!task) {
  console.error('usage: miworkflow <task> [--yes] [--dry-run]');
  process.exit(1);
}

// 内核被改而没审批就拒跑（§14.1）
if (!inspect().ok) {
  console.error('✖ 内核被改了但没有审批，拒跑：node guard.mjs approve --reason "..."');
  process.exit(1);
}

// 先定 runId，再加载 core（core 里 runId 延迟解析）
process.env.AGENTFLOW_TASK = task;
process.env.AGENTFLOW_RUN_ID ??= randomUUID();

const { log, HOME } = await import('./core.mjs');
const taskFile = path.join(HOME, 'tasks', `${task}.mjs`);

if (!existsSync(taskFile)) {
  console.error(`task not found: ${task}（在 ${path.join(HOME, 'tasks')} 下找）`);
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
2. 人工或 Agent 修改任务 / 脚本（HOME 里，§3）。
3. 测试通过（HOME 自己的测试）。
4. `human()` 确认。
5. 在 HOME 所在的业务仓库 Git 提交，可回滚。

暂不实现（机制层面；日志与草案类禁令见 §12、§16）：

- 同一失败出现两次才允许改
- 新任务成功三次固化
- 自动生成候选 diff

这些放到 v2，等最小闭环跑稳后再加。

### 14.1 内核护栏

「只往 HOME 沉淀，不改内核」不靠自觉，靠 `core.lock.json` 加两道闸。

- **可写面**：内核仓库里只有 `logs/`、`examples/` —— 随便改，不算数。沉淀本来就不在内核仓库（§3）。
- **内核**：其余全部（`run.mjs`、`core.mjs`、`guard.mjs`、`viewer/`、`tests/`、`Core.md`、`package.json` …）。
  内核根下冒出 `tasks/`、`scripts/` 同样算内核改动。
- `core.lock.json` 记下内核每个文件的哈希，以及最后一次审批的时间、署名、理由。

改了内核而没重新固化：

1. **内核仓库的 `node --test` 直接红**（改内核的人会跑它）。
2. **`run.mjs` 起跑前拒跑**。进化闭环第 3 步跑的是 HOME 的测试（§14），碰不到内核测试，
   所以必须在运行时拦，否则装在 `node_modules` 里的内核被静默改掉也没人知道。

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
`examples/` 本身就是一个 HOME（§3），不用复制，指过去直接跑：

```text
examples/
  tasks/demo.mjs      # 脚本 → 人工审批 → Agent → 脚本
  tasks/boom.mjs      # 故意失败，看失败态
  scripts/hello.mjs   # 最小脚本
  README.md
```

```bash
AGENTFLOW_HOME=examples node run.mjs demo
```

示例任务写 `import ... from 'miworkflow'`：在内核仓库里靠包的自引用解析，
拷进业务仓库的 `<HOME>/tasks/` 也**一个字不用改**。正式内容在业务仓库的 HOME 里由使用中沉淀。

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
3. ✅ 目录：`logs/`、`tests/`、`examples/`、`viewer/`（v1.7 起 `tasks/`、`scripts/` 移到 HOME，§3）。
4. ✅ `viewer/`：实时视图 + Web 审批（外部工具，§13.6）。
5. ✅ 跑通「任务不存在 → 明确报错；把 `examples/*.task.mjs` 复制进 `tasks/` → 执行 → 记录 → 网页可见可审批」。
6. ✅ 把原则变成护栏：`node --test` 里断言 `tasks/`、`scripts/` 不预置任何实现（§3、§16）。
7. ✅ Git 固化：`git init` + 首次提交，此后每条 trace 的 `gitSha` 都有值（§12）。
8. ✅ v1.6 收口：`--dry-run` 注入 `args.dryRun`、脚本非 0 退出码即 failed、Agent 输出不合契约即 failed；
   文档同步实现（§6.1、§6.2、§13.6）。
9. ✅ 内核护栏：`core.lock.json` + `guard.mjs`，改内核要在终端显式 `approve`，否则 `node --test` 变红（§14.1）。
10. 后续只往 HOME 的 `tasks/` 和 `scripts/` 沉淀（可从拷 `examples/` 起步），不改内核。
11. 自动进化 v2 再议。
12. ✅ v1.7 沉淀离开内核仓库：HOME、包名 import、`bin`、`examples/` 即 HOME、`run.mjs` 起跑前查内核（§3、§14.1、§15）。
13. v1.7 运行期 Agent 适配器（§19.2，已定，未实现）。

---

## 18. 总结

> **内核零业务，内容可沉淀，示例仅参考。**

- 任务 → `<HOME>/tasks/<name>.mjs`
- 能力 → `<HOME>/scripts/<action>.mjs`
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

---

## 19. v1.7 剩余变更（已定，未实现）

> 2026-09-29 拍板的设计。§1–§18 描述已实现的部分；本节实现后折进正文、删掉。
> 落地清单见 `TODO.md` 的 C2。

### 19.1 沉淀离开内核仓库（已实现）

已折进 §3（HOME、业务仓库布局）、§5 / §7（包名 import）、§9、§14、§14.1（起跑前查内核）、§15（`examples/` 即 HOME）。
起因：旧版要求 `tasks/`、`scripts/` 为空、测试查文件系统，而进化闭环又要沉淀后测试通过、提交进 Git ——
内核仓库与沉淀仓库是同一个，两条不可能同时成立。

### 19.2 运行期 Agent 适配器

`agents/agent_cli.mjs <pi|codex|cursor>`：一份适配器，一个参数选家。放在**内核**，
与 `viewer/` 同类的外部工具（core 不 import 它），受 `core.lock.json` 保护 ——
它带着全权限开关，不该被进化中的 Agent 静默改掉。

**来源**：从 exec-review 技能的 runner 层**复制一份**起步（`scripts/runners/*.mjs` + `scripts/normalize-event.mjs`，
零依赖、不读 `~/.afk/config.json`），之后**独立演进**，不回头同步、不依赖 exec-review。
改动：入口换成 §10 任务包进、§6.2 选择出；去掉 exec-review 专有的 `role` / reviewer 只读、
`sandbox` 映射（三家一律全权限，§10）和 `dryRun`。
CLI 名用 `cursor`（exec-review 里叫 `agent`，跟原语重名）。

- **选谁来干**：每次 `agent()` 都能单独指定 CLI、模型、思考等级：

  ```js
  await agent('修掉失败的测试', {
    agent: { cli: 'codex', model: 'gpt-5.5', thinking: 'high' },
    inputs: { cwd, failures }
  });
  ```

  `opts.agent` 是对象 `{ cli, model?, thinking?, provider?, args? }`，或只写 CLI 名的字符串（`'pi'` = `{ cli: 'pi' }`）。
  core 把它展开成 `node <内核>/agents/agent_cli.mjs <cli> [--model <m>] [--thinking <t>] [--provider <p>] [...args]`。
  - 值**原样转交**，各家换成自己的开关，不翻译、不校验（沿用 runner 层已验证的映射）：
    pi → `--model` / `--thinking` / `--provider`；codex → `-m` / `-c model_reasoning_effort=<t>`；
    cursor → `--model <m>[effort=<t>]`，**只给 `thinking` 不给 `model` 就报错**，不静默丢掉。
    `provider` 只有 pi 认，给别家就报错。值不对由 CLI 自己报错 → `agent_cli_failed`。
  - `args` 是逃生口：其余开关原样追加给那家 CLI。
  - codex 另用 `--output-schema` 把 §6.2 的输出形状交给 CLI 强制；pi / cursor 没有这个开关，靠提示词。
- **默认值按什么顺序找**：`opts.cmd` → `opts.agent` → `AGENTFLOW_AGENT_CMD` → `AGENTFLOW_AGENT`（只写 CLI 名，
  是这台机器的缺省）→ 都没有就 `agent_unavailable`（§6.2）。
- **按任务配、按用途起名字，用的是 JS，不是机制**：内核只认单次调用的 `opts.agent`。
  - 整个任务统一用一个：任务文件里写一个常量，或包一行 `const ask = (g, o) => agent(g, { agent: DEEP, ...o })`。
  - 多个任务共用「快的 / 深度思考的」：HOME 里放一份普通模块，任务 import 它：

    ```js
    // .workflow/agents.mjs —— 模型换代只改这一处
    export const FAST = { cli: 'pi', model: 'sonnet', thinking: 'low' };
    export const DEEP = { cli: 'codex', model: 'gpt-5.5', thinking: 'high' };
    ```

  不加 `agents.json`、不加 profile 注册表、不在环境变量里拼 `codex:model:high` 这种串（§2.8、§2.11）。
- **留痕**：`agent` 那条日志多记一个字段 `agent: { cli, model, thinking }`（§12）——
  进化时才看得出「哪个模型在哪类任务上老失败」。
- **进**：§10 任务包。适配器渲染成提示词：`goal`、`inputs`、`constraints`，末尾附输出契约
  （最后只回一段 `{status, choice, reason, data}`；`choice` 只取 `inputs.choices`，给了的话）。
- **出**：取最后一条回话，剥掉至多一层代码围栏，原样写 stdout。**合不合契约仍由 core 判**（§6.2），
  适配器不补默认值。CLI 起不来 / 非 0 退出 → 适配器写
  `{status:'failed', choice:'agent_cli_failed', reason}`（这是事实，不是猜）。
- **运行目录**：`inputs.cwd`，缺省 HOME。内核不加 `opts.cwd`。
- **过程**：各家事件流经 `normalize-event` 统一后翻成人话写 stderr（core 已透传到终端）。
  统一后的事件另存进 HOME 的 `logs/`（命名实现时定）—— 这顺带就是 E3「长任务过程留痕」的底子。
- **会话**：runner 层自带续会话能力表（pi 有就续没有就建、codex 只能续、cursor 不支持就报错）。
  v1.7 **不开放**（C2-3），留着以后按需接 `inputs.session`。
- **预算**：只有 `timeoutSec` 真生效；`maxTokens` / `maxTurns` 能映射就映射，不能就只写进提示词。
- **权限**：三家都全权限（§10）。
- **`choice` 不由 core 校验**：不加 `opts.choices`。可选值放 `inputs.choices` 给适配器渲染，
  未知 `choice` 由任务 JS 自己 `throw`（§7 的写法）。

### 19.3 不变的

三个原语的签名与返回、§6.1 脚本协议、§6.3 / §13.5 决定通道、§12 日志字段、§16 的全部禁令。
