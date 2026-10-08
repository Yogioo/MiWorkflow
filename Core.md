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

**内核装一份，沉淀跟着业务项目走。** 两边是两个仓库。装 / 写 / 跑三件事分开：

- **装**：每台机器一次，全局命令 `npm i -g github:Yogioo/MiWorkflow`；改内核时在内核目录 `npm link`。
  不按项目锁版本（单人使用可接受）。
- **写**：`miworkflow new <name>` 建骨架，或交给 AI —— `init` 在项目根追加的 `AGENTS.md` 让 AI 先跑 `miworkflow skill` 读完整写法。
- **跑**：终端 `miworkflow <task>`，或 viewer 的「运行」按钮（§13.6），都不经过 AI。

内核仓库：

```text
MiWorkflow/
  run.mjs         # 唯一入口（bin: miworkflow）：init / new / view / skill / 跑任务
  core.mjs        # 三个原语，由 run.mjs 传给任务（§5）
  agents/         # 运行期 Agent 适配器 agent_cli.mjs（pi / codex / cursor），外部工具，core 只当命令起它（§10）
  viewer/         # 实时视图 + 人工审批 + 运行按钮，外部工具，不默认加载（miworkflow view）
  templates/      # init 可选的模板，只在 init 时复制（§15）
  examples/       # 示例，本身就是一个 HOME，仅参考（§15）
  tests/          # 内核测试
  SKILL.md        # 写给 AI 的建任务说明，miworkflow skill 打印它，也可链成技能
  package.json    # type: module + bin + npm test / npm run view
  README.md       # 怎么跑；规范以本文档为准
  .gitignore      # node_modules/、logs/
  .gitattributes  # 统一 LF（§11）
```

沉淀所在叫 **HOME**，就是项目里的 `.workflow/`（以点开头，Unity 不导入它）。以 Unity 项目为例：

```text
<Unity 项目>/
  AGENTS.md       # AI 的入口：init 建或追加的一段（AI 从 cwd 往上找的就是它），指向下面的 .workflow/AGENTS.md
  .workflow/
    .gitignore    # 只有一行 logs/（不碰项目原有的 .gitignore）
    AGENTS.md     # 硬规则正文：这是什么、几条硬规则、完整写法跑 miworkflow skill
    tasks/        # 任务，mjs
    scripts/      # 原子能力，mjs
    prompts/      # 任务读的提示词，md（模板带来，如共用的 dev.md、github 的 grilling.md）
    tests/        # 沉淀自己的测试
    logs/         # 运行记录 JSONL（首跑时自动建）
```

没有 `package.json`，不用 `npm install`：任务不 import 内核（§5）。

- **HOME 怎么找**：`AGENTFLOW_HOME` → 从当前目录**往上找 `.workflow/`**（像 git 找 `.git`）→ 都没有就报错，
  提示 `miworkflow init`。**不回落到当前目录**，免得分不清任务从哪找的。`run.mjs` 把找到的 HOME 写回
  `AGENTFLOW_HOME` 再加载 core / viewer。
- `tasks/`、`scripts/`、`logs/` 都在 HOME 下找；脚本子进程的 cwd 是 HOME；Agent 子进程的 cwd 是项目根
  （HOME 叫 `.workflow` 时取上一级，否则就是 HOME，§10.1）；viewer 读 HOME 的 `logs/`。
- 进化的 commit 落在业务仓库，跟业务代码一起回滚（§14）。
- **内核仓库里没有 `tasks/`、`scripts/`**，测试断言它（§16）。

一个命令，六个用法（`init`、`new`、`view`、`skill`、`stop` 是保留字，其余的词都当任务名）；另有两个内核开关，在任务分派之前处理：

| 命令 | 做什么 |
|---|---|
| `miworkflow --version` / `miworkflow -v` | 打印内核 `package.json` 的 `version`（不写死）到 stdout，退出 0 |
| `miworkflow --help` / `miworkflow -h` | 打印用法（USAGE）到 stdout，退出 0；不带任何参数时 USAGE 打到 stderr、退出 1 |
| `miworkflow init [--template <名字>]` | 建 `.workflow/`：`tasks/`、`scripts/`、`.gitignore`、`AGENTS.md`，并往项目根的 `AGENTS.md` 追加一段 AI 入口（没有就建、有就追加、已含就不动）。建在 git 仓库根，不在仓库里就建在当前目录。终端里有模板可选时让人选（**空白** = 只建目录，或 `templates/` 下的某个工单源；选了就先复制共用的 `templates/_shared/` 再复制它，§15）；非终端缺省空白。已存在 `.workflow/` 时只补缺的文件，**已有的文件一个不覆盖**，跳过的列出来 |
| `miworkflow init --upgrade [--template <名字>]` | 把模板新版铺回已有的 `.workflow/`（§15）：模板里的文件覆盖、缺的补上；`config.mjs` / `source.mjs` 以模板新版为底、保留项目里一行写完的 `export const`；项目自己的文件、`AGENTS.md`、`.gitignore` 不碰；改动过的旧文件备份到 `logs/upgrade-<时间>/`。不给 `--template` 就认 `.workflow/` 里文件齐全的那个模板 |
| `miworkflow new <name>` | 建 `tasks/<name>.mjs` 骨架（`title` + 传参的 `default`），不覆盖已有；没有 `.workflow/` 就报错，提示先 `init` |
| `miworkflow <task> [--key value]` | 跑任务 |
| `miworkflow <task> --every <间隔> [--key value]` | 常驻循环跑：间隔 `30s` / `5m` / `1h`，必须显式给值，缺值或格式不对报错退出、不起 run。外层循环不是 run（不写日志、不拿锁）；每一轮起一个子进程当全新的 run（新 runId，不继承 `AGENTFLOW_RUN_ID`），其余参数原样传；间隔从上一轮结束算，不会自己重叠；某轮非 0 退出只在终端记下退出码，循环继续；另一个终端在跑同一任务时由按任务锁挡住，该轮跳过。Ctrl+C 不特殊处理（只顺手删掉循环标记），连同正在跑的 run 一起结束；要等手头这一单做完再退，用 `miworkflow stop <task>`。纯 Node，三平台一致；一个命令一个任务，多个任务开多个终端；viewer 的「运行」不提供 |
| `miworkflow stop <task> [--now]` | 停任务（§9）：缺省**做完手头这一单再停**——任务用 `stopping()` 在自己定的边界停下，不查的任务把这次跑完，`--every` 循环不再起下一轮；`--now` **立刻强关**——杀整棵进程树（循环、run、Agent CLI 和它起的命令），替被杀的 run 补一条 `failed` 终态、删锁，停在半路的改动与外部状态原样留给人收拾。没在跑就说一声、退出 0 |
| `miworkflow view` | 用找到的 HOME 起 viewer（§13.6） |
| `miworkflow skill` | 打印内核的 `SKILL.md`（不需要 `.workflow/`） |

