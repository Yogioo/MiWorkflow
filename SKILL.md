---
name: miworkflow
description: 在业务项目里用 MiWorkflow 写、改、跑工作流（.workflow/tasks、.workflow/scripts）。用户要新建或修改 MiWorkflow 任务、把一段重复流程固化成任务、或给任务加脚本时加载。
---

# MiWorkflow：写任务

规范以内核仓库的 `Core.md` 为准；这里只讲写任务要知道的。

## 放哪

项目根下的 `.workflow/` 就是 HOME（没有就先跑 `miworkflow init`）：

```text
.workflow/
  AGENTS.md             # 给 AI 的入口（init 放的），可以按项目补充约定
  tasks/<name>.mjs      # 任务：编排步骤
  scripts/<action>.mjs  # 脚本：一个原子动作
  tests/                # 脚本和任务的测试（node:test）
  logs/                 # 运行记录，自动建，不进 Git
```

只改 `.workflow/` 里的东西，不改内核（全局装的 `miworkflow`）。`.workflow/` 里没有 `package.json`，
任务**不 import 内核**。

## 怎么拆

- 确定的步骤（跑命令、调 API、改标签、提交）→ 写成 `scripts/<action>.mjs`，按动作命名（`run_tests`、`git_commit`），不按任务命名。
- 模糊的整段（读代码定位问题、改代码、审查、写总结）→ 交给 `agent()`，它自己动手，只把结构化选择交回来。
- 高风险步骤（提交、推送、改生产）之前 → `human()`。
- 能写规则就别用模型；流程就是普通 JS（`if` / `for` / `try` / `Promise.all`），不造 DSL。

## 任务

`miworkflow new <name>` 建骨架。原语和命令行参数都由 `run.mjs` 传进来：

```js
export const title = '跑测试，挂了就修';   // 人看得懂的一句话，viewer 和终端都显示它

export default async function ({ script, agent, human, args }) {
  const r = await script('run_tests', { filter: args.filter });
  if (r.status === 'ok') return;

  const fix = await agent('测试失败，定位并修复', {
    inputs: { failures: r.error, choices: ['fixed', 'give_up'] }
  });
  if (fix.status === 'need_human') return human(fix.reason);
  if (fix.choice !== 'fixed') throw new Error(`没修好：${fix.reason}`);

  if ((await human('测试修好了，提交？')).status === 'ok') await script('git_commit', { message: fix.reason });
}
```

- `args`：`miworkflow fix_tests --filter login --confirm` → `{ filter: 'login', confirm: true }`。
  值一律是字符串，类型自己转；`--yes`、`--dry-run` 归内核，不进 `args`。
- 项目根目录自己算：`fileURLToPath(new URL('../..', import.meta.url))`。
- 任务之间共用的常量放 `.workflow/` 下的普通模块，相对 import（如 `../config.mjs`）。
- 任务里抛异常 = 这次运行失败，会记进日志。

## 三个原语的契约

**`script(name, args?, opts?)`** 调 `scripts/<name>.mjs`，子进程 cwd 是 HOME。脚本：

- stdin 读 JSON 参数，stdout 只写一段 JSON：`{ status: 'ok' | 'failed', say?, data?, error? }`；日志写 stderr
- 退出码非 0 即判失败
- `say`：一句人话，陈述已经发生的事（「跑了测试：3 个失败」）
- 参数里有 `dryRun: true` 时，写操作只报会做什么、不真做

```js
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const args = raw ? JSON.parse(raw) : {};
// ... 干活 ...
process.stdout.write(JSON.stringify({ status: 'ok', say: '...', data: {} }));
```

**`agent(goal, { agent?, inputs?, constraints?, budget? })`** 返回 `{ status: 'ok' | 'need_human' | 'failed', choice, reason, data }`。
按 `choice` 分支，未知的 `choice` 自己 `throw`。可选值放 `inputs.choices`。Agent 不输出 actions，它自己改文件。

- **谁来干**：`agent: { cli: 'pi' | 'codex' | 'cursor', model?, thinking?, provider?, args? }`，或只写 CLI 名 `'codex'`。
  不写就用本机的 `AGENTFLOW_AGENT`。cursor 的 `thinking` 必须配 `model`；`provider` 只有 pi 认。
  多个任务共用的配置写成 `.workflow/agents.mjs` 里的普通常量（`export const DEEP = { cli: 'codex', thinking: 'high' }`），任务 import 它。
- **在哪干**：`inputs.cwd`（通常是项目根），缺省 `.workflow/`。
- **超时**：默认 `budget.timeoutSec` 是 7200（2 小时），够改代码、审查这类长活；短活想早点失败就给小一点的值。
- **失败怎么看**：`agent_unavailable` = 没配 Agent；`agent_cli_failed` = CLI 起不来 / 报错 / 超时 / 没回话（`reason` 写了原因）；
  `agent_invalid_json` / `agent_bad_output` = 回话不合契约。都是 `failed`，不要假装它成功了。
- 重试时把上一次的 `reason` 放进 `inputs`：每次 `agent()` 都是新上下文。

**`human(prompt, { answer?, timeoutMs? })`** 返回 `{ status: 'ok' | 'skipped' | 'failed' }`。
终端里就地问 y/N，没终端就等网页点；`--yes` 全部自动通过。

## 测试

脚本配 `node:test` 测试，放 `.workflow/tests/`。测任务时直接传假原语：

```js
import task from '../tasks/fix_tests.mjs';
const calls = [];
await task({
  script: async (name, a) => (calls.push(name), { status: 'ok' }),
  agent: async () => ({ status: 'ok', choice: 'fixed', reason: '' }),
  human: async () => ({ status: 'ok' }),
  args: {}
});
```

## 跑

```bash
miworkflow <task> [--key value]    # 项目里任意子目录都行，往上找 .workflow/
miworkflow view                    # 网页：点运行、看每一步、审批
```

不要做：改内核、给任务写 `import 'miworkflow'`、在任务里手写 `say`、让 Agent 返回待执行的命令列表。
