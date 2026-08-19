import test from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask, loadTask, loadAllTasks, rebuildIndex, nextId, deleteTask } from '../src/core/store.mjs';

async function tmpRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'vtp-'));
}

test('创建与读取任务', async () => {
  const root = await tmpRoot();
  const t = await createTask(root, { requirement: '测试', title: '任务一' });
  assert.equal(t.id, 'T-001');
  assert.equal(t.status, 'todo');
  const loaded = await loadTask(root, t.id);
  assert.equal(loaded.title, '任务一');
  const all = await loadAllTasks(root);
  assert.equal(all.length, 1);
});

test('nextId 递增', async () => {
  const root = await tmpRoot();
  await createTask(root, { requirement: 'r', title: 'a' });
  await createTask(root, { requirement: 'r', title: 'b' });
  assert.equal(await nextId(root), 'T-003');
});

test('rebuildIndex 生成需求分组', async () => {
  const root = await tmpRoot();
  await createTask(root, { requirement: '登录', title: 'a' });
  await createTask(root, { requirement: '登录', title: 'b' });
  await createTask(root, { requirement: '支付', title: 'c' });
  const index = await rebuildIndex(root);
  assert.equal(index.requirements.length, 2);
});

test('删除任务', async () => {
  const root = await tmpRoot();
  await createTask(root, { requirement: 'r', title: 'a' });
  await deleteTask(root, 'T-001');
  const all = await loadAllTasks(root);
  assert.equal(all.length, 0);
});
