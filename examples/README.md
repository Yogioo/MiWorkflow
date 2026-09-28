# examples

只作参考，**不默认加载**（§15）。内核不预置任何具体实现，`tasks/` 与 `scripts/` 初始为空（§3、§16）。

## 文件名后缀就是目标位置

| 文件 | 复制到 |
|---|---|
| `*.task.mjs` | `tasks/<name>.mjs` |
| `*.script.mjs` | `scripts/<name>.mjs` |

平铺而不是按 `tasks/`、`scripts/` 分目录，是为了**复制过去一个字都不用改**：
示例任务 import 的是 `'../core.mjs'`，而 `examples/` 与 `tasks/` 同在根目录下一层。

## 试用

```bash
cp examples/demo.task.mjs    tasks/demo.mjs
cp examples/hello.script.mjs scripts/hello.mjs

node run.mjs demo                        # 有终端 → 就地 y/N
AGENTFLOW_HUMAN=web node run.mjs demo    # 无终端 → 挂起等网页决定
node viewer/serve.mjs                    # 另开一个终端，浏览器打开
```

失败态：

```bash
cp examples/boom.task.mjs tasks/boom.mjs
node run.mjs boom
```

用完把 `tasks/`、`scripts/` 里的示例删掉，正式内容由使用中沉淀（§15）。
