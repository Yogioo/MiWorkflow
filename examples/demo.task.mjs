// 任务示例 → 复制到 tasks/demo.mjs 即可运行（import 路径不用改，见 examples/README.md）
import { script, agent, human } from '../core.mjs';

export const title = '演示：脚本 → 人工审批 → Agent → 脚本';

export default async function () {
  await script('hello', { who: 'world' });

  const gate = await human('是否继续跑后面的步骤？');
  if (gate.status !== 'ok') {
    await script('hello', { who: `人工未通过（${gate.status}）` });
    return;
  }

  const decision = await agent('为这次运行写一句结束语');
  await script('hello', { who: decision.reason });
}
