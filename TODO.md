# TODO

来源：2026-09-28 关于「初始工作流创建」与「自进化」的两轮讨论；2026-09-29 与 MiCan 对比后定下
「以 MiWorkflow 为主线，把 MiCan 踩过的坑当需求清单」。规范以 `Core.md` 为准。

---

## 推进顺序

1. ✅ **B2 沉淀离开内核仓库**（已实现，见 `Core.md` §3、§15）
2. ✅ **B3 零配置使用**（已实现并实测，见 `Core.md` §3、§5、§13.6、§15）
3. ✅ **C2 运行期 Agent 适配器**（已实现并用三家真 CLI 实测，见 `Core.md` §10.1）
4. ✅ **C3 首个工作流：GitHub 开发**（`templates/github/`，已实现并用假 gh / 假 Agent / 临时 git 仓库测了 10 条路径）
5. ✅ **讨论单 + 循环运行 + 会话**（spec #6，开发单 #7–#12，由 `github_dev` 自己开发完）
6. ✅ **F 工单源无关 + TAPD**（见下文 F，2026-09-30 已拍板；✅ F2 已实现（#13–#19），✅ F3 TAPD 开发已实现（#20–#26，真 TAPD 项目实测项见 F6）；F4 搁置）
7. ✅ **G 审查分级**（见下文 G，2026-09-30 已拍板并实现；汇总审查 G3 搁置）
8. A0 → A1–A4 自进化；E 里的 MiCan 经验，**等真跑出需求再做**（§2.5 失败即需求）

B1 随 B2 消解。首个工作流选通用的 GitHub 开发，不选某个项目专用的（如 Unity 跑测试）。

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

- [x] **B3. 零配置使用：装一次，项目里什么都不用建** —— **2026-09-29 定，已实现**（`Core.md` §3、§5、§13.6、§15）
      实现时的取舍：非终端 `init` 不带 `--template` 就用空白；`templates/` 下有哪些目录就能选哪些（C3 之前只有空白）；
      `args` 另认 `--key=value`（viewer 起任务用这种写法，值以 `--` 开头也不会被当成开关）；
      任务模块加载失败也记一条 `run failed`；「在跑」的任务按钮只变暗 + 再确认，不拦（被杀掉的 run 会一直显示在跑）。
      实测已过：`npm i -g github:Yogioo/MiWorkflow`（装到临时 prefix）后在空 git 项目的子目录里 `init` → `new` → 跑通；
      网页起任务用 `npm pack` 装的同一份包测过（`view` → `/api/tasks` → `/api/run` → 日志落 HOME）。
      起因：B2 后业务项目仍要手建 `.workflow/`、写 `package.json`、`npm install`、`cd` 进去 `npx`。
      讨论过的三种形态：每项目 npm 包（B2 现状，步骤最多）；技能形态（装一次、全靠 AI —— 否决：跑任务也得经过 AI，别扭）；
      **全局命令 + 项目零配置（采纳）**：装 / 写 / 跑三件事分开，写可以交给 AI，跑不经过 AI。
      实现清单：
      - `run.mjs`：`mod.default({ script, agent, human, args })`，`--key value` / `--flag` 解析成 `args`
        （`--yes`、`--dry-run` 不进）；HOME 按 `AGENTFLOW_HOME` → 往上找 `.workflow/` → 报错；
        解析出的 HOME 写回 `AGENTFLOW_HOME` 再加载 core；子命令 `init`、`new <name>`、`view`
      - `init`：终端里选「空白 / GitHub 开发」，非终端 `--template blank|github`；从 `templates/<名字>/` 复制，已有文件不覆盖
        （2026-09-29 定：原方案「没有 init、`new` 顺手建目录」改为 `init` 负责建目录 + 选模板，`new` 只加任务）
      - `package.json`：去掉 `exports` 与 `miworkflow-view`，`bin` 只剩 `miworkflow`
      - `examples/`：任务改成传参写法
      - viewer：`GET /api/tasks`（正则读 title，不 import）、`POST /api/run`（默认只收本机，`MIWORKFLOW_REMOTE_RUN=1` 放开；
        预生成 runId；`AGENTFLOW_HUMAN=web`；输出落 `logs/<runId>.out.log`）；页面加任务列表与「运行」按钮
      - `SKILL.md`（并入 C1）：写给 AI 的建任务说明
      - 测试：往上找 HOME（子目录里能找到、找不到报错、env 优先）；`init` 两种模板、重复 `init` 不覆盖；
        `new` 建骨架且不覆盖、没 `.workflow/` 报错；`args` 解析；`/api/run` 拒绝非本机；示例不 import 内核
      - 把 §19.3 折进 `Core.md` §3 / §5 / §7 / §9 / §15 / §16，README 重写用法
      实测：`npm i -g` 装真 GitHub 地址后在一个空项目里走一遍 `init` → `new` → 跑 → 网页点运行。

- [x] **B1. 「脚本测试放哪」没定死** —— 随 B2-① 消解：沉淀的测试放业务仓库 `.workflow/tests/`，不碰内核
      §8 要求「每个脚本配独立测试」，但 `guard.mjs` 的 `WRITABLE_DIRS` 只有
      `tasks/ scripts/ logs/ examples/` —— 给新脚本加测试会新增 `tests/` 文件，
      被判为内核改动，`node --test` 变红，要人 `approve`。
      最常见的场景（加**业务**脚本的测试）却触发**内核**审批，语义错配。

- [x] **B4. 「没人可批」时 `human()` 挂一小时**（2026-09-29 实遇）—— **2026-09-29 定：用 `AGENTS.md` 硬规则兜住，不改内核**
      复现：`github_dev` 的 DEV Agent 在无终端的 shell 里跑 `AGENTFLOW_HOME=examples node run.mjs demo --who x`
      （它自己挑的验证命令）→ `demo` 有 `human()` → 没有终端，也没有 `--yes`，落到决定文件（§13.5），
      默认等 `3_600_000` ms（`core.mjs` human 的 `opts.timeoutMs ??`）→ shell 不返回 → Agent 不动 → 整个 run 停住。
      更别扭的是：看着的 viewer 也没用 —— 它的 HOME 是 `.workflow`，只写 `.workflow/logs/` 下的决定文件，
      而那次 run 的 HOME 是 `examples`。
      只影响两条窄路径：(a) 无人值守（CI / 定时 / nohup）忘了带 `--yes`；(b) Agent 代跑带 `human()` 的任务。
      后果不是报错而是静默挂一小时，且 (b) 会反复撞（我们正拿 MiWorkflow 开发 MiWorkflow）。
      **方案 0（就是它）**：根 `AGENTS.md` 一条硬规则「无终端别跑带 `human()` 的任务，要跑就带 `--yes`」。
      方案 1（内层 run 快速失败，约 10 行）与上面这段分析留作记录，**不再做**。

