// 任务示例：看失败态在网页上长什么样，AGENTFLOW_HOME=examples node run.mjs boom
import { script } from 'miworkflow';

export const title = '演示：失败的任务';

export default async function () {
  await script('hello', { who: '失败之前' });
  throw new Error('演示用的失败：这里故意炸一下');
}
