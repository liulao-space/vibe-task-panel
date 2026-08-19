import { buildEdges } from './deps.mjs';

export function byId(tasks) {
  const m = new Map();
  for (const t of tasks) m.set(t.id, t);
  return m;
}

// 下游传递闭包：从 taskId 出发，找出所有"依赖它"的任务（直接+间接）。
// 即：改动 taskId 会影响谁。
export function downstreamClosure(tasks, taskId) {
  const dependents = new Map();
  for (const t of tasks) dependents.set(t.id, []);
  for (const e of buildEdges(tasks)) {
    if (dependents.has(e.from)) dependents.get(e.from).push(e.to);
  }
  const visited = new Set();
  const result = [];
  const queue = [taskId];
  while (queue.length) {
    const u = queue.shift();
    for (const v of (dependents.get(u) || [])) {
      if (!visited.has(v)) {
        visited.add(v);
        result.push(v);
        queue.push(v);
      }
    }
  }
  return result;
}

// 上游传递闭包：找出 taskId 依赖的所有任务（直接+间接）。
export function upstreamClosure(tasks, taskId) {
  const map = byId(tasks);
  const visited = new Set();
  const result = [];
  const queue = [taskId];
  while (queue.length) {
    const u = queue.shift();
    const t = map.get(u);
    for (const dep of (t ? (t.depends_on || []) : [])) {
      if (!visited.has(dep)) {
        visited.add(dep);
        result.push(dep);
        queue.push(dep);
      }
    }
  }
  return result;
}

export function sharedFileTasks(tasks, files) {
  const fileSet = new Set(files);
  const out = [];
  for (const t of tasks) {
    const overlap = (t.files || []).filter((f) => fileSet.has(f));
    if (overlap.length) out.push({ id: t.id, title: t.title, files: overlap });
  }
  return out;
}

function union(arr) {
  return [...new Set(arr)];
}

// 风险评分：下游规模 + 共享文件数 + 是否正在被开发/待审查（活跃改动风险高），已完成任务风险降低
export function riskScore(task, downstreamCount, sharedCount) {
  const active = task.status === 'in_progress' || task.status === 'in_review' ? 10 : 0;
  const donePenalty = task.status === 'done' ? -5 : 0;
  const score = downstreamCount * 3 + sharedCount * 5 + active + donePenalty;
  return {
    score: Math.max(0, score),
    level: score >= 12 ? 'high' : (score >= 5 ? 'medium' : 'low')
  };
}

export function impactAnalysis(tasks, taskId) {
  const map = byId(tasks);
  const task = map.get(taskId);
  if (!task) throw new Error('任务不存在: ' + taskId);
  const downstreamIds = downstreamClosure(tasks, taskId);
  const upstreamIds = upstreamClosure(tasks, taskId);
  const shared = sharedFileTasks(tasks, task.files || []).filter((s) => s.id !== taskId);
  const affected = union([...downstreamIds, ...shared.map((s) => s.id)]).filter((id) => id !== taskId);
  const pick = (id) => {
    const t = map.get(id);
    return t ? { id: t.id, title: t.title, status: t.status } : { id };
  };

  // 风险排序（P1.2）：影响面按风险从高到低排列
  const sharedCountById = {};
  for (const s of shared) sharedCountById[s.id] = (sharedCountById[s.id] || 0) + (s.files || []).length;
  const affectedRanked = affected.map((id) => {
    const t = map.get(id) || { id: id, title: id, status: 'todo' };
    const down = downstreamClosure(tasks, id).length;
    const sh = sharedCountById[id] || 0;
    const r = riskScore(t, down, sh);
    return {
      id: t.id, title: t.title, status: t.status,
      files: (t.files || []),
      downstream_count: down, shared_file_count: sh,
      risk_score: r.score, risk_level: r.level
    };
  }).sort((a, b) => b.risk_score - a.risk_score);

  // 回归测试建议（P1.2）
  const regression = [];
  for (const a of affectedRanked) {
    const t = map.get(a.id);
    const ac = (t && t.acceptance && t.acceptance.length) ? '：' + t.acceptance.join('；') : '';
    regression.push('回归 ' + a.id + '（' + (a.title || a.id) + '）的验收点' + ac);
  }
  for (const s of shared) {
    regression.push('运行涉及共享文件 ' + (s.files || []).join('、') + ' 的测试（任务 ' + s.id + '）');
  }
  const maxRisk = affectedRanked.length ? affectedRanked[0].risk_score : 0;
  const riskLevel = maxRisk >= 12 ? 'high' : (maxRisk >= 5 ? 'medium' : 'low');
  const highCount = affectedRanked.filter((a) => a.risk_level === 'high').length;
  const activeCount = affectedRanked.filter((a) => a.status === 'in_progress' || a.status === 'in_review').length;

  return {
    task: { id: task.id, title: task.title, status: task.status, files: task.files || [] },
    downstream: downstreamIds.map(pick),
    upstream: upstreamIds.map(pick),
    sharedFiles: shared,
    affected: affected.map(pick),
    affectedRanked: affectedRanked,
    regression: regression,
    risk: { level: riskLevel, high_count: highCount, active_count: activeCount, max_score: maxRisk },
    summary: '改动 ' + taskId + ' 会影响 ' + affected.length + ' 个任务' +
      (shared.length ? '，其中 ' + shared.length + ' 个存在共享文件' : '') +
      '，风险等级：' + riskLevel + (highCount ? '（高风险 ' + highCount + ' 个）' : '')
  };
}
