# examples

只作参考，**不默认加载**（§15）。内核仓库不放任何沉淀；`examples/` 本身就是一个 HOME（§3）：

```text
examples/
  tasks/demo.mjs      # 脚本 → 人工审批 → Agent → 脚本
  tasks/boom.mjs      # 故意失败，看失败态
  scripts/hello.mjs   # 最小脚本
  logs/               # 跑的时候自动建，gitignore
```

## 试用

不用复制，把 HOME 指过来直接跑（PowerShell 用 `$env:AGENTFLOW_HOME='examples'`）：

```bash
AGENTFLOW_HOME=examples node run.mjs demo --who 你               # 有终端 → 就地 y/N
AGENTFLOW_HOME=examples AGENTFLOW_HUMAN=web node run.mjs demo    # 无终端 → 挂起等网页决定
AGENTFLOW_HOME=examples node run.mjs view                        # 另开一个终端，浏览器打开，也能点「运行」
AGENTFLOW_HOME=examples node run.mjs boom                        # 失败态
```

示例任务不 import 内核，原语和参数由 `run.mjs` 传进来；拷进业务仓库的 `.workflow/tasks/` 一个字不用改（§5、§15）。
