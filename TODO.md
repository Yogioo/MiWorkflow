# TODO

> 与 `Core.md`、`README.md` 同级，**属于内核**：`guard.mjs` 的 `coreFiles()` 不看扩展名，
> 凡不在 `tasks/ scripts/ logs/ examples/` 之下的都算内核（§14.1）。
> 所以新增本文档这一步本身就需要一次人工审批：
>
> ```bash
> node guard.mjs approve --reason "新增 TODO.md 待办清单"
> ```
>
> 这是设计，不是 bug。理由：文档也是内核的一部分，改它同样要留一句人写的理由。

来源：2026-09-28 关于「初始工作流创建」与「自进化」的两轮讨论。规范以 `Core.md` 为准。

---

## A. 自进化（`Core.md` §14 的 v2）

§14 目前只保留原则「失败即需求，测试即护栏，Git 即进化」，并明确**暂不实现**三条。
下面把它们拆成可落地的待办。**共同前置条件是 A0。**

- [ ] **A0. `logs/` 持久化（前置）**
      `logs/` 在 `.gitignore` 里，是纯本机一次性产物。A1/A2 都需要跨运行、甚至跨机器看到历史，
      所以先定一件事：失败记录怎么留 —— 单独 append 一份进 Git 的索引，还是外置到不进 Git 的存储？
      没有 A0，A1/A2 都做不了。

- [ ] **A1. 同一失败出现两次才允许改**
      现在没有任何「失败聚合」。`log()` 每条记录已带 `task` / `error` / `gitSha`，
      数据够用，缺的是按 task 分组、按失败归类、计数的东西。
      落点：`scripts/scan_failures.mjs`（沉淀区，不动内核）。

- [ ] **A2. 新任务成功三次固化**
      需要按 task 统计 `run` 记录里 `status:'ok'` 的次数，到阈值提示「该固化了」。
      同样是 `scripts/` 里的一个动作，不是内核特性。

- [ ] **A3. 自动生成候选 diff**
      把 A1 的输出喂给运行期 `agent()`，让它读日志 + 读 `tasks/`、`scripts/`，提出并落地改动。
      约束必须写死：**只改 `tasks/` 和 `scripts/`，不碰内核**（§14.1）。
      骨架见 `Core.md` §7 `fix_bug.mjs`，扩展成 `tasks/evolve.mjs` 即可。
      注意 §16 两条禁令：**不自动生成任务草案**、**不执行 Agent 输出的 actions** ——
      Agent 自己写文件，任务 JS 只按 `choice` 分支，不代它落地。

- [ ] **A4. 闭环收口**
      A3 改完后接 `script('run_tests')` → `human()` → `script('git_commit')`。
      三步都是普通脚本/原语，**不需要内核支持**。

## B. 摩擦点（需人拍板，可能要改内核）

- [ ] **B1. 「脚本测试放哪」没定死**
      §8 要求「每个脚本配独立测试」，但 `guard.mjs` 的 `WRITABLE_DIRS` 只有
      `tasks/ scripts/ logs/ examples/` —— 给新脚本加测试会新增 `tests/` 文件，
      被判为内核改动，`node --test` 变红，要人 `approve`。
      最常见的场景（加**业务**脚本的测试）却触发**内核**审批，语义错配。二选一：
      - 接受：测试本来就是护栏，人审合理（现状即此，但应写进文档）；
      - 或把业务脚本的测试放进 `scripts/`（代价：绕开 `node --test` 的默认发现规则）。
      改 `Core.md` §8/§14.1 需要终端 `approve`。

## C. 初始工作流创建体验

- [ ] **C1. 补 `AGENTS.md`**
      仓库现在没有面向编码 Agent 的规范文件，「创建初始工作流」只能现场喂
      `Core.md` + `examples/`。应写一份：怎么按 §2.4 拆（确定性 → `scripts/`，
      模糊 → 运行期 `agent()`）、只写沉淀区、不动内核、返回值契约（§6.1 / §6.2）。
      注意 `AGENTS.md` 同样算内核，新增需 `approve`。
- [ ] **C2. 运行期 Agent 适配器**
      `AGENTFLOW_AGENT_CMD` 需要一个吃 stdin 任务包 JSON、吐
      `{status, choice, reason, data}` 纯 JSON 的命令。把 `pi -p` 包成这个契约的动作还没做，
      导致 `agent()` 默认只能走 `agent_unavailable` 分支。落点：`scripts/agent_pi.mjs`（沉淀区）。
- [ ] **C3. 首个真实工作流示例（GitHub Issues）**
      目标：拉 Issues → 按优先级排序 → 生成 md。分工：
      `scripts/fetch_issues.mjs` + `scripts/render_md.mjs` + 运行期 `agent()` 排序 +
      `tasks/issues_digest.mjs` 编排。只作参考时可放 `examples/`。

## D. 明确不做

- 不把上述任何自动化塞进内核（§16）。
- 不做「打包成只读内核」：JS/Node 打包拦不住 Agent，真想物理隔离用只读挂载 + 可写卷，
  那是操作系统的事（§14.1 末尾）。
