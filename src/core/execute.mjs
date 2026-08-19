// 多 AI 供应商执行任务并回填结果（PRD P2.1）
// AI 作为"执行者"读取任务 + 关联代码，输出结构化工作记录（摘要/决策/改动），回填 sessions + changes。
import { callLLM } from './llm.mjs';
import { collectCodeMaterials } from './review.mjs';
import { loadTask, saveTask } from './store.mjs';

export function buildExecutePrompt(task, materials) {
  const lines = [];
  lines.push('你是资深工程师，正在执行一个开发任务。请阅读任务信息与关联代码，输出一份结构化工作记录（JSON）。');
  lines.push('');
  lines.push('【任务信息】');
  lines.push('- 任务: ' + task.id + ' ' + (task.title || ''));
  lines.push('- 描述: ' + (task.description || '（无）'));
  const ac = task.acceptance || [];
  lines.push('- 验收标准: ' + (ac.length ? ac.map(function (a, i) { return (i + 1) + '. ' + a; }).join('；') : '（未定义）'));
  lines.push('- 关联文件: ' + ((task.files || []).join(', ') || '（未关联）'));
  lines.push('- 依赖任务: ' + ((task.depends_on || []).join(', ') || '无'));
  lines.push('');
  lines.push('【关联代码/改动】');
  if (materials && materials.length) {
    for (const m of materials) { lines.push(m); lines.push(''); }
  } else {
    lines.push('（未能读取到实际代码，请基于任务描述给出执行方案）');
  }
  lines.push('');
  lines.push('请输出本次执行的工作记录，只输出 JSON（不要解释、不要 markdown 代码块）：');
  lines.push('{');
  lines.push('  "summary": "本次执行做了什么（2-3句话）",');
  lines.push('  "decision": "关键实现决策及理由（为什么这样做）",');
  lines.push('  "file_paths": ["涉及的文件路径"],');
  lines.push('  "diff_summary": "改动的 diff 摘要",');
  lines.push('  "rationale": "为什么这么改（对应哪些验收点）",');
  lines.push('  "acceptance_check": [{"criterion": "验收点原文", "satisfied": true, "note": "说明"}],');
  lines.push('  "next_steps": ["尚未完成或建议的后续步骤"]');
  lines.push('}');
  return lines.join(String.fromCharCode(10));
}

export function parseExecuteReport(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('LLM 执行输出不是 JSON');
  const obj = JSON.parse(text.slice(start, end + 1));
  return {
    summary: obj.summary || '',
    decision: obj.decision || '',
    file_paths: Array.isArray(obj.file_paths) ? obj.file_paths : [],
    diff_summary: obj.diff_summary || '',
    rationale: obj.rationale || '',
    acceptance_check: Array.isArray(obj.acceptance_check) ? obj.acceptance_check : [],
    next_steps: Array.isArray(obj.next_steps) ? obj.next_steps : []
  };
}

export async function aiExecuteTask(root, taskId) {
  const task = await loadTask(root, taskId);
  if (!task) throw new Error('任务不存在: ' + taskId);
  const materials = await collectCodeMaterials(task, root);
  const prompt = buildExecutePrompt(task, materials);
  const raw = await callLLM(prompt, '你是资深工程师，严格按任务要求执行并输出结构化工作记录。');
  const report = parseExecuteReport(raw);
  const at = new Date().toISOString();
  // 回填：会话摘要 + 决策 + 改动记录
  task.sessions = task.sessions || [];
  task.sessions.push({ at: at, role: 'assistant', summary: report.summary, decision: report.decision });
  task.changes = task.changes || [];
  task.changes.push({
    commit: '(AI 执行)',
    file_paths: report.file_paths.length ? report.file_paths : (task.files || []),
    diff_summary: report.diff_summary,
    rationale: report.rationale
  });
  await saveTask(root, task);
  return { report: report, task: task };
}
