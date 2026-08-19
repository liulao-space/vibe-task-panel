import { test } from 'node:test';
import assert from 'node:assert';
import { impactAnalysis, riskScore } from '../src/core/impact.mjs';

const tasks = [
  { id: 'A', title: 'A', status: 'todo', files: ['f1.ts'], depends_on: [], acceptance: ['A 验收'] },
  { id: 'B', title: 'B', status: 'in_progress', files: ['f2.ts'], depends_on: ['A'], acceptance: ['B 验收'] },
  { id: 'C', title: 'C', status: 'done', files: ['f1.ts'], depends_on: ['B'], acceptance: ['C 验收'] }
];

test('impactAnalysis：affected = 传递闭包 ∪ 共享文件', () => {
  const r = impactAnalysis(tasks, 'A');
  assert.deepEqual(r.affected.map((x) => x.id).sort(), ['B', 'C']); // B 下游 + C 共享文件 f1.ts
  assert.ok(r.sharedFiles.some((s) => s.id === 'C'));
});

test('impactAnalysis：风险排序按风险分从高到低', () => {
  const r = impactAnalysis(tasks, 'A');
  const ranked = r.affectedRanked;
  assert.ok(ranked.length >= 2);
  const scores = ranked.map((x) => x.risk_score);
  assert.deepEqual(scores, scores.slice().sort((a, b) => b - a));
  assert.ok(ranked.every((x) => ['high', 'medium', 'low'].includes(x.risk_level)));
  assert.ok(ranked.every((x) => typeof x.risk_score === 'number'));
});

test('impactAnalysis：回归测试建议包含受影响任务与共享文件', () => {
  const r = impactAnalysis(tasks, 'A');
  assert.ok(r.regression.some((s) => s.includes('B') && s.includes('验收')));
  assert.ok(r.regression.some((s) => s.includes('共享文件') && s.includes('f1.ts')));
});

test('impactAnalysis：风险等级汇总', () => {
  const r = impactAnalysis(tasks, 'A');
  assert.ok(['high', 'medium', 'low'].includes(r.risk.level));
  assert.equal(typeof r.risk.high_count, 'number');
  assert.equal(typeof r.risk.max_score, 'number');
});

test('riskScore：活跃任务风险更高', () => {
  const active = riskScore({ status: 'in_progress' }, 1, 0);
  const idle = riskScore({ status: 'todo' }, 1, 0);
  assert.ok(active.score > idle.score);
});
