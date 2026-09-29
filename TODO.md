# TODO

来源：2026-09-28 关于「初始工作流创建」与「自进化」的两轮讨论；2026-09-29 与 MiCan 对比后定下
「以 MiWorkflow 为主线，把 MiCan 踩过的坑当需求清单」。规范以 `Core.md` 为准。

---

## 推进顺序

1. ✅ **B2 沉淀离开内核仓库**（已实现，见 `Core.md` §3、§15）
2. **B3 零配置使用**（已定，设计见 `Core.md` §19.3）—— 排在 C2 前：它改任务写法（import → 传参），
   趁还没有真实任务改最便宜
3. **C2 运行期 Agent 适配器**（已定放 `agents/`、choice 不由 core 校验，设计见 `Core.md` §19.2）
4. **C4 首个真实工作流：Unity 跑测试 → 修 → 确认 → 提交**
5. A0 → A1–A4 自进化；E 里的 MiCan 经验，**等真跑出需求再做**（§2.5 失败即需求）

B1 随 B2 消解，C3 降为参考示例。

2026-09-29：内核审批护栏（`guard.mjs` + `core.lock.json` + pre-commit）整套删除 —— 仓库分离后收益小于摩擦
（`Core.md` §14.1）。下文拍板前的分析里提到「内核审批 / approve / 受 core.lock 保护」的，都是当时的记录。

---

## A. 自进化（`Core.md` §14 的 v2）

§14 目前只保留原则「失败即需求，测试即护栏，Git 即进化」，并明确**暂不实现**三条。
下面把它们拆成可落地的待办。**共同前置条件是 B2 与 A0。**

- [ ] **A0. `logs/` 持久化（前置）**
      `logs/` 在 `.gitignore` 里，是纯本机一次性产物。A1/A2 都需要跨运行、甚至跨机器看到历史，
      所以先定一件事：失败记录怎么留 —— 单独 append 一份进 Git 的索引，还是外置到不进 Git 的存储？
      没有 A0，A1/A2 都做不了。MiCan 的答案可参考：按天一份 jsonl、大值进附件行里只记引用、
      按天整份清理（默认 7 天，MiCan ADR-0031）。

- [ ] **A1. 同一失败出现两次才允许改**
      现在没有任何「失败聚合」。`log()` 每条记录已带 `task` / `error` / `gitSha`，
      数据够用，缺的是按 task 分组、按失败归类、计数的东西。
      落点：`scripts/scan_failures.mjs`（沉淀区，不动内核）。

- [ ] **A2. 新任务成功三次固化**
      需要按 task 统计 `run` 记录里 `status:'ok'` 的次数，到阈值提示「该固化了」。
      同样是 `scripts/` 里的一个动作，不是内核特性。

- [ ] **A3. 自动生成候选 diff**
      把 A1 的输出喂给运行期 `agent()`，让它读日志 + 读 `tasks/`、`scripts/`，提出并落地改动。
      约束必须写死：**只改沉淀区，不碰内核**（§14.1）。
      骨架见 `Core.md` §7 `fix_bug.mjs`，扩展成 `tasks/evolve.mjs` 即可。
      注意 §16 两条禁令：**不自动生成任务草案**、**不执行 Agent 输出的 actions** ——
      Agent 自己写文件，任务 JS 只按 `choice` 分支，不代它落地。
      交互上参考 MiCan ADR-0028「先商量、点头再应用」：Agent 改盘不提交 → `human()` 看 diff → 通过才提交。

- [ ] **A4. 闭环收口**
      A3 改完后接 `script('run_tests')` → `human()` → `script('git_commit')`。
      三步都是普通脚本/原语，**不需要内核支持**。

## B. 摩擦点（需人拍板，可能要改内核）

