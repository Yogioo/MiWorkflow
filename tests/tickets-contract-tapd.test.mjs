// ticket_* 契约：TAPD 工单源跑一遍共用用例（tests/support/ticket-contract.mjs）。
import { defineTicketContract } from './support/ticket-contract.mjs';
import { SOURCES } from './support/dev-sources.mjs';

defineTicketContract(SOURCES.tapd);
