import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTask, saveTask, loadTask, loadAllTasks } from '../src/core/store.mjs';

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), 'vtp-cycle-'));
}

test('写入时成环校验：直接成环被拒绝', async () => {
  const root = tmpRoot();
  await createTask(root, { id: 'T-001', requirement: 'R', title: 'A' });
  await createTask(root, { id: 'T-002', requirement: 'R', title: 'B', depends_on: ['T-001'] });
  // T-001 依赖 T-002 -> 构成环
  const t1 = await loadTask(root, 'T-001');
  t1.depends_on = ['T-002'];
  await assert.rejects(() => saveTask(root, t1), /依赖环/);
  rmSync(root, { recursive: true, force: true });
});

test('写入时成环校验：自依赖被拒绝', async () => {
  const root = tmpRoot();
  await createTask(root, { id: 'T-001', requirement: 'R', title: 'A' });
  const t1 = await loadTask(root, 'T-001');
  t1.depends_on = ['T-001'];
  await assert.rejects(() => saveTask(root, t1), /依赖环/);
  rmSync(root, { recursive: true, force: true });
});

test('无环依赖可正常写入；依赖不存在任务不算环', async () => {
  const root = tmpRoot();
  await createTask(root, { id: 'T-001', requirement: 'R', title: 'A' });
  await createTask(root, { id: 'T-002', requirement: 'R', title: 'B', depends_on: ['T-001'] });
  const all = await loadAllTasks(root);
  assert.equal(all.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test('依赖变更自动提醒下游任务（P2.2）', async () => {
  const root = tmpRoot();
  await createTask(root, { id: 'T-001', requirement: 'R', title: 'A', files: [] });
  await createTask(root, { id: 'T-002', requirement: 'R', title: 'B', depends_on: ['T-001'] });
  // 修改 T-001 的关联文件 -> T-002 应收到提醒
  const t1 = await loadTask(root, 'T-001');
  t1.files = ['src/a.ts'];
  await saveTask(root, t1);
  const t2 = await loadTask(root, 'T-002');
  assert.equal((t2.notices || []).length, 1);
  assert.equal(t2.notices[0].kind, 'dependency_changed');
  assert.equal(t2.notices[0].from, 'T-001');
  rmSync(root, { recursive: true, force: true });
});

test('新建任务不产生下游提醒', async () => {
  const root = tmpRoot();
  await createTask(root, { id: 'T-001', requirement: 'R', title: 'A' });
  await createTask(root, { id: 'T-002', requirement: 'R', title: 'B', depends_on: ['T-001'] });
  const t2 = await loadTask(root, 'T-002');
  assert.equal((t2.notices || []).length, 0);
  rmSync(root, { recursive: true, force: true });
});