- [x] **B2. 沉淀放哪 —— 空目录护栏与进化闭环互相矛盾（最高优先）** —— **2026-09-29 定：①，已实现**
      已验证：`examples/` 当 HOME 跑通；临时业务目录 `npm install file:` 后 `'miworkflow'` 解析到内核真实路径、
      `npx miworkflow` 可用、内核未审批时拒跑。
      「经 npm 装进 `node_modules` 后 guard 是否仍判干净」：用 `npm pack` → 装 tarball 模拟 git 依赖（npm 装
      `github:` 也是先 pack 再解包），查出两个坑并已修：`package.json` 缺 `version` 导致根本装不上；
      npm 从不打包 `.gitignore`，装进去的那份永远判脏 → 已移出内核清单。修后装进去的与源码 13 个文件哈希一致；
      `tests/guard.test.mjs` 加了「内核清单里的文件都会被 npm pack 带上」防回归。
      剩下没实测的只有真从 GitHub 拉（要先推送），机制与上面相同。
      实现清单：
      - `run.mjs` / `core.mjs` / `viewer/serve.mjs` 按 `AGENTFLOW_HOME`（缺省 cwd）找 `tasks/ scripts/ logs/`；
        脚本子进程 cwd = HOME；`gitSha` 取 HOME 的仓库
      - `package.json` 加 `exports`、`bin`
      - `examples/` 改成 HOME 结构（`tasks/`、`scripts/` 子目录），示例 import `'miworkflow'`
      - 删内核根的 `tasks/`、`scripts/`；`guard.mjs` 可写面缩为 `logs/ examples/`
      - `run.mjs` 起跑前 `guard.inspect()`，内核不干净就拒跑
      - 测试：空目录护栏改写；`examples/` 作为 HOME 跑通；HOME 外跑任务、日志落在 HOME
      - 把 §19.1 折进 `Core.md` §3 / §5 / §7 / §9 / §14 / §14.1 / §15；README 快速开始重写

      以下为拍板前的分析，留作记录：
      `tests/core.test.mjs` 断言 `tasks/`、`scripts/` 里**文件系统上**没有任何 `.mjs`（不是看 Git）。
      后果：
      - README「快速开始」教的 `cp examples/demo.task.mjs tasks/demo.mjs` 一做，`node --test` 就红；
      - §14 闭环第 3 步要求测试通过、第 5 步要求 Git 提交 `tasks/`、`scripts/` —— 一旦开始沉淀，
        测试永远红，第 5 步提交进的还是**内核仓库**。
      根子在于：**内核仓库和沉淀仓库是同一个**。三选一：
      - **① 沉淀放业务仓库（推荐）**：内核装一份，沉淀跟着业务项目走（如 `<Unity 项目>/.workflow/tasks|scripts`），
        由 `AGENTFLOW_HOME`（缺省 = 当前目录）指过去；进化的 commit 落在业务仓库，跟游戏代码一起回滚。
        代价：`run.mjs` / `core.mjs` 按 HOME 找 `tasks/`、`scripts/`、`logs/`；任务改成
        `import { script } from 'miworkflow'`（`package.json` 的 `exports` + `npm link`），
        不再是 `'../core.mjs'`；§3、§15 重写。内核仓库的空目录护栏原样保留，语义反而更准。
      - **② 内核仓库当模板**：fork 后在自己的分支里沉淀，删掉空目录测试。零改动，但内核升级要 merge。
      - **③ `tasks/`、`scripts/` 做成嵌套仓库**（内核 gitignore 它们），护栏改看 `git ls-files`。
        不改 import，但两层仓库嵌套，进化 commit 要进对仓库。
      选定后改 `Core.md` §3 / §14 / §15、README 快速开始、`tests/core.test.mjs`，需终端 `approve`。

- [ ] **B3. 零配置使用：装一次，项目里什么都不用建** —— **2026-09-29 定**，设计见 `Core.md` §19.3
      起因：B2 后业务项目仍要手建 `.workflow/`、写 `package.json`、`npm install`、`cd` 进去 `npx`。
      讨论过的三种形态：每项目 npm 包（B2 现状，步骤最多）；技能形态（装一次、全靠 AI —— 否决：跑任务也得经过 AI，别扭）；
      **全局命令 + 项目零配置（采纳）**：装 / 写 / 跑三件事分开，写可以交给 AI，跑不经过 AI。
      实现清单：
      - `run.mjs`：`mod.default({ script, agent, human })`；HOME 按 `AGENTFLOW_HOME` → 往上找 `.workflow/` → 报错；
        解析出的 HOME 写回 `AGENTFLOW_HOME` 再加载 core；子命令 `new <name>`、`view`
      - `package.json`：去掉 `exports` 与 `miworkflow-view`，`bin` 只剩 `miworkflow`
      - `examples/`：任务改成传参写法
      - viewer：`GET /api/tasks`（正则读 title，不 import）、`POST /api/run`（默认只收本机，`MIWORKFLOW_REMOTE_RUN=1` 放开；
        预生成 runId；`AGENTFLOW_HUMAN=web`；输出落 `logs/<runId>.out.log`）；页面加任务列表与「运行」按钮
      - `SKILL.md`（并入 C1）：写给 AI 的建任务说明
      - 测试：往上找 HOME（子目录里能找到、找不到报错、env 优先）；`new` 建骨架且不覆盖；
        传参调用；`/api/run` 拒绝非本机；示例不 import 内核
      - 把 §19.3 折进 `Core.md` §3 / §5 / §7 / §9 / §15，README 重写用法
      实测：`npm i -g` 装真 GitHub 地址后在一个空的 Unity 项目里走一遍 `new` → 跑 → 网页点运行。

