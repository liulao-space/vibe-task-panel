#!/usr/bin/env node
// Vibe Task Panel MCP Server —— 让 opencode 的 AI 能直接操作任务面板
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentProjectRoot, currentBranch, collectUncommittedChanges } from '../core/git.mjs';
import { loadAllTasks, loadTask, saveTask, pushNotice, createTask } from '../core/store.mjs';
import { transition } from '../core/status.mjs';
import { impactAnalysis } from '../core/impact.mjs';
import { loadEnvFile } from '../core/llm.mjs';
import { aiReviewWithLLM, collectCodeMaterials, approve } from '../core/review.mjs';
import { aiExecuteTask } from '../core/execute.mjs';

const ROOT = currentProjectRoot(process.cwd());
loadEnvFile(ROOT);

const LOG_PATH = path.join(os.homedir(), '.config', 'vibe-task-panel', 'mcp.log');
function logMCP(entry) {
  try {
    const dir = path.dirname(LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(LOG_PATH, entry + String.fromCharCode(10), 'utf8');
  } catch (e) { /* 忽略日志错误 */ }
}
logMCP('===== MCP server 启动 @ ' + new Date().toISOString() + ' root=' + ROOT + ' =====');
const branch = currentBranch(ROOT);

const TOOLS = [
  { name: 'vtp_list_tasks', description: '列出当前项目当前分支的任务，可按状态筛选。执行任务前先看这个，了解任务清单和依赖', inputSchema: { type: 'object', properties: { status: { type: 'string', description: '按状态过滤' } } } },
  { name: 'vtp_create_task', description: '创建任务并落盘到 .vibe-task-panel/tasks/（自动绑定当前 git 分支，享受依赖成环检测与索引重建）。AI 拆解需求后用这个写入，传 task 对象（单个）或 tasks 数组（批量）。支持 attachments（UI 图 [{path 项目根相对路径,label,kind:ui|doc|template|note}]）、ui_status（pending=缺UI图）、acceptance、depends_on、files、assignee', inputSchema: { type: 'object', properties: { task: { type: 'object', description: '单个任务对象' }, tasks: { type: 'array', items: { type: 'object' }, description: '批量任务数组，与 task 二选一' } } } },
  { name: 'vtp_transition', description: '流转任务状态（todo/in_progress/in_review/done/blocked）。开始任务、完成时用', inputSchema: { type: 'object', properties: { id: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'to'] } },
  { name: 'vtp_update_task', description: '更新任务字段（files/acceptance/sessions/changes/attachments/ui_status 等，PATCH 合并）', inputSchema: { type: 'object', properties: { id: { type: 'string' }, patch: { type: 'object' } }, required: ['id', 'patch'] } },
  { name: 'vtp_batch_start', description: '认领任务开始执行。重要：一次只传一个任务 id（一次执行一个任务，完成后再认领下一个）。自动标记 in_progress+执行顺序', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: '按执行顺序排列的任务id' } }, required: ['ids'] } },
  { name: 'vtp_batch_advance', description: '完成当前正在执行的任务，推进到下一个', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } },
  { name: 'vtp_batch_complete', description: '标记一批任务全部执行完成', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } },
  { name: 'vtp_batch_review', description: '批量把任务流转到待审查', inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] } },
  { name: 'vtp_add_session', description: '给任务添加会话记录（summary=本次做了什么，decision=关键决策）。每个任务完成阶段后调用', inputSchema: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' }, decision: { type: 'string' } }, required: ['id', 'summary'] } },
  { name: 'vtp_sync_changes', description: '自动收集当前未提交的 git 改动写入任务的 changes 记录', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'vtp_impact', description: '查看改动某任务会影响的其它任务', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'vtp_review_checks', description: '对任务运行 AI 代码审查（deepseek 基于实际代码审查，返回改动总结/质量问题/学习点）', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'vtp_review_approve', description: '审查通过任务（自动流转到已完成）', inputSchema: { type: 'object', properties: { id: { type: 'string' }, reviewer: { type: 'string' } }, required: ['id'] } },
  { name: 'vtp_execute_task', description: '调用 AI（多供应商自动切换）执行任务：阅读任务与关联代码，输出执行摘要/决策/改动并回填 sessions + changes 记录', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'vtp_add_comment', description: '给任务添加评论（@用户名 会提醒该负责人）', inputSchema: { type: 'object', properties: { id: { type: 'string' }, author: { type: 'string' }, content: { type: 'string' } }, required: ['id', 'content'] } }
];