- [x] **B5. `Core.md` §3 说 `.workflow/AGENTS.md` 是「给 AI 的入口」—— 这句要收紧** —— **2026-09-29 定并实现（方案 ② 变体：追加）**
      实测：pi 只从 **cwd 往上**找 `AGENTS.md`（加全局 `~/.pi/agent/AGENTS.md`），**不找子目录**（pi README「Context Files」）。
      而 `github_dev` 里 Agent 的 cwd 是**项目根**（`agent_cli.mjs` 用 `pkg.inputs.cwd`，`github_dev` 传 `git rev-parse --show-toplevel`），
      `.workflow/` 是它的下一层 → 自动读不到。所以规则写在 `.workflow/AGENTS.md` 里，对「改项目代码的 Agent」是空转。
      两个方向选一个：① §3 改成「只在 AI 的 cwd 落在 `.workflow/` 里或它下面时才自动读」（编辑 `.workflow/tasks/x.mjs` 的场景会命中）；
      ② 让 `init` 在项目根放一个指向 `.workflow/AGENTS.md` 的 `AGENTS.md`。
      **最终定：走 ②，但不「放一个」而是「追加一段」。** 项目根本来就可能有自己的 `AGENTS.md`（项目自己的规矩），
      `init` 直接放会覆盖或抢戏；改成往项目根的 `AGENTS.md` 追加一段带 marker 的入口 —— 没有该文件就建，
      有就追加到末尾，已含 marker 就不动（重复 `init` 不重复追加，也不覆盖项目原有内容）。
      `Core.md` §3 / README / SKILL.md 同步改口径：AI 自动读到的是项目根那份（从 cwd 往上找，不找子目录），
      硬规则正文仍在 `.workflow/AGENTS.md`。实现：`run.mjs` 的 `writeRootAgents()`；测试 +2（已有内容保留 + 幂等 / 没有就建）。
      顺带记一下现状：内核根这份 `AGENTS.md` 是 2026-09-29 新加的，C1 当时是用 `SKILL.md` 顶替它。
      两者分工：`SKILL.md` 讲「怎么在业务项目里写任务」（`miworkflow skill` 打印、可链成技能）；
      内核仓库根的 `AGENTS.md` 讲「在这个内核仓库里干活时的规矩」（cwd 在仓库根的 Agent 自动读）。
      注意三个 `AGENTS.md` 各管一段，别混：**内核仓库根**那份（内核规矩）、**业务项目根**那份（`init` 追加的
      入口，指向 `.workflow/`）、**`.workflow/` 里**那份（业务项目的硬规则正文）。

- [x] **B6. 父子 run 的身份边界（runId / HOME / 锁 / 日志目录）** —— **2026-09-29 定：同 B4，用 `AGENTS.md` 硬规则兜住，不改内核**
      子 run 全套靠环境变量从父 run 继承，`run.mjs` 的 `AGENTFLOW_RUN_ID ??=` 只是其中一处：
      内层 run 会沿用父 run 的 `runId`、HOME、锁与日志目录。这次因为 HOME 不同（`examples` vs `.workflow`）没出事；
      HOME 相同就会**覆盖父 run 的 JSONL**。
      **解法**：根 `AGENTS.md` 加一条「别嵌套跑 run」—— 要单独验证就退出父 run、在干净 shell 里跑；
      确实要嵌套就显式换 `AGENTFLOW_HOME`，别让子 run 继承 `AGENTFLOW_RUN_ID`。
      继承行为本身不动（`AGENTFLOW_RUN_ID ??=` 保持原样，viewer 起的 run 仍按预生成 runId 走）。
      要讨论而没讨论的仍是：run 的身份从哪来、哪些该继承哪些该重开 —— 留作记录。

- [x] **B7. GitHub 工作流：提交环节会「自己把自己搞死」，回滚还会吃掉别人的提交** —— **2026-09-29 定并实现**
      经过：DEV Agent 自己 `git add -A && git commit`（`786d42f`），REVIEWER 又自己提交两笔修复（`53e0d09`、`0c9bb57`）；
      工作流的 `git_commit` 步骤再提交时工作区已经干净 → `git commit` 退出码 1 → 判成 `commit_failed` →
      整个 issue 走失败路径（钉 `afk-failed` + 评论）+ `git_restore`。
      而当时 `node --test` 80/80 全绿，代码和审查都没毛病 —— 失败是**记账**失败，不是干活失败。
      三处缺陷：
      - ① `git_commit` 把「无内容可提交」当失败。应先看 `git status --porcelain`：已经提交过就跳过 ——
        这一轮的目标是「工作区干净 + 有提交」，不是「由我提交」。
      - ② `git_restore` 是 `reset --hard <本轮起点 sha>` + `clean -fd`，会把**本轮期间不属于本轮**的提交一起抹掉：
        这次连 22:35 人提交的 `604c8c4`（根 `AGENTS.md` + TODO）一起没了。应改成：回滚前 `git log <起点>..HEAD`，
        只回滚本轮产生的提交；碰到第一笔不是本轮的，就停手留给人（与「推送失败」同款：不关单、整轮停下）。
      - ③ 提示词没禁止 Agent 提交。DEV / REVIEWER 都有全部权限，看到仓库里「做完就提交」的先例就会自己提交；
        应写明「改完不要 `git commit`、不要 `git push`，提交由工作流负责」。
      恢复：四笔提交一直在对象库里（`0c9bb57`），已推；当时临时打的保险标签已删。
      实现（`templates/github/`，测试 +2 → 82 全绿）：
      - ① `git_commit`：`git add -A` 后先看 `git diff --cached`；为空就跳过提交，直接用当前 HEAD 继续推送，
        `data` 多一个 `already`。任务的「推送失败」判据不用改（`committed: true` 依旧成立）。
      - ② `git_restore`：回滚前把 `base..HEAD` 的提交 `update-ref` 到 `refs/afk-backup/<时间戳>-<sha>`
        （可用 `prefix` 换名字），ref 与 `lost` 列表随 `data` 返回；`github_dev` 的 `fail()` 把它写进失败评论；
        `gh_issue_mark` 的评论上限从 300 放宽到 900（失败原因常带几行测试输出，别把 ref 截掉）。
      - ③ 提示词说清「谁来提交」：**提交归 Agent，发布归工作流**（2026-09-29 二次定）。
        DEV / REVIEWER / FIX 各写明自己的提交信息（`#N <标题>` 正文 `Closes #N` / `#N 审查修正：<一句话>` /
        `#N 验证不过修正：<一句话>`），一条硬线是「**不要 `git push`**」；工作流只兜底（Agent 没提交时才自己补一笔，见 ①）。
        连带：`--confirm` 语义改成「**发布前点头**」（`#N 改动就绪（提交已在本地），推送并关单？`）——
        提交是本地、可回滚的，人卡的是推送 + 关单；README 与任务头部注释同步。
        理由：跟 `exec-review` 的约定一致（执行端默认提交）；Agent 天然会提交，硬禁是逆着它来；
        而且它写的信息比工作流那句 `#N <标题>` 更准（#5 那三笔就是例子）。边界靠工作流兜底 + 回滚备份（②）守住。
      实测：新增两个端到端用例 —— 「Agent 自己先提交 → 不判失败、照常推送关单」（旧代码在这条上就是 `commit_failed`）、
      「回滚要丢掉的提交 → 先备份成 ref 再回滚，评论里带上 ref」；再给原有的回滚用例补一条「没提交要丢就不造 ref」。
      两条路径都在测试里：「Agent 提交」和「Agent 不提交、工作流兜底」。

- [x] **B8. TAPD 实跑：提交信息不合规、评论只有一句 SHA；模板与项目两处维护** —— **2026-09-30 定并实现**（推翻 B7 ③「提交归 Agent」）
      经过：DigitDoor 跑 `story 1152360842001004854`（run `3f4950be`），产出提交 `babe4c2f3 --story=<19 位 ID> --user=… 编辑器优化`，
      带 `Co-authored-by: Cursor`；TAPD 上只有一句「本地提交（未推送）：…」，而且 `ticket_mark` 还报了「comment add 没回评论 id」。
      根因：① `commitMessage` 还是模板默认，提示词让 Agent 照抄并自己提交，工作流事后不把关；
      ② 成功路径 `ticket_mark done / unpushed` 根本不传回帖稿，回帖稿又被写成可选（4 次 Agent 调用一份没写）；
      ③ 真 `tapd-cli comment add` 出 `{ ok, id }`，模板按 `data.Comment.id` 取，假 tapd-cli 照错的形状写，测试一直绿；
      ④ 模板「复制出去不回头同步」，DigitDoor 的 `.workflow/` 和模板一字不差只差 6 行配置，却要两处各修。
      实现：
      - 提交归工作流：Agent 不提交，回话 `data` 给 `type` / `summary`；`dev` 在审查、验证、`--confirm` 之后统一提交，一张工单一笔。
        `git_commit` 收 `baseSha`，Agent 自己的提交 `reset --soft` 压进来；提交后回读，标题被钩子改了或带 AI 署名判失败回滚。
        `--confirm` 回到「提交前点头」。提交格式做成 `source.mjs` 的一行常量 `COMMIT_TYPES` / `COMMIT_FORMAT` / `COMMIT_BODY`，
        TAPD 缺省 `{type}:{short} {summary}`（短号 = 后 7 位）。
      - 评论：回帖稿必写（写给谁看、必含四项、好坏范例）；完成 / 未推送 / 推送失败都发「开头一句 + 各份回帖稿（没写用 reason）+ 工作流落款」；
        `ticket_mark` 不再拼硬编码开头、不截断，调用方给整段；失败发完整原因。`comment add` 的 id 按 `{ ok, id }` 取，为空时按评论人回查。
      - 同步：`miworkflow init --upgrade`，模板文件覆盖，`config.mjs` / `source.mjs` 里一行写完的 `export const` 保留项目的值，旧文件备份。