- [x] **B1. 「脚本测试放哪」没定死** —— 随 B2-① 消解：沉淀的测试放业务仓库 `.workflow/tests/`，不碰内核
      §8 要求「每个脚本配独立测试」，但 `guard.mjs` 的 `WRITABLE_DIRS` 只有
      `tasks/ scripts/ logs/ examples/` —— 给新脚本加测试会新增 `tests/` 文件，
      被判为内核改动，`node --test` 变红，要人 `approve`。
      最常见的场景（加**业务**脚本的测试）却触发**内核**审批，语义错配。

## C. 初始工作流创建体验

- [ ] **C1. 补 `AGENTS.md`** —— 并入 B3：改为内核根的 `SKILL.md`，可链成技能
      仓库现在没有面向编码 Agent 的规范文件，「创建初始工作流」只能现场喂
      `Core.md` + `examples/`。应写一份：怎么按 §2.4 拆（确定性 → `scripts/`，
      模糊 → 运行期 `agent()`）、只写沉淀区、不动内核、返回值契约（§6.1 / §6.2）。
      注意 `AGENTS.md` 同样算内核，新增需 `approve`。等 B2 定了再写（沉淀区的位置会变）。

- [ ] **C2. 运行期 Agent 适配器：pi / codex / cursor agent** —— **2026-09-29 定**：C2-1 放 `agents/`；
      C2-2 不做；C2-3 先不做。契约见 `Core.md` §19.2，下文保留三家差异与分析。
      2026-09-29 补：每次调用可单独选 CLI + 模型 + 思考等级（`opts.agent = { cli, model, thinking, provider, args }`），
      按任务 / 按用途的默认值用普通 JS 常量，不加配置机制。
      2026-09-29 再补：**从 exec-review 的 runner 层复制一份起步，之后独立演进**，不依赖、不回头同步 exec-review。
      没有它，`agent()` 永远走 `agent_unavailable`。

      实现清单：
      - 复制 `~/.agents/skills/exec-review/scripts/runners/{index,pi,codex,agent,resolve-bin,spawn-turn,spawn-agent-turn}.mjs`
        与 `scripts/normalize-event.mjs` → `agents/runners/`；`agent` 改名 `cursor`；删掉 `role` / reviewer 只读、`sandbox` 映射
        （三家一律全权限，§10）、`dryRun`（agent 不干跑）。
      - 新写入口 `agents/agent_cli.mjs <cli> [--model] [--thinking] [--provider] [...args]`：
        stdin 任务包 → 渲染提示词（含输出契约）→ `runTurn` → 抽最后回话 → stdout；codex 另带 `--output-schema`。
      - core：按 `opts.cmd → opts.agent → AGENTFLOW_AGENT_CMD → AGENTFLOW_AGENT` 找命令、展开 `opts.agent`、
        日志记 `agent: { cli, model, thinking }`。
      - 纯函数单测：`opts.agent` 展开；各家开关映射；cursor 只给 `thinking` 报错；`provider` 给非 pi 报错；
        提示词渲染；抽回话（围栏、非 JSON、空回话）。真 CLI 不进 `node --test`。
      - 把 §19.2 折进 `Core.md` §3 / §6.2 / §10 / §12 / §16 与 README 环境变量表。

      原先「照 MiCan 三份扩展重写」的方案作废：exec-review 的 runner 层已经解决了 cursor 的思考等级
      （`model[effort=…]`）、三家续会话能力、Windows 可执行文件解析、事件流归一。MiCan 那份只作对照。

      **形态**：
      ```bash
      AGENTFLOW_AGENT=codex                                   # 本机缺省；core 展开成 node <内核>/agents/agent_cli.mjs codex
      ```
      单次调用：`agent(goal, { agent: { cli: 'codex', model: '...', thinking: 'high' } })`，写法见 `Core.md` §19.2；
      自定义命令仍走 `AGENTFLOW_AGENT_CMD` / `opts.cmd`。

      **进**：stdin 任务包（§10）。适配器把它渲染成一段提示词：`goal`、`inputs`（JSON）、`constraints`，
      末尾附**输出契约**：「最后只回一段 JSON：`{status, choice, reason, data}`，`status` 只能是
      `ok | need_human | failed`，`choice` 只能取 `inputs.choices` 里的值（给了的话）」。
      **出**：取最后一条回话，剥掉至多一层 ```` ``` ```` 围栏，原样写 stdout。**合不合契约由 core 判**（§6.2），
      适配器不补默认值、不猜。CLI 起不来 / 非 0 退出 → 适配器自己写
      `{status:'failed', choice:'agent_cli_failed', reason:'<哪家、退出码、stderr 首句>'}`（这是事实，不是猜）。
      **运行目录**：取 `inputs.cwd`，缺省为当前目录 —— 让 Agent 在 Unity 项目里干活，不必给内核加 `opts.cwd`。
      **过程可见**：事件流经 `normalize-event` 归一后翻成人话写 stderr；归一事件另存 HOME `logs/`（E3 的底子）。
      **预算**：只有 `timeoutSec` 真生效（core 在 `timeoutSec + 5` 秒杀进程）；`maxTokens` / `maxTurns`
      能映射到 CLI 开关就映射，不能就写进提示词，文档写明「仅建议」。注意默认 120 秒对 Unity 修复远远不够，
      任务里要显式 `budget: { timeoutSec: ... }`。
      **权限**：三家都全权限（§10「默认全权限」）。

      拍板记录：
      - **C2-1 放哪**：
        - **`agents/`（推荐）**：新内核目录，跟 `viewer/` 同类外部工具，受 `core.lock.json` 保护。
          理由：它不是 §6.1 协议的脚本（进的是任务包、出的是 Agent 选择），放 `scripts/` 会混淆；
          它带着全权限开关，被进化中的 Agent 静默改掉很危险，正该走内核审批；开箱即用、不用复制。
          代价：`Core.md` §3 / §16 各加一行。
        - `examples/agent_cli.script.mjs` → 用时复制进 `scripts/`：零内核改动，但有上面三个问题。
      - **C2-2 choice 要不要由 core 校验**：给 `agent()` 加可选 `opts.choices`，`choice` 不在里面就判
        `agent_bad_output` —— 契约更硬，但动内核。**推荐先不做**：`choices` 放 `inputs` 里给适配器渲染，
        任务 JS 照 §7 的写法自己兜底（未知 `choice` 就 `throw`）。
      - **C2-3 会话延续**：§7 的重试循环每次 `agent()` 都是新上下文。**推荐先不做**：重试时把上一次的
        `reason` 和失败输出放进 `inputs`。真出现「每次从头读项目、慢得不行」再加 `inputs.session`。

- [ ] **C4. 首个真实工作流：Unity 跑测试 → 修 → 审查 → 确认 → 提交**（替代 C3 成为第一个真实工作流）
      骨架就是 `Core.md` §7。落点：Unity 项目自己的 `.workflow/`（B2-①），依赖 B2、C2 先实现。
      **不依赖 exec-review**（2026-09-29 定）：「执行 → 审查 → 提交」用三个原语自己组合 ——
      这正是 §2.4 说的「确定的事固化成脚本，不确定的事交给 Agent」，也是 §19.2「每次调用选不同 Agent」的第一个用处：
      ```js
      const DEV = { cli: 'codex', thinking: 'high' };      // 放 .workflow/agents.mjs
      const REVIEWER = { cli: 'pi', thinking: 'medium' };   // 执行与审查故意用不同家，互相兜底

      const base = await script('git_head', { cwd });                       // 记下起点，失败好回滚
      const fix = await agent('修掉失败的测试', { agent: DEV,
        inputs: { cwd, failures, choices: ['fixed', 'cannot_fix'] }, budget: { timeoutSec: 1800 } });
      const changed = await script('git_changes', { cwd, since: base.data.sha }); // 真改了哪些文件，不信 Agent 自报
      const review = await agent('审查这些改动是否真修好了、有没有副作用；有问题直接改', { agent: REVIEWER,
        inputs: { cwd, goal: '修掉失败的测试', files: changed.data.files, choices: ['clean', 'refined', 'reject'] } });
      // 再跑一次测试 → human('确认提交') → script('git_commit') 或 script('git_restore', { cwd, to: base.data.sha })
      ```
      跟 exec-review 的差别：审查结论是 `choice`，任务 JS 按它分支（`reject` 就回滚），而不是写死在一个脚本里；
      每一步都进 trace，viewer 看得见，`human()` 卡在提交前。exec-review 的 `prompts/executor.md`、`reviewer.md`
      可以参考着写提示词，但不引用。
      新增沉淀脚本：`git_head`、`git_changes`（git 判改动，只报真脏的文件）、`git_commit`、`git_restore`。
      跑稳后，把「执行 → 审查」抽成 `.workflow/` 里的一个普通 JS 函数给别的任务复用；要不要放进 `examples/` 当参考再议。
      - `scripts/unity_run_tests.mjs`：`args = { project, platform: 'EditMode' | 'PlayMode' }`。
        - Unity 路径：`UNITY_EXE` 优先；否则读 `ProjectSettings/ProjectVersion.txt` 拼
          `C:\Program Files\Unity\Hub\Editor\<版本>\Editor\Unity.exe`。
        - 跑 `Unity.exe -batchmode -projectPath <p> -runTests -testPlatform <平台> -testResults <xml> -logFile <log>`
          （`-runTests` 不带 `-quit`）。
        - 解析 NUnit XML → `data: { total, passed, failed, failures: [{ name, message, stack }] }`，
          `say: 'EditMode 测试：12 个过，2 个挂'`。退出码含义实测后写进脚本注释。
        - 项目在编辑器里开着会撞项目锁：识别出来返回 `failed`，`say: '项目在 Unity 里开着，batchmode 进不去'`。
      - `tasks/unity_fix_tests.mjs`：跑测试 → 挂了走上面的「执行 → 审查」→ 再跑测试，最多 3 轮 →
        `human('确认提交')` → `git_commit`；审查 `reject` 或 3 轮仍挂 → `git_restore` + `human()` 报告。
      - `scripts/git_commit.mjs`：在 `args.cwd` 那个仓库里提交，`dryRun` 时只列出会提交什么。
      待定：编辑器开着的场景要不要改走 unityMCP 的 `run_tests`（那是给 Agent 用的，脚本调不到）——先不做。

- [ ] **C3. 参考示例：GitHub Issues 摘要**（降级为 `examples/` 里的参考）
      拉 Issues → 按优先级排序 → 生成 md。分工：
      `examples/scripts/{fetch_issues,render_md}.mjs` + 运行期 `agent()` 排序 + `examples/tasks/issues_digest.mjs` 编排。

## E. 来自 MiCan 的经验（先不做，写明什么时候做）

MiCan 在真实使用里踩出来的需求。MiWorkflow 现在都没有，但**不预先搬**：满足触发条件再做，
能放沉淀区 / 外部工具就不进内核（§16）。

| # | 需求 | MiCan 出处 | 什么时候做 | 大概落点 |
|---|---|---|---|---|
| E1 | 定时触发 | ADR-0010 | 第一个需要定时跑的任务出现 | Windows 任务计划程序调 `node run.mjs <task>`，不进内核 |
| E2 | 占用：同一任务在跑就跳过 | ADR-0027 | 定时任务第一次撞车 | `run.mjs` 起跑前按 task 建锁文件（动内核） |
| E3 | 长任务的过程留痕：Agent 每一步动作进日志 | ADR-0021、0031 | 复盘时只看 `reason` 不够用 | C2 的适配器已把归一事件存进 HOME `logs/`；剩下的是 trace 行引用它、viewer 展开它（动内核） |
| E4 | 插话：往正在跑的 Agent 里塞一句 | ADR-0032 | Agent 反复绕圈子，人看得见却说不上话 | pi `--mode rpc`；`agent()` 与 viewer 各开一个口子（动内核） |
| E5 | 进化先商量、点头再应用 | ADR-0028 | 做 A3 时 | 已并入 A3 |

## D. 明确不做

- 不把上述任何自动化塞进内核（§16）；E 里标了「动内核」的，做之前单独拍板。
- 不做画布 / 图形化编排：流程就是 JS（§2.8）。viewer 只渲染运行时 trace，不做「把 JS 画成可编辑的图」。
- 不做 Unity 编辑器菜单启动（2026-09-29）：启动走终端或 viewer 的「运行」按钮就够，不往业务项目里装编辑器包。
- 不做「打包成只读内核」：JS/Node 打包拦不住 Agent，真想物理隔离用只读挂载 + 可写卷，
  那是操作系统的事（§14.1 末尾）。
