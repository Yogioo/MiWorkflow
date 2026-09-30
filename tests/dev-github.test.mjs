// 开发流程端到端：GitHub 工单源跑一遍共用场景（tests/support/dev-scenarios.mjs）。
import { defineDevScenarios } from './support/dev-scenarios.mjs';
import { SOURCES } from './support/dev-sources.mjs';

defineDevScenarios(SOURCES.github);
