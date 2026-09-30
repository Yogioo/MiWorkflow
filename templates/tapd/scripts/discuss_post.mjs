// TAPD 讨论流程（grilling → spec → tickets）还没实现（TODO.md F4 Step 2）。
// 先落一个明确报失败的桩，让模板自洽：共用的 tasks/discuss.mjs 在 TAPD 项目里也能加载，
// 跑起来看到的是这句人话，而不是「找不到脚本 discuss_post」。Step 2 用真的实现替换本文件。
import { main, readStdin } from './_lib.mjs';

await main(async () => {
  await readStdin();
  throw new Error('TAPD 讨论流程尚未实现（TODO.md F4 Step 2）：discuss_post 是占位桩');
});
