import { STATUSES } from './store.mjs';

export const TRANSITIONS = {
  todo: ['in_progress', 'blocked'],
  in_progress: ['in_review', 'blocked', 'todo'],
  in_review: ['done', 'in_progress', 'blocked'],
  done: [],
  blocked: ['todo', 'in_progress']
};

export function isValidStatus(s) {
  return STATUSES.includes(s);
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function transition(task, to, reason) {
  if (!isValidStatus(to)) {
    throw new Error('非法状态: ' + to);
  }
  if (!canTransition(task.status, to)) {
    throw new Error('不允许从 ' + task.status + ' 流转到 ' + to);
  }
  if (to === 'done') {
    if (!task.review || task.review.verdict !== 'passed') {
      throw new Error('任务必须通过 code review 才能标记为已完成');
    }
  }
  const from = task.status;
  task.status = to;
  // 离开「进行中」时清理批次执行标记（正在执行/排队中/已执行完不再有意义）
  if (from === 'in_progress' && to !== 'in_progress') {
    delete task.exec_state;
    delete task.exec_order;
    delete task.exec_batch;
  }
  if (to === 'blocked') {
    task.blocked_reason = reason || task.blocked_reason || '';
  } else if (task.blocked_reason !== undefined) {
    task.blocked_reason = null;
  }
  // 清除已打回标记
  if (task.review && task.review.verdict === 'rejected') {
    task.review.verdict = undefined;
  }
  return task;
}