## C. 初始工作流创建体验

- [x] **C1. 补 `AGENTS.md`** —— 并入 B3：改为内核根的 `SKILL.md`，可链成技能（已写）
      仓库现在没有面向编码 Agent 的规范文件，「创建初始工作流」只能现场喂
      `Core.md` + `examples/`。应写一份：怎么按 §2.4 拆（确定性 → `scripts/`，
      模糊 → 运行期 `agent()`）、只写沉淀区、不动内核、返回值契约（§6.1 / §6.2）。
      注意 `AGENTS.md` 同样算内核，新增需 `approve`。等 B2 定了再写（沉淀区的位置会变）。

- [x] **C2. 运行期 Agent 适配器：pi / codex / cursor agent** —— **2026-09-29 定并实现**（`Core.md` §10.1）
      实现时的取舍：codex **不用** `--output-schema` —— 它走 OpenAI 严格模式，要求每个对象 `additionalProperties: false`，
      §6.2 自由形状的 `data` 被 API 直接拒（`invalid_json_schema`），改为三家都靠提示词；
      codex 的错误走 stdout 事件流不走 stderr，归一成 `kind: 'error'`，`agent_cli_failed` 的 `reason` 优先取它；
      适配器自己按 `timeoutSec` 杀整棵进程树（core 的 `+5` 秒只杀得到适配器，杀不到孙进程）；
      过程文件放 `logs/<runId>/agent-<n>.*` 子目录，免得 viewer 把 `.events.jsonl` 当成一次运行；
      exec-review 的 `spawn-turn.mjs`（非流式）没用上，没复制。
      `agent()` 默认 `timeoutSec` 由 120 改为 7200（2 小时，2026-09-29 定）：120 秒连一次改代码都不够。
      实测：本机 pi / codex / cursor 各在临时 git 仓库里建一个文件并按契约交回，一次过（codex 在去掉 schema 后）。
      以下为拍板时的记录。C2-1 放 `agents/`；C2-2 不做；C2-3 先不做（后由 #7 落地）。
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
      能映射到 CLI 开关就映射，不能就写进提示词，文档写明「仅建议」。注意默认 120 秒对改代码这类长活远远不够，
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
      - [x] **C2-3 会话延续**（#7，已做）：§7 的重试循环每次 `agent()` 都是新上下文。当初推荐先不做：重试时把上一次的
        `reason` 和失败输出放进 `inputs`。真出现「每次从头读项目、慢得不行」再加 `inputs.session`。
        落地时改为：会话号走 `opts.agent.session`（适配器参数，不进 `inputs`），适配器输出顶层 `session` 交回，
        core 只透传、记日志、不参与契约校验；续不上 → `session_not_found`。写法见 `Core.md` §10 / §10.1。

- [x] **C3. 首个工作流：GitHub 开发（`templates/github/`）** —— **2026-09-29 定，已实现**
      实现了 `config.mjs` / `tasks/github_dev.mjs` / `scripts/{gh_ready,gh_issue_view,gh_issue_mark,git_state,git_commit,git_restore,run_cmd,_lib}.mjs`。
      实现时的取舍：
      - 测试放**内核仓库** `tests/template-github.test.mjs`（§15「模板的测试留在内核仓库」），
        不跟着模板进项目；用假 gh（`MIWORKFLOW_GH` 指向一个 JS 文件，参数照传）+ 假 Agent
        （`AGENTFLOW_AGENT_CMD`）+ 临时 git 仓库跑，覆盖成功关单 / 审查拒绝 / 验证超轮 / need_human /
        no_change / 推送失败 / 依赖挡住 / 优先级与 `--issue` 点名 / 工作区不干净。
      - 推送失败让**整轮失败**（退出码 1），但本地提交保留、不关单、不贴 `afk-failed`，只留 `in-progress` 提醒人。
      - `--dry-run` 比 TODO 原文收紧了：不是「脚本只报会做什么」（挡不住 Agent 改文件），
        而是整个任务在 preflight 后只列出「今天会做哪几个 issue」就返回，不叫 Agent、不改盘。
      - `VERIFY` 是字符串走 shell、是数组精确到参数；`run_cmd` 的 timeout 由任务传 `script(..., { timeoutMs })`
        （core 的 script 默认 120 秒，对验证太短）。
      - 假 gh 的注入点是环境变量 `MIWORKFLOW_GH`（路径）；这是给测试/替换留的缝，不是内核机制。
      取代原 C3「GitHub Issues 摘要」示例。参考 afk-run（`~/.agents/skills/afk-run`）的 gh 任务源与状态机，
      **不依赖 afk-run / exec-review**，用三个原语重组；issue 的写法（标签、优先级、依赖）与 afk-run 相同，同一个仓库两边可以互换着跑。
      人在 GitHub 上把 issue 交给机器，机器逐个「认领 → 开发 → 审查 → 验证 → 提交 → 推送 → 关单」，失败就回滚、贴评论。

      **issue 约定**（照搬 afk-run gh 源）：
      - 入队：标签 `ready-for-agent`；排除带 `in-progress`（进行中）或 `afk-failed`（失败待人看）的
      - 优先级：标签 `P0`~`P4`，没有就当 `P2`；同级按 issue 号升序
      - 依赖：正文里 `- [ ] #123` 表示被 #123 挡着；勾上或 #123 已关就算满足。只认同仓库的 `#N`
      - 正文 = issue 正文 + 全部评论（按时间，不截断）：人补充的说明、上次失败留下的评论，执行端都能看到（afk-run TAPD 源的经验）

      **每个 issue 的流程**（任务 JS，确定的步骤都是脚本，只有「改代码」「审查」交给 Agent）：
      1. 开跑前工作区必须干净，否则整轮不跑（跟 afk-run 一样，免得把人的改动混进提交或被回滚掉）
      2. `gh_issue_mark claimed` 贴 `in-progress`；`gh_issue_view` 取正文 + 评论；`git_state` 记下起点 sha
      3. `agent(DEV)`：`inputs: { cwd: 项目根, issue, choices: ['done', 'no_change'] }`，`budget.timeoutSec` 用默认（7200）
         - `need_human`（Agent 问问题）→ 回滚，问题贴成评论 + `afk-failed`，下一个
         - `no_change` 或 git 看不到改动 → 理由贴成评论 + `afk-failed`，等人判断（不重试、不关单）
      4. `git_state` 列出**实际**改了哪些文件（信 git，不信 Agent 自报）
      5. `agent(REVIEWER)`：看 issue + 改动，有问题直接改；`choices: ['clean', 'refined', 'reject']`。`reject` → 回滚 + 失败
      6. 配了 `VERIFY` 就跑（`run_cmd` 脚本）；不过就把输出交回 DEV 再改，最多 `ROUNDS` 轮（默认 2），还不过就回滚 + 失败
      7. 带 `--confirm` 时 `human('提交并关单？')`（终端或 viewer 点），拒绝就回滚 + 失败；不带就无人值守
      8. `git_commit`：`git add -A` + 提交信息 `#N <标题>`，正文带 `Closes #N`；**默认推送**到当前分支的上游
         - 推送失败（常见是远端有新提交）→ **不关单、整轮停下**，`say` 说明，留给人处理；本地提交保留
      9. `gh_issue_mark done`：评论 `提交：<短 sha>` + 关单 + 摘掉 `ready-for-agent` / `in-progress`
      - 任何一步失败：`git_restore` 回到起点（`reset --hard` + `clean -fd`；`logs/` 已被 `.workflow/.gitignore` 忽略，`clean -fd` 不碰），
        `gh_issue_mark failed` 摘 `in-progress`、贴 `afk-failed` + 评论原因，保留 `ready-for-agent`（人摘掉 `afk-failed` 就重新入队）

      **一轮跑多少**（`args`）：`--issue N` 只跑这一个（不看标签和依赖，人点名就跑）；否则按队列一直跑到空，
      `--max N` 限个数，连续失败 `--max-failures N`（默认 3）就停。`--dry-run` 时改 GitHub / git 的脚本只报会做什么。
      停下的原因写进最后一行 `say`（跑空 / 到上限 / 连续失败 / 推送失败）。

      **模板内容**（`init` 选 GitHub 时复制进 `.workflow/`）：
      ```text
      templates/github/
        config.mjs                 # 普通 JS 常量：DEV / REVIEWER（C2 的 agent 配置）、VERIFY（如 'npm test'，缺省不验证）、
                                   #   ROUNDS、PUSH（默认 true）、标签名
        tasks/github_dev.mjs       # 上面的流程，一个任务
        scripts/gh_ready.mjs       # 列就绪 issue（标签 + 依赖 + 排序）
        scripts/gh_issue_view.mjs  # 正文 + 评论
        scripts/gh_issue_mark.mjs  # claimed / done / failed：改标签、评论、关单
        scripts/git_state.mjs      # 当前 sha、是否干净、相对某 sha 改了哪些文件
        scripts/git_commit.mjs     # 提交 + 推送
        scripts/git_restore.mjs    # 回到某 sha
        scripts/run_cmd.mjs        # 跑验证命令，回 { code, tail }
        tests/                     # 假 gh、临时 git 仓库
      ```
      `gh` 调用照 afk-run `runGh` 的做法：`execFileSync` 不经 shell、网络类错误有限重试；仓库默认从 `remote.origin.url` 推断。
      提示词（DEV / REVIEWER 各一段）写在任务 JS 里，可以参考 exec-review 的 `prompts/`，但不引用。

      **明确不做（这一版）**：分支 + PR（2026-09-29 定走直接提交）；多开抢单（afk-run 的 `tryClaim` 也只是尽力而为）；
      定时 / 常驻监听（E1）；看板（viewer 的 trace 就是）。

      测试（内核仓库）：假 `gh` 可执行文件 + 临时 git 仓库 + 假 Agent，覆盖 成功关单 / 审查拒绝回滚 / 验证超轮回滚 /
      `need_human` / `no_change` / 推送失败停下 / 依赖挡住 / `--issue` 点名 / 工作区不干净拒跑。
      实测：在一个自己的测试仓库上开两三个 issue，从 `init` 一路跑到关单。

