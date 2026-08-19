import test from 'node:test';
import assert from 'node:assert';
import { validateDeps, detectCycle, topoSort, buildEdges } from '../src/core/deps.mjs';

const tasks = [
  { id: 'T-001', depends_on: [] },
  { id: 'T-002', depends_on: ['T-001'] },
  { id: 'T-003', depends_on: ['T-002'] }
];

test('无环依赖校验通过', () => {
  const v = validateDeps(tasks);
  assert.equal(v.valid, true);
  assert.equal(v.errors.length, 0);
});

test('检测依赖环', () => {
  const cyclic = [
    { id: 'A', depends_on: ['C'] },
    { id: 'B', depends_on: ['A'] },
    { id: 'C', depends_on: ['B'] }
  ];
  assert.ok(detectCycle(cyclic));
  const v = validateDeps(cyclic);
  assert.equal(v.valid, false);
});

test('依赖不存在的任务报错', () => {
  const bad = [{ id: 'A', depends_on: ['X'] }];
  const v = validateDeps(bad);
  assert.equal(v.valid, false);
  assert.ok(v.errors[0].includes('不存在'));
});

test('不能依赖自己', () => {
  const bad = [{ id: 'A', depends_on: ['A'] }];
  const v = validateDeps(bad);
  assert.equal(v.valid, false);
});

test('拓扑排序', () => {
  assert.deepEqual(topoSort(tasks), ['T-001', 'T-002', 'T-003']);
});

test('边方向 from=被依赖者 to=依赖者', () => {
  const edges = buildEdges(tasks);
  assert.deepEqual(edges, [
    { from: 'T-001', to: 'T-002' },
    { from: 'T-002', to: 'T-003' }
  ]);
});