async function batchAction(ids, action) {
  const all = await loadAllTasks(ROOT);
  const picked = (ids || []).map(function (x) { return all.find(function (t) { return t.id === x; }); }).filter(Boolean);
  const batch = 'batch-' + Date.now();
  if (action === 'start') {
    picked.forEach(function (t, i) { t.status = 'in_progress'; t.exec_batch = batch; t.exec_order = i + 1; t.exec_state = i === 0 ? 'running' : 'pending'; });
  } else if (action === 'advance') {
    const ordered = picked.slice().sort(function (a, b) { return (a.exec_order != null ? a.exec_order : 999) - (b.exec_order != null ? b.exec_order : 999); });
    const idx = ordered.findIndex(function (t) { return t.exec_state === 'running'; });
    if (idx >= 0) { ordered[idx].exec_state = 'done'; if (idx + 1 < ordered.length) ordered[idx + 1].exec_state = 'running'; }
    else if (ordered.length) ordered[0].exec_state = 'running';
  } else if (action === 'complete') {
    picked.forEach(function (t) { t.exec_state = 'done'; });
  } else if (action === 'review') {
    picked.forEach(function (t) {
      t.status = 'in_review';
      delete t.exec_state;
      delete t.exec_order;
      delete t.exec_batch;
    });
  }
  for (const t of picked) await saveTask(ROOT, t);
  return { ok: true, count: picked.length, tasks: picked.map(function (t) { return { id: t.id, status: t.status, exec_state: t.exec_state, exec_order: t.exec_order }; }) };
}

