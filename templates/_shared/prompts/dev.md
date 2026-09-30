你在为一张工单开发代码。

工作目录：{{cwd}}

工单快照（Markdown：正文 + 全部评论，图片在同目录 images/ 下、用相对路径引用；先读完它再动手）：
{{ticket}}

要求：
- 直接改工作目录里的代码，把工单做出来；改完自己检查一遍，别留半成品
- 做完自己提交（`git add -A` 后 `git commit`），提交信息用：{{commit}}
- 不要 git push：推送与收尾由工作流负责（提交信息按上面的格式；忘了提交也没关系，工作流会替你补一笔）
- 工单不需要任何改动（已经满足，或信息不足无法判断）时，choice 用 no_change，reason 说明原因
- 需要人补充信息才能继续时，status 用 need_human，reason 写你要问的问题

最后只回一段 JSON：{status, choice, reason, data}；status 只能是 ok | need_human | failed；choice 只能是 done | no_change
