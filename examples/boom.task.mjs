// 任务示例 → 复制到 tasks/boom.mjs，用来看失败态在网页上长什么样
import { script } from '../core.mjs';

export const title = '演示：失败的任务';

export default async function () {
  await script('hello', { who: '失败之前' });
  throw new Error('演示用的失败：这里故意炸一下');
}