## F. 工单源无关：GitHub 之外接 TAPD（2026-09-30 提出，同日拍板）

**起因**：日常工作的工单在 TAPD。`github_dev` / `github_discuss`（#6–#12）跑通了，但处处写死 GitHub，
不能「换三个脚本」就接 TAPD。目标：**开发流程**与提示词只写一份，工单系统只是一组可替换的脚本；讨论流程这一批不动（F4 搁置）。
术语（工单 / 讨论单 / 开发单 / 开发单清单 / 工单号 / 工单引用 / 工单源 / 工单快照 / 回帖稿）以根目录 `CONTEXT.md` 为准。
拍板结论汇总在 F6，下面 F1–F5 已按结论改写。

### F0. 现在写死 GitHub 的地方（盘点，2026-09-30 的 `templates/github/`）

- **脚本层**：`gh_ready` / `gh_issue_view` / `gh_issue_mark` / `gh_discuss_list` / `gh_discuss_post` / `gh_tickets_check`
  直接调 `gh`，输入输出带 GitHub 形状（`number`、`labels[].name`）。这一层本来就该按工单系统各写一份，问题不大。
- **任务层**（两个任务 JS 里）：
  - 工单号当整数、显示成 `#N`；日志、评论、提交信息里到处拼 `#${number}`。TAPD 需求 ID 是十几位的长数字，不能当 `#N`
  - AI 标记是评论末尾的 HTML 注释 `<!-- miworkflow:discuss hash=… -->`，由任务自己用正则解析
  - spec / 开发单清单写在正文的 HTML 注释区域里，任务自己拼正文
  - 开发单清单写成 `- [ ] #N` 任务列表；「完成」= 关单
  - 优先级按 `P0`~`P4` 标签算
- **提示词层**（问题最大）：
  - `prompts/tickets.md` 让 Agent **自己**跑 `gh issue create`、`gh label create`，按 GitHub 正文格式写 Parent / 依赖
  - `github_dev` 的 DEV / REVIEWER / FIX 提示词写死提交信息 `#N <标题>` + `Closes #N`
  - `grilling.md` / `spec.md` 开头就是「你在 GitHub issue 里」
  - 这三段是 Agent 直接操作工单系统，换 TAPD 就要重写整套提示词，还得教 Agent 用 `tapd-cli`（竖线分隔标签、下划线参数、多行评论换行……一堆坑）

### F1. 谁碰工单系统 —— 维持现状：拆单仍由 Agent 自己建（2026-09-30 定，**不推翻** #6 Q14）

原提案「Agent 只产出内容（含结构化开发单列表 `data.tickets`），建单 / 写依赖全由脚本做」**不采纳**。
理由：TAPD 的坑有 afk-run 的 TAPD 源可照抄，不是大问题；而且这批不做讨论流程（F4 搁置），拆单只发生在 GitHub 上。

- 开发流程里 Agent 本来就不碰工单系统（认领 / 读单 / 标记全是脚本，Agent 只提交代码），这条决定只影响讨论流程的拆单。
- 读写工单**内容**的方式另定（F2「工单快照」「回帖稿」）：Agent 读的是落盘的 Markdown，写给人看的也写成 Markdown，由脚本发。
- **F4 开工时先重新审视本条**：按回帖稿的思路，拆单也该是「Agent 把每张开发单写成 md、脚本建单 + 传图」，
  否则 Agent 要自己跑 `tapd-cli attachment upload-image` 再把 `html_code` 拼进正文。
  （GitHub 上 `gh issue create --attach` 能让 Agent 自己带图建单，这点对 GitHub 不是障碍。）

### F2. 工单源接口：只管开发流程，固定三个脚本，GitHub / TAPD 各一份实现

✅ **GitHub 一侧已实现**（2026-09-30，#13–#19；规范见 `Core.md` §15，TAPD 实现归 F3）。实现时的取舍：
- 模板组合只改 `run.mjs` 的复制顺序与菜单过滤（跳过 `_` 开头），没有引入任何清单 / 注册机制
- `ticket_mark` 只在回帖稿里确实有图时才跑 `gh --version`；版本不够或查不到都按降级处理（占位 + `say`），不判失败
- 快照下载图片时令牌只经 https 发给 `github.com`，手动跟一跳重定向，跳到别处（S3、或降级成 http）不带令牌
- Agent 报 `no_change` / 报完成但 git 无改动时，也把回帖稿带进失败评论，不丢 Agent 写的理由
- 测试仍按场景拆在 `tests/template-github-*.test.mjs`；「同一套场景 × 两家假工单源」与 `ticket_*` 契约测试等 F3 有第二家时再抽
- 已 `init` 过的项目（含本仓库 `.workflow/`）不回头同步，见 F5 末条

**范围**：只让开发流程与工单源无关。讨论流程（`github_discuss`、`gh_discuss_*`、`gh_tickets_check`、`prompts/grilling|spec|tickets.md`）
原样保留、只支持 GitHub；原提案里的 `tk_discuss_list` / `tk_post` / `tk_create_tickets`、「AI 标记 / spec 的编码归脚本」挪到 F4。

任务只调这三个脚本，不知道背后是哪家。**工单号一律字符串**；日志、评论、`human()` 提问里一律用工单引用 `ref`，不再拼 `#${number}`。

