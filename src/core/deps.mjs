// 依赖图约定：depends_on 表示本任务依赖谁。
// 边方向统一为 from=被依赖者 -> to=依赖者（即 A->B 表示 B 依赖 A，A 影响 B）。

export function buildEdges(tasks) {
  const edges = [];
  for (const t of tasks) {
    for (const dep of (t.depends_on || [])) {
      edges.push({ from: dep, to: t.id });
    }
  }
  return edges;
}

export function detectCycle(tasks) {
  const adj = new Map();
  for (const t of tasks) adj.set(t.id, []);
  for (const e of buildEdges(tasks)) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const t of tasks) color.set(t.id, WHITE);
  const stack = [];
  let cycle = null;

  function dfs(u) {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of (adj.get(u) || [])) {
      if (!adj.has(v)) continue;
      const c = color.get(v);
      if (c === GRAY) {
        const start = stack.indexOf(v);
        cycle = stack.slice(start);
        return true;
      }
      if (c === WHITE && dfs(v)) return true;
    }
    stack.pop();
    color.set(u, BLACK);
    return false;
  }

  for (const t of tasks) {
    if (color.get(t.id) === WHITE && dfs(t.id)) break;
  }
  return cycle;
}

export function validateDeps(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const errors = [];
  for (const t of tasks) {
    for (const dep of (t.depends_on || [])) {
      if (!ids.has(dep)) {
        errors.push('任务 ' + t.id + ' 依赖了不存在的任务 ' + dep);
      }
      if (dep === t.id) {
        errors.push('任务 ' + t.id + ' 不能依赖自己');
      }
    }
  }
  const cycle = detectCycle(tasks);
  if (cycle) {
    errors.push('检测到依赖环: ' + cycle.join(' -> '));
  }
  return { valid: errors.length === 0, errors };
}

// 下游传递闭包（id 列表）：改动 taskId 会影响哪些任务（直接+间接依赖它的任务）
export function downstreamIds(tasks, taskId) {
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

export function topoSort(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const indegree = new Map();
  const adj = new Map();
  for (const t of tasks) {
    indegree.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const e of buildEdges(tasks)) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    indegree.set(e.to, indegree.get(e.to) + 1);
  }
  const queue = [];
  for (const [id, d] of indegree) if (d === 0) queue.push(id);
  const order = [];
  while (queue.length) {
    const u = queue.shift();
    order.push(u);
    for (const v of adj.get(u)) {
      indegree.set(v, indegree.get(v) - 1);
      if (indegree.get(v) === 0) queue.push(v);
    }
  }
  return order;
}
