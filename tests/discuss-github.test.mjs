// 讨论流程端到端：GitHub 工单源跑一遍共用场景（tests/support/discuss-scenarios.mjs）。
import { defineDiscussScenarios } from './support/discuss-scenarios.mjs';
import { SOURCES } from './support/discuss-sources.mjs';

defineDiscussScenarios(SOURCES.github);
