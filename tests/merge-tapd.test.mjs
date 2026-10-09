// 合并流程端到端：tapd 工单源跑一遍共用场景（tests/support/merge-scenarios.mjs）。
import { defineMergeScenarios } from './support/merge-scenarios.mjs';
import { SOURCES } from './support/dev-sources.mjs';

defineMergeScenarios(SOURCES.tapd);
