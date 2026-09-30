// 工单源接口：落盘工单快照。TAPD 实现未完成（F3 后续单），先报 failed。
import { main } from './_lib.mjs';

await main(async () => {
  throw new Error('TAPD 的 ticket_view 还没实现');
});