| 脚本 | 入 | 出 | 说明 |
|---|---|---|---|
| `ticket_ready` | `{}` | `{ ready: [{ id, ref, title, priority }], blocked: [{ id, ref, reason }] }` | 就绪 + 依赖都满足 + 已排序（优先级 → 工单号）；`blocked` 给 `--dry-run` 看原因 |
| `ticket_view` | `{ id }` | `{ id, ref, title, file, review }` | 写出工单快照，`file` 是它的路径（见下）；`review` 是这张单有没有「要审查」标签 |
| `ticket_mark` | `{ id, action, commentFile?, comment?, sha? }` | — | `claimed` / `done` / `failed` / `unpushed`；`done` 的含义各家自定（GitHub 关单，TAPD 不关单） |

- **工单快照（读）**：`ticket_view` 把正文 + 全部评论转成 **Markdown**，写到 `logs/<runId>/tickets/<id>/ticket.md`，
  内嵌图片下载到同目录 `images/`，正文里用相对路径（`images/1.png`）引用。放 `logs/<runId>/`：被 `.gitignore` 忽略、
  `git clean -fd` 回滚不删、跑完可复盘。DEV / REVIEWER / FIX 的 `inputs` 只给快照路径，Agent 自己读。
  TAPD 的 HTML 转**完整 Markdown**（保留表格 / 列表 / 加粗；afk-run 只转纯文本，这里不照抄）；GitHub 同样下载 issue 里的图片。
- **回帖稿（写）**：任务每次调 Agent 前分配一个路径（如 `logs/<runId>/tickets/<id>/reply-<n>.md`）放进 `inputs`；
  Agent 有话要对人说（`need_human` 的提问、`no_change` / `reject` 的理由、失败原因）就写进去，图片放同目录、相对路径引用。
  `ticket_mark` 收 `commentFile`：上传图片、换成线上地址、发评论。没写文件时退回用一句话的 `reason`（即 `comment`）。
  - GitHub：`gh issue comment N --body-file <回帖稿> --attach <每张图>`（`gh` ≥ 2.99.0，原地替换本地路径、保留 alt；要仓库写权限）。
    **`gh` 的 cwd 必须是回帖稿所在目录，`--attach` 的路径照回帖稿里的写法原样传**（实测：用绝对路径不会替换，只把图追加到末尾，原引用变成坏图）。
    只在回帖稿里确实有图时才查 `gh` 版本；不够就把图片行换成「（图片未上传：`images/x.png`）」+ `say` 提示升级，评论照发、不判失败。
  - TAPD：逐张 `tapd-cli attachment upload-image`（png/gif/jpg/jpeg/bmp，< 5MB），把回帖稿里的 `![alt](images/x.png)`
    换成 `![alt](<image_src>)`（实测比嵌 `html_code` 好：TAPD 转 HTML 时保留 alt），再 `comment add`（`description` 收 Markdown）；
    发完回读（**走 OpenAPI，别用 `tapd-cli comment list`**，见 F3），检查换行与图片。
- **机器标签两家统一**（名字放各自 `source.mjs`，可改）：`afk-claimed`（认领中）/ `afk-delivered`（已交付）/ `afk-failed`（失败）；
  入队仍是 `ready-for-agent`。GitHub 完成 = 关单 **+ 贴 `afk-delivered`**。代价：与 afk-run 的 gh 源（`in-progress`）换着跑要改配置。
- **依赖满足**（两家同一句话）：前置单贴了 `afk-delivered`，或已关单（GitHub）/ 已到结束类状态（TAPD）。
  前置指向不认识的东西（缺陷、别的项目、已删除）→ **当作挡住**，进 `blocked` 并写明原因，由人解开。
- **工单源常量与提交信息**：每个工单源带一个 `source.mjs`：这家的常量（标签名；GitHub 的 `DISCUSS`；TAPD 的项目 ID、评论人……）
  + `commitMessage(ticket, kind)`（`kind` = `dev` / `review` / `fix`）。GitHub 为 `#N 标题` + `Closes #N`；TAPD 用源码关联关键字（**写法要实测**）。
  共用的 `config.mjs` 只留 `DEV / REVIEWER / VERIFY / ROUNDS / PUSH`。任务把算好的提交信息写进提示词，提示词只说「提交信息用：……」。
- **DEV / REVIEWER / FIX 提示词进共用的 `prompts/`**（`dev.md` / `review.md` / `fix.md`，从任务 JS 里搬出），措辞用「工单」，不提 GitHub / TAPD。
- **任务改名**：`github_dev` → `dev`；`github_discuss` **不改**（仍只支持 GitHub，名字说实话）。
- **模板组合**（改内核 `run.mjs`，约 5 行）：`templates/_shared/`（`dev` 任务、开发提示词、`config.mjs`、`git_*`、`run_cmd`）
  + `templates/github/`（`ticket_*` + `source.mjs` + 讨论流程全部）+ `templates/tapd/`（`ticket_*` + `source.mjs`）。
  `init` 先复制 `_shared` 再复制所选那家；模板菜单跳过 `_` 开头的目录。
- **不做通用抽象层 / 插件机制**：约定就是「这三个脚本名 + 输入输出」，按 §16 不内置 registry。

### F3. TAPD 开发流程（`dev` 接 TAPD）

✅ **已实现**（2026-09-30，#20–#26；规范见 `Core.md` §15，用法见 README「开箱即用：TAPD 开发」）。实现时的取舍：
- 只做开发流程，`dev` 与提示词跟 GitHub 共用，一行没为 TAPD 改；TAPD 的差异全关在三个 `ticket_*` 与 `source.mjs` 里
- `tapd-cli` 管写（改标签、发评论、传图），读评论 / 前后置依赖 / 工作流结束状态直连 OpenAPI（`tapd-cli` 剥 HTML、没封装）
- 候选一次 `story list label=<ready>` 拿全，依赖只对非空壳候选查、同一前置一轮只查一次（个人令牌有每日配额）
- 结束类状态先按项目工作流取，取不到退回 `END_STATUSES` 写死表；不认识的前置一律当挡住，不猜
- 完成不关单：只贴 `afk-delivered`，状态流转留给人验收；工单引用写全 ID `story <需求ID>`（界面短 ID 跨项目会重）
- 提交信息先按 `--story=<需求ID> --user=<评论人> <标题>`，源码关联写法未实测
- 端到端与契约测试用假 `tapd-cli` + 假 OpenAPI，跟 GitHub 同一套场景（#25）；真项目只测过读单与回帖稿全链路（见 F6）
- ✅ #27（2026-09-30，起因：本机代理断了，#23、#24 被当工单失败回滚 + 贴 `afk-failed`）：`dev` 区分 Agent 基础设施故障——
  `agent_cli_failed`（超时除外）/ 空 stdout 的 `agent_invalid_json` 按 `AGENT_RETRY_DELAYS` 退避重试（开发重试前先回起点），
  用完或 `agent_unavailable` / 超时就回滚、`ticket_mark released`（摘认领、不贴失败、保留 ready）、整轮停下，不计入 `--max-failures`。
  待做：Agent 静默超时（N 分钟无事件就杀，要改 `agents/runners/`）
- ✅ #28（2026-09-30，起因：GitHub API 连续 5xx，#26 已推送却关单失败被记成工单失败、#27 认领两次失败，整轮「连续失败 3 次」退出）：
  `runGh` / `runTapd` 对 5xx、GraphQL 通用服务端报错、限流按 `GH_RETRY_DELAYS` / `TAPD_RETRY_DELAYS`（各家 `source.mjs`）秒级退避，
  用完 `ticket_*` 出 `data.transient`；`dev` 在挑单 / 认领 / 关单时见到就整轮停下（不计入 `--max-failures`、不贴 `afk-failed`、不回滚已推送代码）。
  待做：关单失败后下一轮自动补标记（`ticket_ready` 会跳过贴了 `afk-claimed` 的单，要另议）

