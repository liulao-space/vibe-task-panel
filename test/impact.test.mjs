import test from 'node:test';
import assert from 'node:assert';
import { impactAnalysis, downstreamClosure, upstreamClosure, sharedFileTasks } from '../src/core/impact.mjs';

const tasks = [
  { id: 'A', title: 'A', status: 'done', depends_on: [], files: ['src/a.ts'] },
  { id: 'B', title: 'B', status: 'todo', depends_on: ['A'], files: ['src/b.ts'] },
  { id: 'C', title: 'C', status: 'todo', depends_on: ['B'], files: ['src/c.ts'] },
  { id: 'D', title: 'D', status: 'todo', depends_on: [], files: ['src/a.ts'] }
];

test('下游传递闭包 A->B->C', () => {
  assert.deepEqual(downstreamClosure(tasks, 'A').sort(), ['B', 'C']);
});

test('上游传递闭包', () => {
  assert.deepEqual(upstreamClosure(tasks, 'C').sort(), ['A', 'B']);
});

test('影响分析：下游 + 共享文件并集', () => {
  const r = impactAnalysis(tasks, 'A');
  assert.deepEqual(r.affected.map((x) => x.id).sort(), ['B', 'C', 'D']);
  assert.equal(r.sharedFiles.length, 1);
  assert.equal(r.sharedFiles[0].id, 'D');
});

test('共享文件任务', () => {
  const s = sharedFileTasks(tasks, ['src/a.ts']);
  assert.equal(s.length, 2);
});