async function callTool(name, args) {
  const a = args || {};
  switch (name) {
    case 'vtp_list_tasks': {
      let tasks = await loadAllTasks(ROOT);
      tasks = tasks.filter(function (t) { return (t.branch || 'default') === branch; });
      if (a.status) tasks = tasks.filter(function (t) { return t.status === a.status; });
      return { branch: branch, total: tasks.length, tasks: tasks.map(function (t) { return { id: t.id, title: t.title, requirement: t.requirement, status: t.status, exec_state: t.exec_state || null, exec_order: t.exec_order || null, depends_on: t.depends_on || [] }; }) };
    }
    case 'vtp_create_task': {
      const list = Array.isArray(a.tasks) ? a.tasks : (a.task ? [a.task] : null);
      if (!list || !list.length) throw new Error('需要 task 对象或 tasks 数组');
      const out = [];
      for (const p of list) {
        if (!p || !p.title) throw new Error('每个任务都需要 title');
        const t = await createTask(ROOT, {
          id: p.id,
          branch: branch,
          requirement: p.requirement || '未分类',
          title: p.title,
          description: p.description || '',
          acceptance: Array.isArray(p.acceptance) ? p.acceptance : [],
          depends_on: Array.isArray(p.depends_on) ? p.depends_on : [],
          files: Array.isArray(p.files) ? p.files : [],
          attachments: Array.isArray(p.attachments) ? p.attachments : [],
          ui_status: (p.ui_status === 'ready' || p.ui_status === 'pending') ? p.ui_status : null,
          assignee: p.assignee || null,
          status: 'todo'
        });
        out.push({ id: t.id, title: t.title, status: t.status, depends_on: t.depends_on, attachments: (t.attachments || []).length, ui_status: t.ui_status });
      }
      return { ok: true, branch: branch, created: out.length, tasks: out };
    }
    case 'vtp_transition': {
      const t = await loadTask(ROOT, a.id);
      if (!t) throw new Error('任务不存在: ' + a.id);
      transition(t, a.to, a.reason);
      await saveTask(ROOT, t);
      return { ok: true, id: t.id, status: t.status };
    }
    case 'vtp_update_task': {
      const t = await loadTask(ROOT, a.id);
      if (!t) throw new Error('任务不存在: ' + a.id);
      Object.assign(t, a.patch || {});
      await saveTask(ROOT, t);
      return { ok: true, id: t.id };
    }
    case 'vtp_batch_start': return await batchAction(a.ids, 'start');
    case 'vtp_batch_advance': return await batchAction(a.ids, 'advance');
    case 'vtp_batch_complete': return await batchAction(a.ids, 'complete');
    case 'vtp_batch_review': return await batchAction(a.ids, 'review');
    case 'vtp_add_session': {
      const t = await loadTask(ROOT, a.id);
      if (!t) throw new Error('任务不存在: ' + a.id);
      t.sessions = t.sessions || [];
      t.sessions.push({ at: new Date().toISOString(), role: 'assistant', summary: a.summary, decision: a.decision || '' });
      await saveTask(ROOT, t);
      return { ok: true, id: t.id, sessions: t.sessions.length };
    }
    case 'vtp_sync_changes': {
      const t = await loadTask(ROOT, a.id);
      if (!t) throw new Error('任务不存在: ' + a.id);
      const changes = collectUncommittedChanges(ROOT, t.files || []);
      if (!changes.diff) return { ok: true, synced: 0, message: '没有未提交改动' };
      t.changes = t.changes || [];
      t.changes.push({ commit: '(未提交)', file_paths: changes.file_paths, diff_summary: changes.stat, rationale: '自动同步 @ ' + new Date().toISOString().slice(0, 19), diff: changes.diff });
      await saveTask(ROOT, t);
      return { ok: true, synced: 1 };
    }
    case 'vtp_impact': {
      const all = await loadAllTasks(ROOT);
      const impact = impactAnalysis(all, a.id);
      return { summary: impact.summary, affected: impact.affected.map(function (x) { return x.id + ' ' + (x.title || ''); }) };
    }
    case 'vtp_review_checks': {
      const t = await loadTask(ROOT, a.id);
      if (!t) throw new Error('任务不存在: ' + a.id);
      const all = await loadAllTasks(ROOT);
      const impact = impactAnalysis(all, a.id);
      const materials = await collectCodeMaterials(t, ROOT);
      const ai = await aiReviewWithLLM(t, impact, materials);
      return { summary: ai.summary || '', quality: ai.quality || '', issues: (ai.issues || []).slice(0, 10), verdict: ai.verdict || '', learning: ai.learning || null };
    }
    case 'vtp_review_approve': {
      const t = await loadTask(ROOT, a.id);
      if (!t) throw new Error('任务不存在: ' + a.id);
      approve(t, a.reviewer || 'AI', { mcp: true });
      if (t.status === 'in_review') transition(t, 'done');
      await saveTask(ROOT, t);
      return { ok: true, id: t.id, status: t.status, verdict: 'passed' };
    }
    case 'vtp_execute_task': {
      const r = await aiExecuteTask(ROOT, a.id);
      return { ok: true, id: a.id, summary: r.report.summary, decision: r.report.decision, diff_summary: r.report.diff_summary, next_steps: r.report.next_steps };
    }
    case 'vtp_add_comment': {
      const t = await loadTask(ROOT, a.id);
      if (!t) throw new Error('任务不存在: ' + a.id);
      const content = String(a.content || '').trim();
      if (!content) throw new Error('评论内容不能为空');
      const author = String(a.author || '').trim() || '匿名';
      const comment = { author: author, at: new Date().toISOString(), content: content };
      t.comments = t.comments || [];
      t.comments.push(comment);
      // @提醒：匹配其它任务负责人
      const mentionMatch = content.match(/@([\w\u4e00-\u9fa5-]+)/g) || [];
      if (mentionMatch.length) {
        const names = mentionMatch.map(function (m) { return m.slice(1); });
        const all = await loadAllTasks(ROOT);
        for (const other of all) {
          if (other.id === a.id) continue;
          if (other.assignee && names.indexOf(other.assignee) !== -1) {
            await pushNotice(ROOT, other.id, {
              at: new Date().toISOString(), kind: 'mention', from: a.id,
              message: author + ' 在任务 ' + a.id + ' 的评论中 @ 了你：' + content.slice(0, 120), read: false
            });
          }
        }
      }
      await saveTask(ROOT, t);
      return { ok: true, id: t.id, comments: t.comments.length };
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async function (line) {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  let result = null;
  let error = null;
  try {
    if (msg.method === 'initialize') {
      logMCP('[' + new Date().toISOString() + '] CONNECTED (initialize from client)');
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'vibe-task-panel', version: '0.1.0' } };
    } else if (msg.method === 'notifications/initialized' || msg.method === 'ping') {
      result = {};
    } else if (msg.method === 'tools/list') {
      result = { tools: TOOLS };
    } else if (msg.method === 'tools/call') {
      logMCP('[' + new Date().toISOString() + '] CALL ' + (msg.params.name || '') + ' ' + JSON.stringify(msg.params.arguments || {}));
      try {
        const out = await callTool(msg.params.name, msg.params.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        logMCP('[' + new Date().toISOString() + '] ERROR ' + (msg.params.name || '') + ' ' + String((e && e.message) || e));
        throw e;
      }
    } else {
      error = { code: -32601, message: '未知方法: ' + msg.method };
    }
  } catch (e) {
    error = { code: -32603, message: String((e && e.message) || e) };
  }
  if (msg.id !== undefined) {
    const resp = { jsonrpc: '2.0', id: msg.id };
    if (error) resp.error = error;
    else resp.result = result;
    process.stdout.write(JSON.stringify(resp) + String.fromCharCode(10));
  }
});