进度：#20 已搭骨架——`templates/tapd/`（`source.mjs`、`scripts/_tapd.mjs`、三个 `ticket_*` 占位报 failed），
假 `tapd-cli` / 假 OpenAPI 在 `tests/support/`（`tapd-fakes.mjs`），`init --template tapd` 可用。
#21 `ticket_ready`、#22 `ticket_view`、#23 `ticket_mark` 已实现（`upload-image` 的文件参数先按 `file=<绝对路径>`，出参取 `image_src`，待真项目实测）。
#24 前后置依赖已实现：`get_time_relative_stories` 的返回形状、`workflows/last_steps` / `status_map` 取结束类状态都按文档推，待真项目实测；
取不到工作流时退回 `source.mjs` 的 `END_STATUSES`。

照抄对象：afk-run 的 TAPD 源 `C:\projects\agent-skills\skills\afk-run\scripts\task-sources\tapd.mjs`（`createTapdSource`）
与测试 `tests/afk-run/tapd.test.mjs`（经 afk-watch 调用；afk-watch 本身不含 TAPD 实现）。调用方式照它：`execFileSync` 起 `tapd-cli`、不经 shell，瞬时错误最多重试 2 次。

- **只接需求（story）**，缺陷不处理
- **入队 = 只看标签** `ready-for-agent`，排除机器标签（`afk-claimed` / `afk-delivered` / `afk-failed`）。**不要求处理人**（afk-run 把 `tapd.assignee` 设为必填，照抄时去掉）
- **标签写法**：多值用 `|` 分隔；写成逗号**不报错**，TAPD 会把整串当成一个新标签名建出来 → 每次写完回读校验（afk-run 已做）
- **参数一律下划线**（`entry_id`）：afk-run ADR 说连字符会被静默丢掉；注意 `tapd-cli` 技能文档自己的示例用的是连字符（`entry-type=`），别照抄示例
- **评论要评论人**（`TAPD_NPC_ROLE` 或 `source.mjs`）；缺了在动标签**之前**就报错（afk-run 已做）
- **多行评论**：不能 JSON 转义后拼进参数，否则出现字面量 `\n`；直接传参 + 发完回读
- **优先级**（2026-09-30 查项目 `52360842`：`priority` / `priority_label` 候选值都只有 高 / 中 / 低，网页上另有「空」）：
  高 → 1，中 → 2，空 → 2，低 → 3；不认识的值也当 2，并在 `say` 里提示一句
- **图片获取**照抄 `C:\projects\AI_Kanban\extensions\tapd-pending\run.mjs`（`keepImages` / `downloadImage` / `imageUrl`），比 afk-run 那份更全：
  - `<img>` 用宽松正则认 `src`（属性顺序不定，单引号、双引号、不带引号都认）；描述和**评论里的图**都处理
  - `/tfl/...` 这类站内路径 → `tapd-cli attachment get-image workspaceid=… image-path=<src>` 换 `download_url`（300 秒有效）再 `fetch`；本来就是绝对 URL 的直接取
  - **按魔数定扩展名**（TAPD 有的图扩展名写 `.png`、内容其实是 jpeg，扩展名错了读图工具可能不认）
  - 单张取不到只降级（留占位 + stderr 一行），不让整单失败；报错里把 32 位十六进制令牌打码
  - 与我们的差别：它落到全局缓存目录、写绝对路径；我们落到工单快照旁的 `images/`、写相对路径
  - 上限（2026-09-30 定）：每张单最多下 **30** 张图（描述 + 评论合计），超出的在快照里写明「还有 N 张未下载」；
    评论**不截断**（它只留最近 30 条，我们与 GitHub 一致取全部）
  - 它的「未完成」判定是写死状态名 `已完成 / 已拒绝 / 取消 / 已取消`（`with_v_status=1` 取中文状态）—— 可作「结束类状态」的兜底参考
- **读评论必须直接调 OpenAPI**（2026-09-30 实测）：`tapd-cli comment list` 会把评论的 HTML **全部剥掉**只给纯文本（图片、表格、列表都没了），
  直接 `GET $TAPD_API_ENDPOINT/comments?workspace_id=…&entry_type=stories&entry_id=…`（`Authorization: Bearer $TAPD_TOKEN`）才拿得到完整 HTML。
  所以 afk-run 与 tapd-pending 里「评论图」那段经 `tapd-cli` 其实从没生效过。需求描述 `story list` 交回的仍是 HTML，不受影响
- **`tapd-cli comment add` 的 stdout 在 JSON 后面多一行** `已写入 /tmp/comment.log`，直接 `JSON.parse` 会炸 → 只解析第一段 JSON
- **空壳需求**（描述、评论都空）拒单：贴 `afk-failed` + 评论，不凭标题猜（afk-run 已做）
- **「完成」不关单**：状态与处理人属于人和策划的流程，机器不改。完成 = 撤 `afk-claimed` + 贴 `afk-delivered` + 评论提交号，人验收后自己流转状态
- **依赖**（afk-run **完全没做**，`blockedBy` 永远为空，是新活）：TAPD 原生前后置依赖，`tapd-cli` 没封装，要带令牌直接调
  `stories/get_time_relative_stories`（tapd-cli 技能「已知限制」一节有写法）。满足判据见 F2；「结束类状态」先查能否按工作流取到，别写死状态名
- **调用配额**：个人令牌每天有上限（`with_usage=1` 看剩余）；afk-run 没处理（每次全量拉评论）。`--every` 轮询下 `ticket_ready` 先按修改时间粗筛
- 假 `tapd-cli`：照 afk-run 测试的做法（`node fake.mjs` + 状态 JSON 文件），注入点照 `MIWORKFLOW_GH` 用 `MIWORKFLOW_TAPD`

### F4. TAPD 讨论流程（**开工**，2026-09-30；Step 0 摸底 + Step 1 抽共用已做）

开工时先做两件事：① 按 F1 末尾重新审视「拆单由谁建」，与回帖稿的做法对齐；
② 把 F2 挪过来的讨论侧接口（`tk_discuss_list` / `tk_post` / `tk_create_tickets`、AI 标记与 spec 的编码归脚本）重新过一遍。

**进度**（2026-09-30）：
- ✅ **Step 0 TAPD 现场摸底**（真项目 `52360842`）：结论见 F4.1。
- ✅ **Step 1 抽共用（不改行为）**：`github_discuss` → `_shared/tasks/discuss.mjs`；脚本 `gh_discuss_{list,view,post}` / `gh_tickets_check` → `discuss_{list,view,post,check}`；
  讨论提示词 `grilling|spec|tickets.md` 搬进 `_shared/prompts/`；`discuss_*` 四个脚本名与输入输出写进 `Core.md` §15。
  测试与文档同步（`template-github-discuss.test.mjs` 的任务名、`run.test.mjs` 的文件清单、README / Core.md）。208 测试全绿。
  TAPD 侧补 4 个报失败的占位桩（`scripts/discuss_{list,view,post,check}.mjs`，同 #20 的先例）+ `source.mjs` 的 `DISCUSS = null`，
  让 `init --template tapd` 拿到自洽的一份（有 `discuss` 任务也有它的脚本，跑起来是「尚未实现」而不是「找不到脚本」）；Step 2 用真实现替换占位。
  已 `init` 过的项目不回头同步，用 `init --upgrade` 或重 init（§15）。
- ⏳ **Step 2** TAPD 讨论脚本（`templates/tapd/scripts/discuss_*.mjs`）；**Step 3** 同一套场景 × 两家假工单源；**Step 4** 文档 + 真项目跑一整条。
- **待拍板**：D1 拆单由谁建、D3 标记形态、D5 建单细节归谁（证据见下）。

以下为搁置前的分析，已按 Step 0 实测结果改写：

- **AI 标记**（D3，待拍板）：✅ 实测——TAPD **会剥掉 HTML 注释**（`<!-- miworkflow:discuss … -->` 写完回读就没了），
  GitHub 那套不能照搬；带 `<` 的 Markdown **仍按 Markdown 转换**（不会误判成 HTML 模式）。四种候选**都原样存活**：
  纯文本行 `<p>[miworkflow:discuss …]</p>`、`<sub>` 包裹、`<details>` 折叠、`<span data-mw-discuss="…">`（属性也保留、肉眼不可见）。
