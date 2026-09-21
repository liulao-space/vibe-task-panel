import { promises as fs } from 'node:fs';
import path from 'node:path';
import { detectCycle, buildEdges, downstreamIds } from './deps.mjs';

export const STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'blocked'];

export function tasksDir(root) {
  return path.join(root, '.vibe-task-panel', 'tasks');
}

export async function readJson(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

export async function listTaskIds(root) {
  const dir = tasksDir(root);
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .map((f) => f.slice(0, -'.json'.length));
}

export async function loadTask(root, id) {
  return readJson(path.join(tasksDir(root), id + '.json'));
}

export async function loadAllTasks(root) {
  const ids = await listTaskIds(root);
  const out = [];
  for (const id of ids) {
    const t = await loadTask(root, id);
    if (t) out.push(t);
  }
  return out;
}

export function defaultTask(partial) {
  return {
    schema_version: 2,
    id: partial.id,
    branch: partial.branch || 'default',
    requirement: partial.requirement || '未分类',
    title: partial.title || partial.id,
    description: partial.description || '',
    acceptance: partial.acceptance || [],
    status: partial.status || 'todo',
    blocked_reason: partial.blocked_reason || null,
    depends_on: partial.depends_on || [],
    files: partial.files || [],
    attachments: partial.attachments || [],
    ui_status: partial.ui_status === undefined ? null : partial.ui_status,
    sessions: partial.sessions || [],
    changes: partial.changes || [],
    assignee: partial.assignee || null,
    comments: partial.comments || [],
    notices: partial.notices || [],
    review: partial.review || { verdict: 'pending', check_results: {}, comments: [], reviewer: null }
  };
}

export async function nextId(root) {
  const ids = await listTaskIds(root);
  let max = 0;
  for (const id of ids) {
    const m = /^T-([0-9]+)$/.exec(id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return 'T-' + String(max + 1).padStart(3, '0');
}

// 写入前校验：以「已有任务 + 本次任务」的完整集合做成环检测，禁止写入成环依赖（PRD 4.1 写入时校验）。
// 只拦截环，不拦截「依赖尚不存在的任务」（批量拆解过程中允许逐步补齐）。
export async function assertNoCycle(root, task) {
  const all = await loadAllTasks(root);
  const others = all.filter((t) => t.id !== task.id);
  const cycle = detectCycle(others.concat(task));
  if (cycle) {
    throw new Error('检测到依赖环，写入被拒绝: ' + cycle.join(' -> '));
  }
  return true;
}

export async function saveTask(root, task) {
  const prev = await loadTask(root, task.id);
  await assertNoCycle(root, task);
  await writeJson(path.join(tasksDir(root), task.id + '.json'), task);
  await notifyDownstream(root, prev, task);
  await rebuildIndex(root);
  return task;
}

export async function createTask(root, partial) {
  const p = Object.assign({}, partial);
  if (!p.id) p.id = await nextId(root);
  const task = defaultTask(p);
  await saveTask(root, task);
  return task;
}

export async function deleteTask(root, id) {
  await fs.rm(path.join(tasksDir(root), id + '.json'), { force: true });
  await rebuildIndex(root);
}

export async function rebuildIndex(root) {
  const tasks = await loadAllTasks(root);
  const reqMap = new Map();
  const requirements = [];
  for (const t of tasks) {
    if (!reqMap.has(t.requirement)) {
      const r = { name: t.requirement, tasks: [] };
      reqMap.set(t.requirement, r);
      requirements.push(r);
    }
    reqMap.get(t.requirement).tasks.push({ id: t.id, title: t.title, status: t.status });
  }
  const branches = [];
  const seenB = new Set();
  for (const t of tasks) {
    const b = t.branch || 'default';
    if (!seenB.has(b)) { seenB.add(b); branches.push(b); }
  }
  const index = {
    schema_version: 1,
    requirements,
    branches,
    tasks: tasks.map((t) => ({
      id: t.id,
      requirement: t.requirement,
      title: t.title,
      status: t.status,
      branch: t.branch || 'default',
      depends_on: t.depends_on || []
    })),
    generated_at: new Date().toISOString()
  };
  await writeJson(path.join(tasksDir(root), 'index.json'), index);
  return index;
}

export async function listBranches(root) {
  const tasks = await loadAllTasks(root);
  const branches = [];
  const seen = new Set();
  for (const t of tasks) {
    const b = t.branch || 'default';
    if (!seen.has(b)) { seen.add(b); branches.push(b); }
  }
  return branches;
}

// ---------- 下游提醒（PRD P2.2） ----------

// 给单个任务追加一条提醒（不重建索引，供批量场景内部使用）
export async function pushNotice(root, taskId, notice) {
  const t = await loadTask(root, taskId);
  if (!t) return null;
  t.notices = t.notices || [];
  t.notices.push(notice);
  await writeJson(path.join(tasksDir(root), taskId + '.json'), t);
  return t;
}

function sameList(a, b) {
  a = a || [];
  b = b || [];
  if (a.length !== b.length) return false;
  const sa = a.slice().sort().join('|');
  const sb = b.slice().sort().join('|');
  return sa === sb;
}

// 任务被修改后，自动提醒所有下游任务（P2.2）：状态 / 依赖 / 文件任一变化都会通知
async function notifyDownstream(root, prev, task) {
  if (!prev) return; // 新建任务无需提醒
  const changes = [];
  if ((prev.status || 'todo') !== (task.status || 'todo')) {
    changes.push('状态从 ' + (prev.status || 'todo') + ' 变为 ' + (task.status || 'todo'));
  }
  if (!sameList(prev.depends_on, task.depends_on)) {
    changes.push('依赖关系发生变化');
  }
  if (!sameList(prev.files, task.files)) {
    changes.push('关联文件发生变化');
  }
  if (changes.length === 0) return;
  const all = await loadAllTasks(root);
  const downstream = downstreamIds(all, task.id);
  for (const id of downstream) {
    await pushNotice(root, id, {
      at: new Date().toISOString(),
      kind: 'dependency_changed',
      from: task.id,
      message: '上游任务 ' + task.id + ' 变化：' + changes.join('；'),
      read: false
    });
  }
}

// ---------- 需求管理（PRD P0.4） ----------

function requirementsPath(root) {
  return path.join(root, '.vibe-task-panel', 'requirements.json');
}

export async function loadRequirements(root) {
  const data = await readJson(requirementsPath(root));
  return Array.isArray(data) ? data : [];
}

export async function saveRequirements(root, list) {
  await writeJson(requirementsPath(root), list);
  return list;
}

export async function createRequirement(root, partial) {
  const list = await loadRequirements(root);
  const name = ((partial && partial.name) || '').trim();
  if (!name) throw new Error('需求名称不能为空');
  if (list.some((r) => r.name === name)) throw new Error('需求已存在: ' + name);
  const req = { name, description: ((partial.description) || '').trim(), created_at: new Date().toISOString() };
  list.push(req);
  await saveRequirements(root, list);
  return req;
}

export async function updateRequirement(root, name, patch) {
  const list = await loadRequirements(root);
  const idx = list.findIndex((r) => r.name === name);
  if (idx === -1) throw new Error('需求不存在: ' + name);
  const next = Object.assign({}, list[idx], patch || {});
  if (next.name && next.name !== name) {
    if (list.some((r, i) => i !== idx && r.name === next.name)) throw new Error('需求已存在: ' + next.name);
    // 重命名：同步所有归属该需求的任务的 requirement 字段
    const all = await loadAllTasks(root);
    for (const t of all) {
      if (t.requirement === name) {
        t.requirement = next.name;
        await writeJson(path.join(tasksDir(root), t.id + '.json'), t);
      }
    }
  }
  list[idx] = next;
  await saveRequirements(root, list);
  await rebuildIndex(root);
  return next;
}

export async function deleteRequirement(root, name) {
  const list = await loadRequirements(root);
  const next = list.filter((r) => r.name !== name);
  await saveRequirements(root, next);
  // 任务保留原 requirement 字符串，不强制迁移
  await rebuildIndex(root);
  return next;
}

export async function clearBranchTasks(root, branch) {
  const ids = await listTaskIds(root);
  const dir = tasksDir(root);
  let removed = 0;
  for (const id of ids) {
    const t = await loadTask(root, id);
    if (t && (t.branch || 'default') === branch) {
      await fs.rm(path.join(dir, id + '.json'), { force: true });
      removed++;
    }
  }
  await rebuildIndex(root);
  return removed;
}
