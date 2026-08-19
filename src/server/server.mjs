import http from 'node:http';
import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAllTasks, loadTask, saveTask, createTask, deleteTask, rebuildIndex, listBranches, loadRequirements, createRequirement, updateRequirement, deleteRequirement, pushNotice } from '../core/store.mjs';
import { transition } from '../core/status.mjs';
import { validateDeps, topoSort, buildEdges } from '../core/deps.mjs';
import { impactAnalysis } from '../core/impact.mjs';
import { runStaticChecks, runFileChecks, runFullChecks, aiReview, aiReviewWithLLM, collectCodeMaterials, approve, reject } from '../core/review.mjs';
import { decomposeToStore } from '../core/decompose.mjs';
import { decomposeText } from '../cli/decompose.mjs';
import { loadEnvFile, loadProviders, addProvider, updateProvider, deleteProvider, activateProvider, activeProvider } from '../core/llm.mjs';
import { currentBranch, collectUncommittedChanges } from '../core/git.mjs';
import { aiExecuteTask } from '../core/execute.mjs';

const DEFAULT_PORT = 4317;
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // 工具项目 src/server/
const WEB_DIR = path.join(__dirname, '..', '..', 'web'); // 前端静态文件固定位于工具项目 web/

// 任务进入「待审查」后自动执行的异步 AI 代码审查（不阻塞 API 响应）
function scheduleAutoReview(root, id) {
  setTimeout(async () => {
    try {
      const task = await loadTask(root, id);
      if (!task || task.status !== 'in_review') return; // 已流转走则跳过
      const all = await loadAllTasks(root);
      const impact = impactAnalysis(all, id);
      const codeMaterials = await collectCodeMaterials(task, root);
      const cr = (task.review && task.review.check_results) || {};
      const auto = { lint: cr.lint, typecheck: cr.typecheck, test: cr.test, summary: ((task.review && task.review.last_auto) || {}).summary || '' };
      const ai = await aiReviewWithLLM(task, impact, codeMaterials, auto);
      task.review = task.review || {};
      task.review.ai = ai;
      task.review.ai_at = new Date().toISOString();
      await saveTask(root, task);
    } catch (e) { /* 异步审查失败不抛出，等待用户手动运行 */ }
  }, 200);
}

function assignLayers(tasks) {
  const map = new Map();
  for (const t of tasks) map.set(t.id, t);
  const layer = new Map();
  for (const t of tasks) layer.set(t.id, 0);
  for (const id of topoSort(tasks)) {
    const t = map.get(id);
    if (!t) continue;
    for (const dep of (t.depends_on || [])) {
      const want = (layer.get(dep) || 0) + 1;
      if (want > (layer.get(id) || 0)) layer.set(id, want);
    }
  }
  return layer;
}