给 AI 的文档分两层：项目根的 `AGENTS.md` 才是 AI 自动读到的入口（Cursor / Codex / Claude Code / pi 都从 cwd 往上找，
不找子目录），`init` 只往里追加一小段，指向 `.workflow/`；硬规则正文在 `.workflow/AGENTS.md`，跟项目进 Git、
只写硬规则、不写本机路径；完整写法不复制，由 `miworkflow skill` 现打，换机器、升内核都不过时。

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

**原语和参数都传进来，不 import**：`run.mjs` 调 `mod.default({ script, agent, human, args, stopping })`。
`args` 来自命令行：`miworkflow <task> --issue 12 --max=5 --confirm` → `{ issue: '12', max: '5', confirm: true }`。
值一律是字符串，只写 `--flag` 就是 `true`，类型由任务自己转；`--yes`、`--dry-run`、`--every` 归内核，不进 `args`。
这样业务项目里不需要 `package.json`，同一次运行也天然只有一份 `core.mjs`（`seq` 在模块里）。

`stopping()` 不是原语：返回这次运行有没有被 `miworkflow stop <task>` 要求停下（§9）。逐个处理一批东西的任务（`dev` 逐张工单）
在「做完一个、挑下一个之前」查它，查到就正常收尾返回；不查也行，那就跑完这一次。

- 任务之间共用的东西仍可相对 import（如 `../config.mjs`）。
- 项目根目录由任务自己算（`fileURLToPath(new URL('../..', import.meta.url))`），不另外注入。
- 测任务时直接传假原语进去。

然后用 JS 自由组合：

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
- 支持 `dryRun`：`miworkflow <task> --dry-run`（或 `AGENTFLOW_DRY_RUN=1`）时，core 在 args 里注入
  `dryRun: true`，脚本自己决定怎么干跑（写操作由脚本负责跳过）
- 人话层：可选返回 `say`，缺省由 core 回落（§13）

### 6.2 agent

- 输入：结构化任务包，字段精简
- 输出：`{ status, choice, reason, data }`
- `status`：`'ok' | 'need_human' | 'failed'`
- 必须结构化 JSON；stdout 不是 JSON → core 直接判 `failed`（`choice: 'agent_invalid_json'`）；
  缺 `status` / `choice` 或 `status` 不在枚举内 → `failed`（`choice: 'agent_bad_output'`），不补默认值、不猜
- 没配 Agent（`opts.cmd` / `opts.agent` / `AGENTFLOW_AGENT_CMD` / `AGENTFLOW_AGENT` 都没有，§10）→ 不假装思考：
  `status: 'failed'`、`choice: 'agent_unavailable'`，`reason` 说明怎么配
- 内核适配器起不来 / 非 0 退出 / 没回话 → `failed`（`choice: 'agent_cli_failed'`），`reason` 写哪家、原因
- 被强制结束 → `failed`：看门狗判卡死（事件流 `budget.idleSec` 秒没动静）是 `choice: 'agent_idle'`，到 `budget.timeoutSec` 是 `choice: 'agent_timeout'`；
  `reason` 写结束时在干什么，`data` 带 `{ idleSec | timeoutSec, stuck, trace, events }`（§10.1）
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
export const title = '修复 bug';

