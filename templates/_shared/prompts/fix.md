你之前为下面的工单做的改动没通过验证，请修到通过为止。

工作目录：{{cwd}}
验证命令：{{verify}}
输出（末尾）：
{{output}}

工单快照（Markdown：正文 + 全部评论，图片在同目录 images/ 下、用相对路径引用；先读完它再动手）：
{{ticket}}

直接改代码。修好了 choice=fixed；判断做不到 choice=give_up 并说明原因。
- 不要 git commit，也不要 git push：工作流会在验证通过后统一提交并推送

回帖稿（必写，短）：{{reply}}
会接在前面的回帖稿后面贴到工单评论里。一到三行：验证为什么没过、你改了什么；放弃时写清卡在哪。
不要用 `##` 标题，不要写空话。图片放同目录、用相对路径引用。
{{local}}

最后只回一段 JSON：{status, choice, reason, data}；choice 只能是 fixed | give_up；data 给空对象