- **spec 放哪**（D2）：①「写进描述」**排除**——✅ 实测 `story update description=` **不幂等**，每次写入外包一层 `<p>`，写两次变 `<p><p><p>…`。
  剩②发成一条带标记的 AI 评论（最新一条就是当前 spec）与③ Wiki 页面 + 评论链接。
- **拆单**（D1，待拍板）：✅ 实测 `story add parent_id=` 能建**子需求**（项目已在用，一个父单下 20 个子单）、`story list parent_id=` 能回查；
  ✅ 写前后置依赖要直连 OpenAPI `stories/save_time_relations`，**必须 form-encoded**（`relations[0][workitem_id]` 等，JSON 报 422），删用 `relation_ids[0]`。
  硬理由：这些 `tapd-cli` **完全没封装**，Agent 自己做不到 → 倾向「Agent 产出结构化清单、脚本建单 + 写依赖」（F1 末尾的重新审视）。
  开发单清单可写成一条 AI 评论（TAPD 页面上子需求列表本身也能看进度），机器读的是 `parent_id`。
- **阶段**：仍用标签（`discuss:grilling` / `discuss:spec` / `discuss:ticketed`）；✅ 实测标签名**写入即隐式创建**，不用先在项目里建好；清空用 `label=`。
- **配额**：✅ 实测个人令牌 2000/日（测试时剩 1794）；讨论单每个周期都要读评论算哈希，是配额大头；按修改时间粗筛后只读有变化的单。

### F4.1 Step 0 实测结论（2026-09-30，真项目 `52360842`，详细记录在内核仓库本机 `logs/step0/findings.md`）

只读（`openApi()` 的原生 fetch **直连可用**，与代理无关）：

| 结论 | 证据 |
|---|---|
| F3 结束类状态**能按工作流取**：`/workflows/last_steps?system=story` → `status_7=已完成, resolved=已实现, rejected=已拒绝`；`status_map` 给全量中英映射 | 不用退回写死的 `END_STATUSES` 表 |
| F3 配额 `limit 2000/日` | `story list with_usage=1` |
| `parent_id` 过滤有效；项目**已在大量使用子需求**（父单 `…1004537` 下 20 个子单） | 子需求天然适合做开发单 |
| 没有删需求 / 删评论的命令 | `story` / `comment` 子命令列表 |
| **前后置依赖真实形状**：`data: [{ WorkitemTimeRelation: { id, workspace_id, workitem_type, workitem_id, src_field, dst_workspace_id, dst_workitem_type, dst_workitem_id, dst_field, relation_type, lag_time } }]` | `ticket_ready` 的 `unwrap()`+`predecessorsOf()` 对得上 ✓ |
| F3 遗留 bug（已修）：跨项目判定读 `src_workspace_id`，真字段是 `workspace_id` | 改后补了回归用例（`template-tapd.test.mjs`） |
| `tapd-cli` 是 Bun 打包单文件二进制，字符串里 `marked` 出现 20 次 | MD→HTML 用它，默认透传 HTML |

写操作（测试数据：父单 `…1004860` + 子单 `…1004861`，依赖已自清理，需求/评论待人删）：

| # | 结论 |
|---|---|
| W1 | **TAPD 会剥掉 HTML 注释**（写完回读就没了）；带 `<` 的 Markdown 仍按 Markdown 转换 |
| W2 | 四种标记编码都原样存活（纯文本行 / `<sub>` / `<details>` / `<span data-*>`，属性也保留） |
| W3 | `story update description=` **不幂等**：每次写入外包一层 `<p>`；块级标签被塞进 `<p>` 里，标签本身全保留 |
| W4 | `story add parent_id=` 建子需求成功，回参 `Story.id`；`story list parent_id=` 能查回 |
| W5 | `priority_label=中`（中文）写入可用并回读 |
| W6 | `label=a\|b` 的 `\|` 分隔写入正确；**标签名写入隐式创建**，清空用 `label=` |
| W7 | `save_time_relations` **必须 form-encoded**；`delete_time_relations` 用 `relation_ids[0]=<关系id>` |
| W8 | `tapd-cli comment add` 出参是 `{ ok, id }`，**没有 `status` 字段** |

**没测**：F3 的 `--story=<需求ID> --user=<评论人>` 源码关联关键字（要真提交进 TAPD 绑定的仓库，单独排期）。


### F5. 顺序与测试

先在 GitHub 上重构，再接 TAPD（2026-09-30 定）：

1. **F2 在 GitHub 上成形**：模板拆 `_shared` + `github`、`init` 改组合；`github_dev` → `dev`；`gh_ready / gh_issue_view / gh_issue_mark` → `ticket_*`；
   `source.mjs` + `commitMessage`；工单号字符串 + `ref`；DEV / REVIEWER / FIX 提示词进 `prompts/`；机器标签统一；工单快照 + 回帖稿（`gh --attach`）
2. **F3 TAPD 开发**：`templates/tapd/` 的 `ticket_*` + `source.mjs` + 前后置依赖；假 `tapd-cli` 测试；在一个真 TAPD 项目里实测一轮
3. F4：Step 0 摸底 + Step 1 抽共用已做（2026-09-30）；Step 2/3/4 见 F4

- 测试：开发流程的端到端测试改成「同一套场景 × 两家假工单源」各跑一遍（接口一致就该都绿）；
  另给 `ticket_*` 脚本各自一套契约测试（同样的入参，两家交回同样形状）
  - 已做（#25）：`tests/support/dev-sources.mjs` 把两家假工单源接成同一套接口，`dev-scenarios.mjs` / `ticket-contract.mjs`
    各写一遍，由 `tests/dev-<源>.test.mjs`、`tests/tickets-contract-<源>.test.mjs` 各跑一次；原 `template-github-*` 用例保留
- 每一步 `node --test` 全绿；F2 结束时 GitHub 开发流程的行为与 #12 之后一致，**有意的变化只有**：机器标签名、Agent 读快照文件、
  写回帖稿（断言跟着这三处改，其余只改脚本名 / 任务名）；讨论流程的测试不动
- 已经 `init` 过的项目（包括本仓库自己的 `.workflow/`）：模板复制出去就归项目所有、不回头同步（§15），要用新流程就重新 `init` 到新目录再搬配置

### F6. 拍板记录（2026-09-30，grill 五轮）

| 议题 | 结论 |
|---|---|
| Agent 是否不再直接操作工单系统（原 F1） | **否**，维持 #6 Q14；F4 开工时重新审视 |
| 先重构还是先接 TAPD | 先在 GitHub 上做 F2，再做 F3 |
| 术语 | 见 `CONTEXT.md` |
| 范围 | 只做开发流程；讨论流程不动；F4 搁置（后期要做） |
| 工单类型 | TAPD 只接需求，缺陷不处理 |
| TAPD 入队 | 只看标签，不要求处理人 |
| 依赖满足 | `afk-delivered` 或已关单 / 结束类状态；不认识的前置当作挡住并写明原因 |
| 模板组合 | `_shared` + 工单源，`init` 组合（改内核约 5 行） |
| 任务名 | `github_dev` → `dev`；`github_discuss` 不改 |
| 脚本名与形状 | `ticket_ready` / `ticket_view` / `ticket_mark`，见 F2 表 |
| 提交信息 / 工单源常量 | 各工单源的 `source.mjs` + `commitMessage(ticket, kind)`；`config.mjs` 只留共用项 |
| 机器标签 | 两家统一 `afk-claimed` / `afk-delivered` / `afk-failed`（可配置）；GitHub 完成也贴 `afk-delivered` |
| TAPD 优先级 | 高 1 / 中 2 / 空 2 / 低 3，不认识的当 2 并提示 |
| 读单 | 工单快照：完整 Markdown + 图片下载 + 相对路径，放 `logs/<runId>/tickets/<id>/` |
| 写单 | 回帖稿：Agent 写 md + 相对路径图片，脚本传图发评论；GitHub 用 `gh --attach`（≥ 2.99.0，有图才查版本，不够就降级提示） |