export default async function ({ script, agent, human, args }) {
  await script('prepare', { issue: args.issue });

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

// HOME：沉淀所在（§3），run.mjs 找到后写进 env；子进程 cwd、gitSha 都取它
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
  // 组任务包（§10）→ 找命令：opts.cmd → opts.agent → AGENTFLOW_AGENT_CMD → AGENTFLOW_AGENT
  // （opts.agent / AGENTFLOW_AGENT 展开成 node agents/agent_cli.mjs <cli> ...）→ 解析 { status, choice, reason, data }
  // 输出不合契约（§6.2）或未配置 → failed，不猜默认值
  log({ primitive: 'agent', agent, events, status, choice, reason, say: reason || `agent: ${choice}` });
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
const argv = process.argv.slice(2);
const { positional: [cmd, name], args, dryRun } = parseArgv(argv);

// 内核开关早于任务分派；-v / -h 不是 -- 开头，parseArgv 会把它们当任务名
if (argv[0] === '--version' || argv[0] === '-v') process.stdout.write(`${VERSION}\n`);
else if (argv[0] === '--help' || argv[0] === '-h') process.stdout.write(`${USAGE}\n`);
else if (cmd === 'init') await init(args.template);   // §3
else if (cmd === 'new') newTask(name);                 // §3
else if (cmd === 'view') { useHome(); await import('./viewer/serve.mjs'); }
else await runTask(cmd);

async function runTask(task) {
  useHome();              // AGENTFLOW_HOME → 往上找 .workflow/ → 报错；写回 env（§3）
  // 先定 runId，再加载 core（core 里 runId 延迟解析）
  process.env.AGENTFLOW_TASK = task;
  process.env.AGENTFLOW_RUN_ID ??= randomUUID();

  const { log, script, agent, human, HOME } = await import('./core.mjs');
  const taskFile = path.join(HOME, 'tasks', `${task}.mjs`);
  if (!existsSync(taskFile)) fail(`task not found: ${task}（在 ${path.join(HOME, 'tasks')} 下找）`);

  let title = task;
  try {
    const mod = await import(pathToFileURL(taskFile).href);   // 加载失败也记一条 failed
    title = mod.title ?? task;
    log({ primitive: 'run', status: 'running', title, say: `▶ ${title}` });
    console.log(title);             // 人类可见：这次运行在干什么（§13.3）

    await mod.default({ script, agent, human, args });   // §5
    log({ primitive: 'run', status: 'ok', title, say: `✔ ${title} 完成` });
  } catch (err) {
    log({ primitive: 'run', status: 'failed', title, error: String(err.message),
          say: `✖ ${title} 失败：${err.message}` });
    process.exitCode = 1;
  }
}
```

`runTask` 起跑前按 task 建锁：`logs/<task>.lock`，内容 `{ pid, runId, at }`（`logs/` 不进 Git）。已在跑就打印
`<task> 已在跑（pid …，run …）` 并退出码 `0`——有意跳过，不是出错，不执行任务体。锁里的 pid 已不在（被杀、断电、
Ctrl-C）按陈锁接管；跨平台判活用 `process.kill(pid, 0)` + try/catch。正常结束、任务抛异常、进程收到 `SIGINT`/`SIGTERM`
都删锁。只有「跑任务」加锁，`init` / `new` / `view` / `skill` / `stop` 不加；不同 task 各锁各的。

**停止**（`miworkflow stop <task> [--now]`，viewer 上同一套按钮）按任务找目标：run 看任务锁，`--every` 外层循环另在
`logs/<task>.loop` 记 `{ pid, at }`（同一任务只留一个循环，已有就不起第二个）。都不在就打印「没在跑」。

- **缺省：做完手头这一单再停。** 写停止请求 `logs/<task>.stop` = `{ runId, loopPid, at }`（先写临时文件再改名），写明对准哪个 run、哪个循环；
  过期的请求对不上任何新 run，不会误停。run 的 `stopping()` 认「对准我的 runId」或「对准我所在的循环」（循环把自己的 pid 经
  `AGENTFLOW_LOOP_PID` 交给每一轮）；任务正常返回时 run 记 `ok`，`say` 带「收到停止请求，停下了」。循环每轮前后、等下一轮期间都查请求，
  对上了就不再起下一轮、删请求和标记、退出 0。单独的 run 结束时删对准自己的请求，循环里的 run 留给循环删。
- **`--now`：立刻强关。** 杀整棵进程树——Windows `taskkill /T /F`，其它平台用 `ps` 找出全部子孙再 `SIGKILL`（Agent CLI 常在自己的进程组里，
  杀进程组不够）。等进程真没了，再替被杀的 run 补一条终态（`primitive:'run'`、`status:'failed'`、`error` 写明被强行停止，`seq` 接着日志里最大的往下排，
  最后一行被杀成半截就另起一行），删锁、循环标记和请求。半路的步骤**不收尾**：工作区的改动、工单标签这类外部状态原样留着，由人看记录收拾。

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
    "timeoutSec": 7200,
    "idleSec": 1200,
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

会话进出（可选）：任务写 `agent(goal, { agent: { cli, session } })` 续上同一个 Agent 会话；
会话号是适配器参数（与 `model`、`thinking` 同级），**不进**发给 Agent 的 `inputs`。
适配器能交回会话号时，输出在上面四个字段之外多一个顶层 `session`；core 只把它透传进 `agent()` 的返回值、
记进该步的日志行，**不参与契约判定**（缺失或形状任意都不影响 `status` / `choice` 的校验）。
没有 `session` 时返回值仍是 `{status, choice, reason, data}`。

约束：

- 必须结构化 JSON
- 不输出 actions
- 任务 JS 根据 `choice` 分支，再调 `script()`
- 高风险业务步骤前加 `human()`

### 10.1 内核适配器 `agents/agent_cli.mjs`

`node agents/agent_cli.mjs <pi|codex|cursor> [--model m] [--thinking t] [--provider p] [--session s] [-- 其余开关]`：
一份适配器，一个参数选家。与 `viewer/` 同类的外部工具（core 不 import 它，只当命令起它）——
它带着全权限开关，放在内核仓库，不跟着业务仓库的进化一起被改。
runner 层从 exec-review 技能复制起步，之后**独立演进**，不回头同步、不依赖 exec-review。

- **选谁来干**：每次 `agent()` 都能单独指定 CLI、模型、思考等级：

  ```js
  await agent('修掉失败的测试', {
    agent: { cli: 'codex', model: 'gpt-5.5', thinking: 'high' },
    inputs: { cwd, failures, choices: ['fixed', 'give_up'] }
  });
  ```

  `opts.agent` 是对象 `{ cli, model?, thinking?, provider?, session?, args? }`，或只写 CLI 名的字符串（`'pi'` = `{ cli: 'pi' }`）。
  core 把它展开成 `node <内核>/agents/agent_cli.mjs <cli> [--model <m>] [--thinking <t>] [--provider <p>] [--session <s>] [-- ...args]`。
  - 值**原样转交**，各家换成自己的开关，不翻译、不校验：
    pi → `--model` / `--thinking` / `--provider`；codex → `-m` / `-c model_reasoning_effort=<t>`；
    cursor → `--model <m>[effort=<t>]`，**只给 `thinking` 不给 `model` 就报错**，不静默丢掉。
    `provider` 只有 pi 认，给别家就报错。值不对由 CLI 自己报错 → `agent_cli_failed`。
  - `args` 是逃生口：其余开关原样追加给那家 CLI。
  - 可执行文件默认 `pi` / `codex` / `agent`，可用 `PI_BIN` / `CODEX_BIN` / `CURSOR_AGENT_BIN` 覆盖；
    Windows 上绕开 npm 的 `.cmd` / `.ps1` 包装，直接 `node <js>` 起。
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
- **进**：§10 任务包。适配器渲染成提示词：`goal`、`inputs`、`constraints`、预算，末尾附输出契约
  （最后只回一段 `{status, choice, reason, data}`；`choice` 只取 `inputs.choices`，给了的话）。
  三家都靠提示词约束输出形状 —— codex 的 `--output-schema` 走严格模式，要求每个对象 `additionalProperties: false`，
  容不下自由形状的 `data`，所以不用。
- **出**：取最后一条回话，剥掉至多一层代码围栏；整段不是 JSON 时，**取最后一段能解析的 JSON 对象**
  （Agent 常先来一段人话总结再给契约 JSON）——只做传输层归一，不补字段、不猜形状。
  **合不合契约仍由 core 判**（§6.2），适配器不补默认值。CLI 起不来 / 非 0 退出 / 没回话 → 适配器写
  `{status:'failed', choice:'agent_cli_failed', reason}`（这是事实，不是猜）；`reason` 优先取事件流里的错误
  （codex 的错误不走 stderr），其次 stderr 首句。
- **运行目录**：`inputs.cwd`，缺省项目根（HOME 叫 `.workflow` 时取上一级，否则就是 HOME，如 `examples/`）。
  不缺省成 `.workflow/`：Agent CLI 从 cwd 找 `AGENTS.md`，落在 `.workflow/` 会读到写工作流的那份、搜不到项目代码
  （cursor 的 `--workspace` 还会把整个工作区卡在里面）。内核不加 `opts.cwd`。
- **过程**：各家事件流统一成同一种形状（`agents/normalize-event.mjs`），翻成人话写 stderr（core 已透传到终端）：
  `· <工具> <参数>`、`» <说了什么>`、`✖ <错误>`。
  提示词、原始输出、统一后的事件落在 HOME `logs/<runId>/agent-<n>.{prompt.md,log,events.jsonl,out.txt}`
  （子目录，viewer 不当成一次运行）；core 开跑前就给每次 `agent()` 分配好这个位置，写进日志的 `events` 字段
  （§13.1 的进行中记录）—— 适配器会往里写，自定义命令（`opts.cmd`）也可以不写。这顺带就是 E3「长任务过程留痕」的底子。
- **会话**（§10 的会话进出）：`opts.agent.session` → `--session <s>`，各家按 runner 的续会话能力表处理：
  - pi：给了就 `--session-id <s>`（有就续、没有就建，不再带 `--no-session`），并交回这个会话号；没给维持一次性会话（`--no-session`），不交回。
  - codex：给了就 `exec resume <s>` 续；没给就从事件流取本次会话号（`thread.started` 的 `thread_id`）交回。
  - cursor：续会话接口没验证过，不交回 `session`；传了 `session` 按「续不上」处理，开跑前就判。
  - 续不上（会话不存在 / CLI 不支持续）→ `{status:'failed', choice:'session_not_found', reason:'<哪家> 续不上会话 <s>：<原因>'}`。
    会话不存在靠 CLI 失败时的错误文本识别（`agents/session.mjs`），认不出的仍是 `agent_cli_failed`。
  - 交回的会话号写在回话 JSON 顶层 `session`；回话不是 JSON 对象时原样交给 core 判（§6.2）。
- **预算**：`timeoutSec` 与 `idleSec` 真生效 —— 适配器到点杀整棵进程树，core 在 `timeoutSec + 5` 秒兜底；
  `maxTokens` / `maxTurns` 三家都没有对应开关，只写进提示词。默认 7200 秒（2 小时），按改代码这类长活定的；
  短活想早点失败就显式给小一点的 `budget: { timeoutSec }`。
- **看门狗**（`idleSec`，默认 1200，`0` 关掉）：事件流连续这么多秒没有任何一条事件（含命令输出的增量）就杀整棵进程树。
  各家 CLI 的单条命令都可以没有超时（pi 的 bash 工具缺省不设），一条全盘 `find /` 就能让整个 Agent 干等到 `timeoutSec`，
  看门狗按「多久没动静」而不是「总共多久」判。
- **被强制结束的交回**：卡死 `{status:'failed', choice:'agent_idle', reason, data}`，超时同形、`choice:'agent_timeout'`：
  `data.stuck` = 最后一个开跑了还没跑完的工具调用 `{ toolName, args, sinceSec }`（没有就是 `null`，停在等模型），
  `data.trace` = 过程摘要 `<base>.trace.md`（最后 300 行工具调用与回话，给诊断用），`data.events` = 完整事件流，
  另带 `idleSec` / `timeoutSec`。提示词的预算段写明看门狗，让 Agent 别跑可能很久不返回的命令。
  被结束后怎么办由任务决定（`dev` 的做法见 §15）。
- **权限**：三家都全权限（§10）：pi 不排除工具；codex `--dangerously-bypass-approvals-and-sandbox`；
  cursor `--force --approve-mcps --sandbox disabled --trust`。
- **`choice` 不由 core 校验**：不加 `opts.choices`。可选值放 `inputs.choices` 给适配器渲染，
  未知 `choice` 由任务 JS 自己 `throw`（§7 的写法）。

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
  "agent": { "cli": "codex", "model": "...", "thinking": "..." },
  "label": "开发Agent",
  "goal": "...",
  "inputs": { "...": "..." },
  "events": "<runId>/agent-1.events.jsonl",
  "durationMs": 0
}
```

`label` / `goal` / `inputs` 是给 viewer 展开后看「输入信息」用的（§13.6）：`label` 是节点短名（`agent` 的节点名，不是提示词），
`goal` 是 `agent()` 的提示词全文，`inputs` 是 `agent()` / `script()` / `run` 收的入参。

`agent` / `events` 只出现在 `agent` 记录上：`agent` 仅在走内核适配器时带上；`events` 在每次有外部命令的 `agent` 调用上都带（开跑前的进行中记录也带），指向 core 预先分配的过程文件，适配器往里写归一事件（§10.1、§13.1）。进化时才看得出「哪个模型在哪类任务上老失败」，
复盘时能展开 Agent 每一步。

原则：

- 只记录必要信息（必要 = 足够让人复盘）
- 人可读、可复盘，人与 AI 据此共同迭代（UI 在外部，内核不内置）
- 每条记录带 `say`：一句话人话，规则见 §13
- 一次运行一个 `runId`，三个原语共用，可按运行复盘
- `seq` 在本次运行内单调递增，是稳定 key；`ref` 指向被解决的那条进行中记录（`human` 的 `pending` / `agent` 的 `running`，§13.1）
- `primitive: 'run'` 的两条记录（开始 / 结束）由 `run.mjs` 写，`title` 只出现在这里
- 任务锁落在 `logs/<task>.lock`（占用标记，不是日志、不进 Git），约定见 §9；同类的还有循环标记 `logs/<task>.loop` 与停止请求 `logs/<task>.stop`
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
| `agent` | 终态取 Agent 已有的 `reason`；进行中取任务给的 `label`（节点短名，缺省 `Agent`），提示词全文记在 `goal`（§13.6） |
| `human` | 就是 `prompt` 本身 |

三条硬规则：

1. **动作发生后才写**，陈述已发生的事实，不是计划、不是承诺。
   边界：**进行中记录**（`status:'running'` / `'pending'`）写的是「动作已经开始」这一既成事实，
   不是对结果的承诺。`human` 的 `pending`（§13.5）与 `agent` 的 `running` 都属此类：
   开跑前先写一条，带上此时已能算出的字段（如 `agent` 的 `events`），结束后再写一条带 `ref` 指回它的终态行。
2. **不许凭空手写**：`say` 只能由动作结果或动作输入翻译而来（脚本返回 / `reason` / `prompt` / `label`）；
   禁止在任务文件里写 `say('正在努力…')`。进行中记录优先用输入的 `label`（提示词太长，当节点名会淹掉时间线，全文放 `goal`）；
   编不出人话就不写 `say`，只留 `status:'running'` 由前端显示「进行中」。
3. 一句话，不懂技术的人也能看懂。

### 13.2 实时

两档，任选，看到的是同一份数据：

```bash
tail -f .workflow/logs/$RUN.jsonl | jq -r .say   # CLI，零成本
miworkflow view                                  # 网页，§13.6
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
viewer/serve.mjs    零依赖静态服务 + 六个只读接口 + 三个写接口
viewer/index.html   单文件视图：任务列表与运行按钮 / 可按任务筛的 run 列表 / 在跑的 run 上的停止按钮 / 可折叠 trace 时间线（展开分输入·输出·执行三段）/ 待决定卡片
```

接口只有九个：

| 接口 | 作用 |
|---|---|
| `GET /api/tasks` | 列 HOME 的 `tasks/*.mjs` 与 `title`（正则读 `export const title`，**不 import**，免得执行任务模块） |
| `POST /api/run` | `{ task, args? }` 起 `run.mjs <task> --key=value…`：预先生成 `runId` 回给页面直接跳过去；子进程 `AGENTFLOW_HUMAN=web`（审批走同一页面）；stdout/stderr 落 `logs/<runId>.out.log` |
| `GET /api/runs` | 列出 run：标题、状态、待决定数 |
| `GET /api/run/<id>?from=N` | 从第 N 字节起吐日志，只吐完整行；日志还没生成就吐空 |
| `GET /api/run/<id>/events/<n>?from=N` | Agent 某一步的过程事件；带 `from` 按字节增量吐 `{ next, items }`（半行 / 文件没建都稳），不带 `from` 吐全量数组（§10.1） |
| `POST /api/decide` | 写决定文件（§13.5） |
| `POST /api/stop` | `{ task, now? }` 起 `run.mjs stop <task> [--now]`，回 `{ ok, message }`（message 是它打印的话）；页面在跑的 run 上给「做完这单停 / 立刻强关」，强关先确认（§9） |
| `GET /health` | 存活探针，给反代 / 脚本用 |
| `GET /` | 视图页 |

几个刻意的选择：

- **实时靠 1 秒轮询 + 字节偏移增量拉取，不用 SSE。** 反代零坑，断线重连天然正确，
  最后一行没写完就留到下次（服务端只吐完整行）。`agent` 的进行中记录开跑前就写、提前带 `events`，
  所以「过程 ▸」一开始就能点；展开的过程跟着同一个轮询按字节续读，步骤到终态就停。
- **服务端零业务判断。** 待决定状态由前端重放日志算出（`pending` 没被 `ref` 解决掉就算待决定）。
  同一任务在跑时按钮置灰也是前端从 run 列表算的，只是提示，不是占用机制（被杀掉的 run 会一直显示在跑，
  所以点了只再确认一次，不拦）。
- **运行记录按任务筛。** 常驻任务（`discuss --every 10s`）会淹掉别的，侧栏给一排「全部 / 各任务」开关
  （多选，空集 = 全部，选择存 `localStorage`）；只有一个任务时不占地方。筛选只在客户端做，服务端不加接口。
- **每条 trace 默认收缩成一行**（`badge` + 名称 + 时间 / 耗时），点击整行展开三段：**输入 / 输出 / 执行**。
  任何一行展开都该看得到这三类（没值的段显示「—」）：`script` 的输入是 `inputs`，`agent` 的输入是 `goal`（提示词全文），
  `run` 的输入是任务名 + `inputs`；终态行（带 `ref`）的输入 / 过程从它指回的进行中记录上取。
  `agent` 行的节点名取 `label`（任务给的短名，如「开发Agent」），提示词不当节点名、只在展开后的「输入」里看。
  头部一个「默认展开」勾选框（存 `localStorage`，刷新仍生效）。没手动点过的行跟随全局默认，手动点过的行尊重手动状态。
- **`POST /api/run`、`POST /api/stop` 默认只收本机请求。** viewer 默认监听 `0.0.0.0`，局域网的人只能看和审批；
  能起任务就等于能起全权限 Agent，强关会丢掉半路的活，要放开得显式设 `MIWORKFLOW_REMOTE_RUN=1`。

启动：`miworkflow view`（用找到的 HOME）；或 `AGENTFLOW_HOME=<HOME> node viewer/serve.mjs`。`HOST=0.0.0.0` 即内网可访。

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

### 14.1 内核边界

「只往 HOME 沉淀，不改内核」靠**仓库分离**，不靠审批机制：内核与沉淀是两个仓库（§3），
进化闭环在业务仓库里改、测、提交，本来就碰不到内核。内核有改动，走内核仓库自己的 Git 与 `node --test`。

v1.7 曾有一道审批护栏（`guard.mjs` + `core.lock.json`：内核哈希、终端 `approve`、起跑前拒跑），
仓库分离之后收益小于摩擦，已删除（§2.12）。要物理级隔离，用只读挂载 + 可写卷 —— 那是操作系统的事。

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
AGENTFLOW_HOME=examples node run.mjs demo --who 你
```

示例任务不 import 内核（§5），拷进业务仓库的 `.workflow/tasks/` **一个字不用改**，测试断言它。
正式内容在业务仓库的 HOME 里由使用中沉淀。

**模板**：`templates/<名字>/` 是一份完整的 HOME 片段（`tasks/`、`scripts/`、配置常量），**只在 `init` 时复制**，
不默认加载 —— 跟 §16「不内置具体任务 / 脚本」不冲突。模板的 bug 与契约只在内核仓库里改、带测试；
已经 `init` 过的项目用 `miworkflow init --upgrade` 跟上（2026-09-30 起；此前是「复制过去各自演进、不回头同步」，
结果同一个 bug 要在两处各修一遍）。归项目的只有配置：`config.mjs`、`source.mjs` 里一行写完的 `export const`
（升级时原样保留）、`prompts/local/<dev|review|fix|diagnose>.md`（项目对各 Agent 的补充要求，接到对应提示词的 `{{local}}` 处），
以及项目自己加的任务 / 脚本；想改模板行为就把它做成一行常量或补充要求，别直接改模板文件，下次升级会被覆盖（有备份）。
模板的测试留在内核仓库的 `tests/template-*.test.mjs`（假外部命令 / 假 Agent / 临时 git 仓库），保证复制出去的那一刻是好的。`init` 按组合复制：先复制共用模板 `templates/_shared/`（两个任务 `dev` / `discuss`，讨论提示词 `prompts/grilling|spec|tickets.md`，开发提示词 `prompts/dev|review|fix|diagnose.md`，git 脚本、`run_cmd`、`config.mjs`），再复制所选工单源；以 `_` 开头的目录不出现在模板菜单与 `--template` 里。

工单源的约定就是三个脚本名 + 输入输出（不做抽象层，TODO F2）；`dev` 只调它们，不知道背后是哪家。工单号一律字符串，日志 / 评论 / 提问里用工单引用 `ref`：

| 脚本 | 入 | 出 |
|---|---|---|
| `ticket_ready` | `{}` | `{ ready: [{ id, ref, title, priority }], blocked: [{ id, ref, reason }] }`（已排序：优先级 → 工单号） |
| `ticket_view` | `{ id }` | `{ id, ref, title, file, review }`：写出**工单快照**；`review` 是这张单有没有「要审查」标签 |
| `ticket_mark` | `{ id, action, commentFile?, comment?, sha? }` | `action` = `claimed` / `done` / `failed` / `unpushed` / `released`（Agent 连接失败：摘认领、不贴失败、保留入队，下轮重做）；评论由调用方给整段（`comment` 在前、`commentFile` 在后，原样发），两样都没给才用一句缺省 |

三个脚本失败时，若是**工单系统暂时不可用**（5xx、网络、限流，脚本内已退避重试用完），出参 `data` 带 `transient: true`；`dev` 据此整轮停下、不计入失败、不回滚已推送的代码。其他失败不带。

讨论流程同理，也是固定四个脚本名；`discuss` 任务只调它们，不知道背后是哪家。
任务认的是**规范形状**，源负责与自家存储形态互转——spec 放哪（GitHub：正文的机器区域；TAPD：一条标记评论）、
AI 记账标记长什么样（GitHub：评论末尾的 HTML 注释；TAPD：剥 HTML 注释，得用别的形态）、开发单清单放哪，都是各家自己的事：

| 脚本 | 入 | 出 |
|---|---|---|
| `discuss_list` | `{ enter, grilling, spec, cursor? }` | `{ items: [{ id, ref, title, labels, changed? }], cursor? }`：打开、贴了 `enter`、阶段标签空或 `grilling` / `spec`，按工单号升序。增量可选：源交回 `cursor`（内容归源，任务原样存、下次原样带回），给了 `cursor` 就按它给每张单标 `changed`（有新的人的评论或单子改过）；不支持增量的源两样都不给，任务就每张都读 |
| `discuss_view` | `{ id }` | `{ id, ref, title, body, spec, labels, comments }`。`body` = 人写的正文（机器区域与机器评论已去掉）；`spec` = 当前 spec 或 `null`；`comments` = `[{ id, author, at, text, ai, mark }]`，`ai` 是「这条是不是 AI 发的」，`mark`（AI 才有）= `{ hash, seen, cli, session, body }` 记账字段 |
| `discuss_post` | `{ id, body?, mark?, spec?, setTickets?, addLabel?, removeLabel? }` | `{ did: string[] }`：发评论（末尾由源附上 `mark`）/ 写 spec / 写开发单清单 / 贴摘标签，都可选、按序做 |
| `tickets_create` | `{ parentId, tickets: [{ key, title, body, priority, review, blockedBy }] }` | `{ tickets: [{ key, id, ref, title }], problems: string[] }`：**建单 / 贴标签 / 写依赖 / 回查都在脚本里**；`problems` 非空 = 没建好（可能部分建出来了），任务据此不改阶段 |

拆单与开发一样：Agent 不碰工单系统，只交 `data.tickets` 结构（`key` / `title` / `body` / `priority` / `review` / `blockedBy`），
建单与依赖由 `tickets_create` 落地——TAPD 的依赖只能直连 OpenAPI 写（`tapd-cli` 没封装），Agent 做不了（TODO F4）。

- **工单快照**（读）：正文 + 全部评论转成 Markdown，写到 `logs/<runId>/tickets/<id>/ticket.md`，图片下到同目录 `images/`、相对路径引用；Agent 的 `inputs` 只给路径，自己读。
- **回帖稿**（写）：`dev` 每次调 Agent 前分配 `logs/<runId>/tickets/<id>/reply-<n>.md`，提示词要求**必写**（写给没看过过程的人：做了什么、关键取舍、怎么验证的、遗留风险；图片放同目录、相对路径）。
  失败时 `afk failed：<完整原因>` + 那次的回帖稿；完成 / 未推送时 `dev` 把各份回帖稿（没写就用 Agent 回话的 `reason`）拼起来，
  再补一段工作流落款（改了哪些文件、审查、验证、提交号），写成同目录的 `comment.md` 交给 `ticket_mark` 的 `commentFile`。
- **提交**：Agent 不提交，只在回话 `data` 里给 `type`（从 `source.mjs` 的 `COMMIT_TYPES` 选）和 `summary`；审查、验证、`--confirm` 之后由 `dev` 统一提交，
  一张工单一笔（`git_commit` 收 `baseSha`，Agent 自己做的提交先 `reset --soft` 压进来）；提交后回读，标题被钩子改了或带 AI 署名（`Co-authored-by` / `Made-with` 等）判失败回滚。
- **审查按需**（`config.mjs` 的 `REVIEW`，缺省 `'auto'`）：工单贴了「要审查」标签（`source.mjs` 的 `LABELS.review`）、或 DEV 回话选 `done_review` 主动升级，才起审查 Agent；
  否则 DEV 完成后直接进验证 / 提交。`REVIEW = 'always'` 恢复「每张都审」。DEV 只能升级不能降级，`prompts/dev.md` 列了该升级的情形。
- **被强制结束**（§10.1 的 `agent_idle` 卡死 / `agent_timeout` 超时；卡死阈值 `config.mjs` 的 `AGENT_IDLE_SEC`）：不重试，两种走同一条路。
  诊断 Agent（只读，`prompts/diagnose.md`，自己的看门狗 300 秒）趁半成品还在，读过程摘要查为什么没做完、进展到哪、下次怎么做
  （卡死时重点查那条命令为什么不返回，超时时重点查时间花在哪、要不要拆单），写成诊断稿 →
  `git_restore` 回滚，回滚前把改动存成同目录 `killed-<n>.diff` →
  评论（开头 `Agent 被强制结束（第 n 次，卡死|超时；…）`：适配器记的结束时在干什么 + 诊断稿 + diff 位置）→ `released`、整轮停下。
  下轮接单的 Agent 从工单快照的评论里读到诊断，`prompts/dev.md` 要它换个做法。第几次 = 快照里以这句开头的评论数 + 1（卡死、超时合并计数），不另加标签；
  满 `AGENT_KILL_LIMIT` 次（缺省 3）改为 `failed` 转人工——评论只能降低重犯的概率，次数上限才挡得住死循环。诊断没跑成，评论照发，只是没有诊断稿。
- **机器标签**（名字在各工单源的 `source.mjs`，可改）：入队 `ready-for-agent`；`afk-claimed`（认领中）/ `afk-delivered`（已交付）/ `afk-failed`（失败）。依赖满足 = 前置单贴了 `afk-delivered` 或已关单（TAPD：已到结束类状态）。
- 每个工单源带 `source.mjs`：这家的常量 + `COMMIT_TYPES` / `COMMIT_FORMAT` / `COMMIT_BODY` + `commitMessage(ticket, { type, summary })`；共用的 `config.mjs` 只留 `DEV / REVIEWER / REVIEW / VERIFY / ROUNDS / PUSH / AGENT_RETRY_DELAYS / AGENT_IDLE_SEC / AGENT_KILL_LIMIT / DISCUSS_IDLE_MAX_SEC`。

已实现的工单源：
`templates/github/` = GitHub（`ticket_*` 脚本、讨论流程的 `discuss_*` 脚本、`source.mjs`；配合共用的 `dev` 与 `discuss`：认领 issue → 开发 →（要审查的单子）审查 → 验证 → 提交 → 关单 + 贴 `afk-delivered`；讨论单贴 `agent-discuss` → 评论区逐轮追问 → `/spec` 写进正文 → `/tickets` 建开发单，见 TODO C3、F2、F4）。
回帖稿带图时用 `gh issue comment --attach` 上传，要 `gh` ≥ 2.99.0；只在确实有图时查版本，不够就把图片换成「图片未上传」占位、`say` 提示升级，评论照发。

`templates/tapd/` = TAPD（`ticket_*` + `discuss_*` 脚本、`scripts/_tapd.mjs` / `_discuss.mjs`、`source.mjs`；`dev` 与 `discuss` 都是共用的，TODO F3、F4）。三个 `ticket_*` 的 TAPD 实现：

- 调用：`execFileSync` 起 `tapd-cli`（不经 shell，瞬时错误最多重试 2 次；`MIWORKFLOW_TAPD` 可换成一个 JS 文件）；`tapd-cli` 没封装或取不全的
  （评论完整 HTML、前后置依赖、工作流结束状态）直连 OpenAPI：`$TAPD_API_ENDPOINT` + `Authorization: Bearer $TAPD_TOKEN`，报错信息里令牌打码。
- `ticket_ready`：只接需求，一次 `story list label=<ready>` 拿全部候选；优先级按中文档位映射（高 1 / 中 2 / 空 2 / 低 3，不认识的当 2 并提示）；
  空壳需求（描述与评论都空）进 `blocked` 并贴 `afk-failed` + 评论；依赖 = TAPD 原生前后置，前置贴了 `afk-delivered` 或已到结束类状态才满足
  （结束类状态先按工作流 `workflows/last_steps` 取，取不到退回 `source.mjs` 的 `END_STATUSES`），不认识的前置当挡住。
- `ticket_view`：描述与评论 HTML 转完整 Markdown，图片经 `attachment get-image` 下载、按魔数定扩展名。
- `ticket_mark`：标签多值用 `|` 分隔，写完回读校验；评论要评论人（`COMMENTER` / `TAPD_NPC_ROLE`），缺了在改标签之前报错；
  回帖稿的图逐张 `upload-image` 换成 TAPD 图片地址再 `comment add`，发完经 OpenAPI 回读（`tapd-cli comment add` 出 `{ ok, id }`；
  `id` 为空时按创建时间倒序找评论人最新的一条）。`done` **不关单**：只贴 `afk-delivered`，状态由人验收后流转。
- `source.mjs`：`WORKSPACE_ID`、`COMMENTER`、`LABELS`、`END_STATUSES`、`PRIORITY`；`ref` 为 `story <需求ID>`；
  提交信息缺省 `{type}:{short} {summary}`（`short` = 需求 ID 后 7 位，即 TAPD 界面上的短号），要源码关联可改成 `--story={short} {summary}`。

四个 `discuss_*` 的 TAPD 实现（同一个 `discuss` 任务，规范形状见上表）：

- **AI 记账标记**是评论末尾一行**纯文本** `[miworkflow:discuss hash=… seen=… cli=… session=… body=…]`——TAPD 会把评论里的 HTML 注释整个剥掉（TODO F4.1），所以不能像 GitHub 那样用隐藏注释；读回来经 `htmlToMarkdown` 就在末尾那行。
- **spec 落在评论里**（`kind=spec` 那条，最新一条就是当前 spec），**不写需求描述**：`story update description=` 不幂等，每写一次外层多包一层 `<p>`（TODO F4.1）。写的时候先发 spec 评论、再发回复评论，判轮认的「最后一条 AI 评论」才是本轮那次。
- **阶段标签**走 `story update label=`，多值用 `|` 分隔，**写完回读校验**（写成逗号会被当成一个新标签名）；标签名不存在时 TAPD 隐式创建，不用预建。
- **建开发单**：`story add parent_id=<讨论单>` 建子需求，标签 `ready-for-agent` + 可选的「要审查」，优先级 `P0/P1 → 高、P2 → 中、P3/P4 → 低`（TAPD 只有三档）；正文 Markdown 直接交给 `description`（tapd-cli 会转 HTML）。
- **依赖**落成原生前后置：直连 OpenAPI `POST /stories/save_time_relations`，**必须 form-encoded**（`relations[0][workitem_id]` / `[dst_workitem_id]` / `[src_field]=due` / `[dst_field]=begin` + `current_user`），JSON body 报 422。回查时逐个子需求读 `get_time_relative_stories`，前置必须是这批里的、且不能是讨论单自己。
- `discuss_list` 靠标签而不是状态：贴了 `agent-discuss`、阶段标为空或 grilling / spec 才处理；ticketed 或摘掉 `agent-discuss` 就退出（TAPD 没有「打开 / 关闭」这个开关）。
- **省调用额度**（个人令牌 2000 次 / 24 小时，429 `API request limit exceeded`）：`discuss_list` 做增量，`cursor` = 各需求的 `modified` + 见过的最大评论 ID；
  每次两次请求（`story list` + 全项目按创建时间倒序的 `/comments`），带 AI 标记的评论不算动静，改旧评论不算。额度用完不退避重试，直接报工单系统暂时不可用。
  节奏归共用的 `discuss` 任务：只在 `--every` 循环里（认 `AGENTFLOW_LOOP_PID`），间隔 = 距上次有动静 ÷ 4、最长 `DISCUSS_IDLE_MAX_SEC`，没到点的一轮不碰工单系统，
  记账在 `logs/discuss.pace.json`；单跑一次照旧全量。

`templates/beads/` = [beads](https://github.com/steveyegge/beads)（`ticket_*` + `discuss_*` / `tickets_create` 脚本、`scripts/_bd.mjs` / `_discuss.mjs`、`source.mjs`；`dev` 与 `discuss` 都是共用的）。三个 `ticket_*` 的 beads 实现（按 `bd` 1.1.2 实测）：

- 调用：`execFileSync` 起 `bd`（不经 shell）；`source.mjs` 的 `BD` 可写路径，空则 PATH 上的 `bd`——Windows 上 npm 全局装的是 `.cmd` / `.ps1` 包装、起不来，改找 `@beads/bd/bin/` 里的 `bd.exe` / `bd.js`；`MIWORKFLOW_BD` 可换成一个 JS 文件。
  库被锁、dolt server 连不上、超时按 `BD_RETRY_DELAYS` 退避，用完标 `transient`。`ACTOR` 非空时每条命令带 `--actor`。
- `ticket_ready`：一次 `bd list --limit 0`（只列没关的单；不带 `--limit 0` 只给 50 条）；只接状态 `open` 的单；优先级就是 beads 的 0~4；
  依赖只认 `blocks` 类，前置已关单（不在列表里）或贴了 `afk-delivered` 才满足；父单还有没做完的子单进 `blocked`（父单当容器，子单照常入队）。
- `ticket_view`：`bd show`（不带评论）+ `bd comments`，快照带描述、设计 / 验收标准 / 备注与全部评论；本地库，图片不下载。
- `ticket_mark`：状态跟着标签走——认领改 `in_progress`，失败 / 释放改回 `open`，`done` 贴 `afk-delivered` 并 `bd close`（`--reason` 带提交号）；
  评论写成文件经 `bd comments add -f` 发（多行、长文都不经命令行）；beads 没有附件，回帖稿里的本地图片换成绝对路径。
- `source.mjs`：`BD`、`ACTOR`、`LABELS`、`BD_RETRY_DELAYS`、`DISCUSS`；`ref` 就是 beads ID；提交信息缺省 `{id} {summary}`，可改成 beads 习惯的 `{summary} ({id})`。

四个 `discuss_*` 的 beads 实现：

- **形态同 GitHub**：beads 存纯文本、HTML 注释原样保留（实测），spec 与开发单清单写进描述（description）的两个机器区域，AI 记账标记是评论末尾的 HTML 注释；描述经 `bd update --body-file`、评论经 `bd comments add -f` 写，都不经命令行。
- **建开发单**：`bd create --parent <讨论单> --no-inherit-labels`，标签 `ready-for-agent` + 可选的「要审查」，优先级 `P0`~`P4` → 0~4，依赖 `bd dep add <开发单> <前置>`（blocks）。
  子单缺省继承父单标签（`agent-discuss`、阶段标签跟过去，开发单就成了讨论单），所以必须带 `--no-inherit-labels`，回查时也核对没继承讨论单的标签；
  回查还核对父单、优先级、前置正好是这批里该有的那几张、不依赖讨论单、不成环。
- `discuss_list`：`bd list --label <enter> --limit 0`（只列没关的单），阶段过滤同 GitHub；本地库没有调用额度，不做增量。讨论单由人 `bd close`。

---

## 16. 内核明确不做

- 不内置具体任务（示例只在 `examples/`，模板只在 `init` 时复制，§15）
- 不内置具体脚本（同上）
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
9. ~~内核护栏：`core.lock.json` + `guard.mjs`~~ —— 仓库分离后删除（§14.1）。
10. 后续只往 HOME 的 `tasks/` 和 `scripts/` 沉淀（可从拷 `examples/` 起步），不改内核。
11. 自动进化 v2 再议。
12. ✅ v1.7 沉淀离开内核仓库：HOME、包名 import、`bin`、`examples/` 即 HOME（§3、§15）。
13. ✅ v1.7 零配置使用：全局命令、原语与 `args` 传参、往上找 `.workflow/`、`init`（选模板）/ `new` / `view`、网页运行按钮、`SKILL.md`（§3、§5、§13.6、§15）。
14. ✅ v1.7 运行期 Agent 适配器：`agents/agent_cli.mjs`（pi / codex / cursor）、`opts.agent`、`AGENTFLOW_AGENT`（§10.1）。
15. ✅ 首个工作流：GitHub 开发，作为 `init` 可选的模板 `templates/github/`（TODO C3，已实现）。
    人是给 issue 贴 `ready-for-agent`；任务 `dev` 逐个「认领 → 开发 →（要审查的单子）审查 → 验证 → 提交 → 关单」，
    失败回滚 + 贴评论 + `afk-failed`。测试留内核仓库（假 gh / 假 Agent / 临时 git 仓库）。
    回滚不销毁提交：`base..HEAD` 的提交先备份成 `refs/afk-backup/*` 再回滚，ref 写进失败评论（TODO B7）。
16. ✅ 工单源接口（TODO F2）：模板拆成 `_shared` + 工单源、`init` 组合复制；`github_dev` → `dev`；
    `ticket_ready` / `ticket_view` / `ticket_mark`；工单快照 + 回帖稿；机器标签统一（§15）。
17. ✅ TAPD 开发（TODO F3）：`templates/tapd/`，`dev` 接 TAPD 需求；只接需求、原生前后置依赖、完成不关单（§15）。
    测试用假 `tapd-cli` + 假 OpenAPI，与 GitHub 同一套场景；源码关联写法、每日配额、结束类状态待真项目实测。

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

## 19. v1.7 变更记录

> 2026-09-29 拍板的设计，均已实现并折进正文；这里只留去向与起因。

### 19.1 沉淀离开内核仓库（已实现）

已折进 §3（HOME、业务仓库布局）、§5 / §7（包名 import）、§9、§14、§14.1（内核边界）、§15（`examples/` 即 HOME）。
起因：旧版要求 `tasks/`、`scripts/` 为空、测试查文件系统，而进化闭环又要沉淀后测试通过、提交进 Git ——
内核仓库与沉淀仓库是同一个，两条不可能同时成立。

### 19.2 运行期 Agent 适配器（已实现）

已折进 §3（`agents/`）、§6.2（`agent_cli_failed`）、§9、§10.1（适配器全文）、§12（`agent` / `events` 字段）。
与拍板时的差别：codex 不用 `--output-schema`（严格模式容不下自由形状的 `data`，实测被 API 拒绝），三家都靠提示词。

### 19.3 零配置使用（已实现）

已折进 §3（装 / 写 / 跑、HOME 往上找、`init` / `new` / `view`）、§5（原语与 `args` 传进来）、§7、§9、§13.6（任务列表与运行按钮）、§15（模板）。
起因：v1.7 的业务项目要手建 `.workflow/`、手写 `package.json`、`npm install`、`cd` 进去再 `npx` —— 根子在任务要 `import 'miworkflow'`。
以后真要按项目锁版本，再允许 `.workflow/` 里放 `package.json` 作进阶用法。

### 19.4 不变的

三个原语的签名与返回、§6.1 脚本协议、§6.3 / §13.5 决定通道、§12 日志字段、§16 的全部禁令。
