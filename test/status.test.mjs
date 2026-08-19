import test from 'node:test';
import assert from 'node:assert';
import { canTransition, transition } from '../src/core/status.mjs';

test('合法流转', () => {
  assert.equal(canTransition('todo', 'in_progress'), true);
  assert.equal(canTransition('in_progress', 'in_review'), true);
  assert.equal(canTransition('in_review', 'done'), true);
  assert.equal(canTransition('blocked', 'in_progress'), true);
});

test('非法流转', () => {
  assert.equal(canTransition('todo', 'done'), false);
  assert.equal(canTransition('done', 'todo'), false);
});

test('完成必须通过 review', () => {
  const t = { status: 'in_review', review: { verdict: 'pending' } };
  assert.throws(() => transition(t, 'done'), /必须通过 code review/);
  t.review.verdict = 'passed';
  transition(t, 'done');
  assert.equal(t.status, 'done');
});

test('阻塞记录原因', () => {
  const t = { status: 'todo', review: {} };
  transition(t, 'blocked', '等待依赖');
  assert.equal(t.status, 'blocked');
  assert.equal(t.blocked_reason, '等待依赖');
});

test('非法目标状态', () => {
  const t = { status: 'todo', review: {} };
  assert.throws(() => transition(t, '不存在的状态'), /非法状态/);
});