**实测项**（不用拍板，F2 / F3 开工前先测）：
- ✅ 2026-09-30 本机 `gh` 已从 2.97.0 升到 2.101.0（手动解压安装在 `%LOCALAPPDATA%\Programs\gh`，winget 在本机会崩）
- ✅ 2026-09-30 `gh --attach`（私有仓库临时 issue，测完已删）：cwd = 回帖稿目录、`--attach images/red.png` / `./images/blue.png`
  → 正文里同写法的引用原地换成 `https://github.com/user-attachments/assets/<uuid>`、alt 保留；多行 Markdown 换行正常。
  从别的目录用绝对路径 `--attach` → **不替换**，图片以文件名为 alt 追加到末尾
- ✅ 2026-09-30 私有仓库 `user-attachments` 图片下载：不带鉴权 404；带 `gh auth token`（`Bearer` 或 `token` 均可）→ 302 到 S3 预签名地址 → 200 PNG。
  实现时手动跟一跳重定向，**别把令牌带到 S3**
- ✅ 2026-09-30 TAPD 工单快照（只读，需求 `1152360842001004614`）：`story list id=… with_v_status=1` + `comment list entry_type=stories entry_id=…`
  → 描述里的 `<img src="/tfl/captures/….png">` 经 `get-image`（`image_path=` 下划线写法可用）换地址下载，108 KB、魔数确认 PNG，
  写成 `images/1.png` 相对路径；3 条评论全取、转 Markdown 正常
- ✅ 2026-09-30 TAPD 回帖稿全链路（同一需求，测试评论 `1152360842001004036`，人工删除）：两张图 `upload-image` → `/tfl/pictures/…` →
  `comment add` Markdown（标题 / 加粗 / 行内代码 / 列表 / 表格 / 两种图片写法）→ OpenAPI 回读为正确 HTML、无字面量 `\n`、两张 `<img>` 都在 →
  按快照取法 `get-image` 把两张评论图下载回来、魔数确认 PNG。顺带查出上面「评论读取」与「stdout 多一行」两个坑。
  （之前「332 条评论没有一条带图」是 `tapd-cli` 剥掉 HTML 造成的假象）
- TAPD 源码关联关键字的写法（`commitMessage` 要用）——F3 已按 `--story=… --user=…` 实现，待真 TAPD 项目实测
- 每日配额够不够 `--every 5m`——待真 TAPD 项目实测
- TAPD「结束类状态」能否按工作流取到——F3 已按 `workflows/last_steps` / `status_map` 实现、取不到退回 `END_STATUSES`，待真 TAPD 项目实测

## G. 审查分级：简单单不起审查 Agent（2026-09-30 提出，同日拍板）

✅ **已实现**（2026-09-30）。实测：`node --test` 207 全绿（新增「审查分级」四个场景 × 两家假工单源）。
实现时的取舍：
- 审查标签留在工单上不清（依赖/再次入队判定不认它，无害）；`dev` 的完成评论里写清「没审查（REVIEW=auto…）」
- DEV 的 `choices` 加 `done_review`；`client` 仍只在校验后分支，不抄进 `data`
- G2 清单全部落地（见下）；SKILL.md 不涉及 dev 模板，未改

**起因**：`dev` 每张单都固定「DEV → REVIEWER → VERIFY」。很多开发单是简单需求，DEV 自测 + `VERIFY` 就够，
REVIEWER 那次完整的 Agent 调用（还要重读项目）是白花的开销。

### G1. 结论

- **加标签才审**：一个「要审查」的机器标签（暂名 `needs-review`，跟 `afk-claimed` 等一样放各家 `source.mjs`，可改）。
  - 拆单 Agent 在 `prompts/tickets.md` 里给地基单（被别的单依赖的）、改公共接口 / 共享模块这类单贴上
  - 人写单时也可以手动贴
- **没标签 = 不审**：DEV 完成后直接进 `VERIFY` → 提交。注意人直接写的单（含目前全部 TAPD 单）也没这个标签，同样默认不审——已知并接受
- **DEV 只能升级、不能降级**：DEV 的 `choices` 改为 `done` / `done_review` / `no_change`；
  选 `done_review` 就起 REVIEWER，原因写 `reason`（进日志）。贴了标签的单 DEV 选 `done` 也照审
  - 走 `choice` 而不是让 Agent 调命令贴标签（开发流程里 Agent 不碰工单系统；失败回滚时标签不会跟着回滚）
  - 也不走 `data` 键值对（`data` 不校验，写错键名会被静默当成不升级；`choice` 不在列表里会判失败）
  - `dev.md` 写明必须升级的情形：改了公共接口、共享模块、配置 / 数据格式的默认值，删改了已有行为——列具体情形，不写一句「影响大就选它」
- **`config.mjs` 加 `REVIEW`**：`'auto'`（默认，按上面的标签 + 升级）/ `'always'`（每单都审，即现在的行为）

### G2. 实现清单（改 `templates/`，本仓库 `.workflow/` 不回头同步，见 F5 末条）

- `templates/_shared/config.mjs`：`REVIEW` 常量
- 两家 `source.mjs`：「要审查」标签名；`ticket_view` 出参加 `review`（布尔，这张单有没有该标签），F2 表与 `Core.md` §15 同步
- `templates/_shared/tasks/dev.mjs`：`needReview = REVIEW === 'always' || t.review || dev.choice === 'done_review'`，否则跳过第 3 步
- `templates/_shared/prompts/dev.md`：`done_review` 的含义与必须升级的情形；不审的单自测是唯一保证，要补测试、自己跑通
- `templates/github/prompts/tickets.md`：什么单贴「要审查」标签
- 测试（`dev-scenarios.mjs`，两家各跑一遍）：没标签跳过审查 / 有标签照审 / `done_review` 升级起审查 / 有标签 + `done` 仍审 / `REVIEW='always'`
- README / `Core.md` / `SKILL.md` 同步口径

### G3. 汇总审查（**搁置**，G1 跑一阵再看要不要）

一个 spec 的开发单全部交付后，统一审查一次，兜住被跳过的单、看单张审查看不到的跨单问题（接口不一致、重复实现、spec 验收条件漏了）。
当时的设想，留作记录：
- 挂在 `github_discuss` 上，阶段 `discuss:ticketed` 之后加 `discuss:reviewed`；开发单清单全部 `afk-delivered` / 已关单就起 REVIEWER
- 输入：spec + 各开发单快照 + 这批提交（按提交信息里的工单引用 `git log --grep` 收集）
- 提交已推送、中间可能夹着别人的提交，只能**向前修**：能修就提交审查修正；修不了就评论讨论单 + 拆补丁开发单或标记给人
- TAPD 讨论流程（F4）搁置、开发单没有父单，这一条只能先在 GitHub 上做

### G4. 拍板记录

| 议题 | 结论 |
|---|---|
| 按 diff 规模决定审不审 | **不做**：改一行也可能影响很大，影响取决于谁依赖这段代码，diff 里看不出来 |
| 谁定默认值 | 拆单 Agent（看得到整个 spec 与依赖，不是开发者本人，不多花一次调用） |
| DEV 的角色 | 只能升级（`done_review`），不能降级 |
| 独立路由 Agent | 不做：要看清影响就得看调用方，已经是半个审查，省不了多少 |
| 没标签的单 | 不审（含人写的单与 TAPD 单），靠 DEV 自测 + `VERIFY` + 升级 |
| `VERIFY` 为空时强制审查 | 不做 |
| `REVIEW` 常量 | 做：`'auto'` / `'always'` |
| 汇总审查 | 搁置（G3） |

## E. 来自 MiCan 的经验（先不做，写明什么时候做）

MiCan 在真实使用里踩出来的需求。MiWorkflow 现在都没有，但**不预先搬**：满足触发条件再做，
能放沉淀区 / 外部工具就不进内核（§16）。

| # | 需求 | MiCan 出处 | 什么时候做 | 大概落点 |
|---|---|---|---|---|
| E1 | 定时触发 | ADR-0010 | 第一个需要定时跑的任务出现 | ✅ 循环运行由入口的 `--every` 提供（#9；`miworkflow <task> --every 5m`，每轮全新 run，纯 Node 跨平台） |
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
