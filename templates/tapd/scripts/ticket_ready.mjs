// 工单源接口：列就绪工单。TAPD 实现未完成（F3 后续单），先报 failed。
// 入：{}
// 出：{ status, say, data: { ready: [{ id, ref, title, priority }], blocked: [{ id, ref, reason }] } }，id 为字符串
import { main } from './_lib.mjs';

await main(async () => {
  throw new Error('TAPD 的 ticket_ready 还没实现');
});