export function createServer(root, opts) {
  loadEnvFile(root);
  const port = (opts && opts.port) || Number(process.env.VTP_PORT) || DEFAULT_PORT;
  const webDir = WEB_DIR; // 前端固定从工具项目提供，任务数据从 root 读

  async function readBody(req) {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (!body) return {};
    try { return JSON.parse(body); } catch (err) { return {}; }
  }

  function send(res, code, data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  }

  async function serveStatic(res, rel) {
    const file = path.join(webDir, rel);
    const clean = file.startsWith(webDir) ? file : path.join(webDir, 'index.html');
    try {
      const data = await fs.readFile(clean);
      const ext = path.extname(clean);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(data);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  }

  async function handleApi(req, res, method, p, u) {
    const seg = p.split('/').filter(Boolean);
    const kind = seg[1];

    if (kind === 'index' && method === 'GET') {
      return send(res, 200, await rebuildIndex(root));
    }
    if (kind === 'providers') {
      if (seg.length === 3 && seg[2] === 'activate' && method === 'POST') {
        const body = await readBody(req);
        try { return send(res, 200, activateProvider(body.name)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (method === 'GET') {
        return send(res, 200, loadProviders());
      }
      if (method === 'POST') {
        const body = await readBody(req);
        try { return send(res, 200, addProvider(body.provider || body)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        try { return send(res, 200, updateProvider(body.name, body.patch || body)); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (method === 'DELETE') {
        const body = await readBody(req);
        const name = u.searchParams.get('name') || (body && body.name);
        if (!name) return send(res, 400, { error: '需要 name' });
        return send(res, 200, deleteProvider(name));
      }
    }
    if (kind === 'config' && method === 'GET') {
      const cfg = loadProviders();
      const ap = activeProvider();
      return send(res, 200, { active: cfg.active, activeProvider: ap, providers: cfg.providers, branch: currentBranch(root) });
    }
    if (kind === 'branches' && method === 'GET') {
      return send(res, 200, { branches: await listBranches(root) });
    }
    if (kind === 'docs' && method === 'GET') {
      // 列出 root/docs 下的需求文档，供前端拆解弹窗选择
      const docsDir = path.join(root, 'docs');
      try {
        const files = (await fs.readdir(docsDir)).filter((f) => /.(md|markdown|txt)$/i.test(f));
        return send(res, 200, files);
      } catch (e) {
        return send(res, 200, []);
      }
    }
    if (kind === 'requirements') {
      const all = await loadAllTasks(root);
      const counts = {};
      for (const t of all) {
        const r = t.requirement || '未分类';
        counts[r] = (counts[r] || 0) + 1;
      }
      const list = (await loadRequirements(root)).map(function (r) {
        return Object.assign({}, r, { task_count: counts[r.name] || 0 });
      });
      if (seg.length === 2) {
        if (method === 'GET') return send(res, 200, list);
        if (method === 'POST') {
          const body = await readBody(req);
          try { return send(res, 201, await createRequirement(root, body)); }
          catch (e) { return send(res, 400, { error: e.message }); }
        }
      }
      if (seg.length === 3) {
        const name = decodeURIComponent(seg[2]);
        if (method === 'PATCH') {
          const body = await readBody(req);
          try { return send(res, 200, await updateRequirement(root, name, body)); }
          catch (e) { return send(res, 400, { error: e.message }); }
        }
        if (method === 'DELETE') {
          try { return send(res, 200, await deleteRequirement(root, name)); }
          catch (e) { return send(res, 400, { error: e.message }); }
        }
      }
      return send(res, 404, { error: '未知需求接口' });
    }
    if (kind === 'notes' && method === 'POST') {
      const body = await readBody(req);
      const notesDir = path.join(root, '.vibe-task-panel', 'notes');
      try { await fs.mkdir(notesDir, { recursive: true }); } catch (e) { /* 目录已存在 */ }
      const safe = String(body.taskId || 'note').replace(/[^\w-]/g, '_');
      const ext = body.format === 'png' ? 'png' : 'svg';
      const name = safe + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;
      const file = path.join(notesDir, name);
      try {
        if (ext === 'png') await fs.writeFile(file, Buffer.from(String(body.data || ''), 'base64'));
        else await fs.writeFile(file, String(body.data || ''), 'utf8');
      } catch (err) {
        return send(res, 400, { error: '保存图片失败: ' + err.message });
      }
      return send(res, 200, { path: file, file: name });
    }
    if (kind === 'validate' && method === 'GET') {
      const tasks = await loadAllTasks(root);
      return send(res, 200, validateDeps(tasks));
    }
    if (kind === 'deps' && method === 'GET') {
      const tasks = await loadAllTasks(root);
      const layers = assignLayers(tasks);
      return send(res, 200, {
        nodes: tasks.map((t) => ({
          id: t.id, title: t.title, requirement: t.requirement, status: t.status, layer: layers.get(t.id) || 0
        })),
        edges: buildEdges(tasks),
        layers: Object.fromEntries(layers)
      });
    }
    if (kind === 'impact' && method === 'GET' && seg.length === 3) {
      const tasks = await loadAllTasks(root);
      return send(res, 200, impactAnalysis(tasks, seg[2]));
    }
    if (kind === 'decompose' && method === 'POST') {
      const body = await readBody(req);
      let text;
      if (body.docPath) {
        text = await fs.readFile(path.join(root, body.docPath), 'utf8');
      } else if (body.text) {
        text = body.text;
      } else {
        return send(res, 400, { error: '需要 docPath 或 text' });
      }
      const branch = currentBranch(root);
      const result = await decomposeText(root, text, branch, true, body.assignee, !!body.clearOld);
      return send(res, 200, result);
    }

    if (kind === 'tasks') {
      if (seg.length === 2) {
        if (method === 'GET') {
          const all = await loadAllTasks(root);
          const branch = u.searchParams.get('branch');
          const tasks = branch ? all.filter((t) => (t.branch || 'default') === branch) : all;
          return send(res, 200, tasks);
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const task = await createTask(root, body);
          return send(res, 201, task);
        }
      }
      if (seg.length >= 3) {
        const id = seg[2];
        const action = seg[3];
        if (!action) {
          if (method === 'GET') {
            const task = await loadTask(root, id);
            if (!task) return send(res, 404, { error: '任务不存在: ' + id });
            return send(res, 200, task);
          }
          if (method === 'PATCH') {
            const task = await loadTask(root, id);
            if (!task) return send(res, 404, { error: '任务不存在: ' + id });
            const body = await readBody(req);
            delete body.id;
            Object.assign(task, body);
            await saveTask(root, task);
            return send(res, 200, task);
          }
          if (method === 'DELETE') {
            await deleteTask(root, id);
            return send(res, 200, { ok: true });
          }
        }
        if (action === 'transition' && method === 'POST') {
          const task = await loadTask(root, id);
          if (!task) return send(res, 404, { error: '任务不存在: ' + id });
          const body = await readBody(req);
          try {
            transition(task, body.to, body.reason);
          } catch (err) {
            return send(res, 400, { error: err.message });
          }
          // P0.3：进入「待审查」自动跑 lint/typecheck/test + 静态/文件检查，结果回填 review.check_results
          if (body.to === 'in_review') {
            try {
              const full = await runFullChecks(task, root);
              task.review = task.review || { verdict: 'pending', check_results: {}, comments: [], reviewer: null };
              task.review.check_results = full.check_results;
              task.review.last_auto = { at: new Date().toISOString(), passed: full.passed, summary: full.auto.summary };
            } catch (e) { /* 检查失败不阻断流转，只记录 */ }
            // 自动异步 AI 代码审查：进入「待审查」即开始，无需人工点「运行 AI 审查」
            scheduleAutoReview(root, id);
          }
          await saveTask(root, task);
          return send(res, 200, task);
        }
        if (seg.length === 3 && seg[2] === 'batch-advance' && method === 'POST') {
          const body = await readBody(req);
          const ids = Array.isArray(body.ids) ? body.ids : [];
          const action = body.action || 'start';
          const batch = body.batch || ('batch-' + Date.now());
          const all = await loadAllTasks(root);
          const picked = ids.map(function (x) { return all.find(function (t) { return t.id === x; }); }).filter(Boolean);
          if (action === 'start') {
            picked.forEach(function (t, i) {
              t.status = 'in_progress';
              t.exec_batch = batch;
              t.exec_order = i + 1;
              t.exec_state = i === 0 ? 'running' : 'pending';
            });
          } else if (action === 'advance') {
            const ordered = picked.slice().sort(function (a, b) { return (a.exec_order != null ? a.exec_order : 999) - (b.exec_order != null ? b.exec_order : 999); });
            const runningIdx = ordered.findIndex(function (t) { return t.exec_state === 'running'; });
            if (runningIdx >= 0) {
              ordered[runningIdx].exec_state = 'done';
              if (runningIdx + 1 < ordered.length) ordered[runningIdx + 1].exec_state = 'running';
            } else if (ordered.length) {
              ordered[0].exec_state = 'running';
            }
          } else if (action === 'complete') {
            picked.forEach(function (t) { t.exec_state = 'done'; });
          } else if (action === 'review') {
            for (const t of picked) {
              t.status = 'in_review';
              delete t.exec_state;
              delete t.exec_order;
              delete t.exec_batch;
              try {
                const full = await runFullChecks(t, root);
                t.review = t.review || { verdict: 'pending', check_results: {}, comments: [], reviewer: null };
                t.review.check_results = full.check_results;
                t.review.last_auto = { at: new Date().toISOString(), passed: full.passed, summary: full.auto.summary };
              } catch (e2) { /* 检查失败不阻断流转 */ }
              scheduleAutoReview(root, t.id);
            }
          }
          for (const t of picked) await saveTask(root, t);
          return send(res, 200, { batch: batch, count: picked.length, tasks: picked });
        }
        if (action === 'sync-changes' && method === 'POST') {
          const task = await loadTask(root, id);
          if (!task) return send(res, 404, { error: '任务不存在: ' + id });
          const changes = collectUncommittedChanges(root, task.files || []);
          if (!changes.diff) return send(res, 200, { synced: 0, message: '没有未提交改动' });
          const record = {
            commit: '(未提交)',
            file_paths: changes.file_paths.length ? changes.file_paths : (task.files || []),
            diff_summary: changes.stat || '(无统计)',
            rationale: '自动同步未提交改动 @ ' + new Date().toISOString().slice(0, 19).replace('T', ' '),
            diff: changes.diff
          };
          task.changes = task.changes || [];
          task.changes.push(record);
          await saveTask(root, task);
          return send(res, 200, { synced: 1, task });
        }
        if (action === 'comments' && method === 'POST') {
          const task = await loadTask(root, id);
          if (!task) return send(res, 404, { error: '任务不存在: ' + id });
          const body = await readBody(req);
          const content = String(body.content || '').trim();
          if (!content) return send(res, 400, { error: '评论内容不能为空' });
          const author = String(body.author || '').trim() || '匿名';
          const comment = { author: author, at: new Date().toISOString(), content: content };
          task.comments = task.comments || [];
          task.comments.push(comment);
          // @提醒（P2.3）：@用户名 匹配其它任务的负责人 assignee
          const mentionMatch = content.match(/@([\w\u4e00-\u9fa5-]+)/g) || [];
          if (mentionMatch.length) {
            const names = mentionMatch.map(function (m) { return m.slice(1); });
            const all = await loadAllTasks(root);
            for (const other of all) {
              if (other.id === id) continue;
              if (other.assignee && names.indexOf(other.assignee) !== -1) {
                await pushNotice(root, other.id, {
                  at: new Date().toISOString(),
                  kind: 'mention',
                  from: id,
                  message: author + ' 在任务 ' + id + ' 的评论中 @ 了你：' + content.slice(0, 120),
                  read: false
                });
              }
            }
          }
          await saveTask(root, task);
          return send(res, 200, task);
        }
        if (action === 'execute' && method === 'POST') {
          try {
            const result = await aiExecuteTask(root, id);
            return send(res, 200, result);
          } catch (e) {
            return send(res, 400, { error: e.message });
          }
        }
        if (action === 'changes' && seg.length >= 6 && seg[5] === 'diff' && method === 'GET') {
          const task = await loadTask(root, id);
          if (!task) return send(res, 404, { error: '任务不存在: ' + id });
          const idx = Number(seg[4]);
          const c = (task.changes || [])[idx];
          if (!c) return send(res, 404, { error: '改动记录不存在' });
          let diff = c.diff || '';
          if (!diff && c.commit && c.commit !== '(未提交)') {
            try {
              diff = execSync('git -C "' + root + '" show ' + c.commit, {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 10485760
              });
            } catch (e) { /* 非 git 仓库或 commit 不存在，忽略 */ }
          }
          return send(res, 200, { diff: diff.slice(0, 50000) });
        }
        if (action === 'review' && method === 'POST') {
          const task = await loadTask(root, id);
          if (!task) return send(res, 404, { error: '任务不存在: ' + id });
          const body = await readBody(req);
          const all = await loadAllTasks(root);
          const impact = impactAnalysis(all, id);
          if (body.action === 'run_checks') {
            const full = await runFullChecks(task, root);
            const codeMaterials = await collectCodeMaterials(task, root);
            const ai = await aiReviewWithLLM(task, impact, codeMaterials, full.auto);
            // 回填 check_results + AI 报告（供 Review 详情与「代码回顾」沉淀学习）
            task.review = task.review || { verdict: 'pending', check_results: {}, comments: [], reviewer: null };
            task.review.check_results = full.check_results;
            task.review.ai = ai;
            task.review.ai_at = new Date().toISOString();
            await saveTask(root, task);
            return send(res, 200, { static: full.static, file: full.file, auto: full.auto, ai, impact, codeFiles: codeMaterials.length, check_results: full.check_results, autoPassed: full.auto.passed });
          }
          if (body.action === 'approve') {
            const full = await runFullChecks(task, root);
            if (!full.passed) return send(res, 400, { error: '检查未通过，无法批准: ' + full.auto.summary + '；' + JSON.stringify(full.check_results) });
            approve(task, body.reviewer || 'human', full.check_results);
            if (task.status === 'in_review') transition(task, 'done');
            await saveTask(root, task);
            return send(res, 200, task);
          }
          if (body.action === 'force_approve') {
            const sc = runStaticChecks(task);
            const fc = await runFileChecks(task, root);
            approve(task, body.reviewer || 'human', { static: sc.checks, files_exist: fc.files_exist, forced: true });
            if (task.status === 'in_review') transition(task, 'done');
            await saveTask(root, task);
            return send(res, 200, task);
          }
          if (body.action === 'reject') {
            reject(task, body.reviewer || 'human', body.comments || []);
            // 打回 = 需要修改，无论当前状态（in_review / done / todo）都回到「进行中」
            if (task.status !== 'blocked') task.status = 'in_progress';
            await saveTask(root, task);
            return send(res, 200, task);
          }
          return send(res, 400, { error: '未知 review action' });
        }
      }
    }
    return send(res, 404, { error: '未知接口: ' + method + ' ' + p });
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    const method = req.method || 'GET';
    try {
      if (p === '/' || p === '/index.html') {
        return await serveStatic(res, 'index.html');
      }
      if (p.startsWith('/api/')) {
        return await handleApi(req, res, method, p, u);
      }
      return await serveStatic(res, p);
    } catch (err) {
      send(res, 500, { error: String((err && err.message) || err) });
    }
  }

  return http.createServer(handle);
}

// 启动 server；端口被占用时自动 +1 换空闲端口（最多尝试 20 个）
export function startServer(root, opts) {
  const basePort = (opts && opts.port) || Number(process.env.VTP_PORT) || DEFAULT_PORT;
  const srv = createServer(root, opts);
  return new Promise((resolve, reject) => {
    let port = basePort;
    const tryListen = () => {
      srv.removeAllListeners('error');
      srv.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < basePort + 20) {
          port = port + 1;
          tryListen();
        } else {
          reject(err);
        }
      });
      srv.listen(port, '127.0.0.1', () => resolve(srv));
    };
    tryListen();
  });
}

async function main() {
  const root = path.resolve(process.env.VTP_ROOT || process.cwd());
  const srv = await startServer(root, {});
  const addr = srv.address();
  const port = addr && addr.port;
  console.log('Vibe Task Panel running at http://127.0.0.1:' + port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(String(err)); process.exit(1); });
}
