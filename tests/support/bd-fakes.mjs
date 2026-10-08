// beads 工单源的测试支撑：假 bd（MIWORKFLOW_BD），状态是一份 JSON。真 bd 不进测试。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_BD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-bd.mjs');

// deps：blocks 类前置的 ID；parent：父单 ID（同时记成 parent-child 依赖，跟真 bd 一样）
export const bdIssue = (id, { title = `issue ${id}`, description = `做 ${id}`, status = 'open', priority = 2, labels = [], deps = [], parent, comments = [], ...rest } = {}) => ({
  id: String(id), title, description, status, priority, issue_type: 'task', labels: [...labels],
  dependencies: [
    ...deps.map((d) => ({ issue_id: String(id), depends_on_id: String(d), type: 'blocks' })),
    ...(parent ? [{ issue_id: String(id), depends_on_id: String(parent), type: 'parent-child' }] : [])
  ],
  ...(parent ? { parent: String(parent) } : {}),
  comments,
  ...rest
});

export function writeBdState(file, { issues = [], fail } = {}) {
  writeFileSync(file, JSON.stringify({ issues, ...(fail ? { fail } : {}), calls: [] }, null, 2));
}

export const readBdState = (file) => JSON.parse(readFileSync(file, 'utf8'));

export const bdEnv = (stateFile) => ({ MIWORKFLOW_BD: FAKE_BD, FAKE_BD_STATE: stateFile });
