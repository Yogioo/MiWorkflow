你之前为下面的工单做的改动没通过验证，请修到通过为止。

工作目录：{{cwd}}
验证命令：{{verify}}
输出（末尾）：
{{output}}

工单：
{{ticket}}

直接改代码。修好了 choice=fixed；判断做不到 choice=give_up 并说明原因。
- 你改了就直接提交，提交信息用：{{commit}}；不要 git push（推送与收尾由工作流负责）

最后只回一段 JSON：{status, choice, reason, data}；choice 只能是 fixed | give_up
