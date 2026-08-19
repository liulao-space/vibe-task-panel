import { promises as fs, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { callLLM } from './llm.mjs';

// 静态检查（无需文件系统）：验收标准、关联文件、依赖
export function runStaticChecks(task) {
  const checks = {};
  const ac = task.acceptance || [];
  checks.acceptance = ac.length > 0
    ? { status: 'pass', note: ac.length + ' 条验收标准' }
    : { status: 'fail', note: '缺少验收标准' };
  const files = task.files || [];
  checks.files = files.length > 0
    ? { status: 'pass', note: files.length + ' 个关联文件' }
    : { status: 'warn', note: '未关联文件，影响分析仅基于显式依赖' };
  const deps = task.depends_on || [];
  checks.deps = deps.length > 0
    ? { status: 'pass', note: deps.length + ' 条显式依赖' }
    : { status: 'info', note: '无显式依赖' };
  const passed = Object.keys(checks).every((k) => checks[k].status !== 'fail');
  return { passed, checks };
}

export async function runFileChecks(task, root) {
  const files = task.files || [];
  const missing = [];
  for (const f of files) {
    try {
      await fs.access(path.join(root, f));
    } catch (err) {
      missing.push(f);
    }
  }
  const passed = missing.length === 0;
  return {
    passed,
    files_exist: passed ? 'pass' : 'fail: 文件不存在 ' + missing.join(', '),
    missing
  };
}

// ---------- 自动门禁：真实执行 lint / typecheck / test（PRD 4.1 / 6.2） ----------

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function readPkg(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

function exists(p) {
  try {
    return existsSync(p);
  } catch (e) {
    return false;
  }
}

// 探测当前项目可用的自动检查命令（只认已存在的，避免触发 npx 联网安装）
export function detectAutoCommands(root) {
  const pkg = readPkg(root);
  const scripts = (pkg && pkg.scripts) || {};
  const commands = {};
  if (scripts.lint) commands.lint = { cmd: npmCmd(), args: ['run', 'lint', '--silent'], label: 'lint' };
  else commands.lint = null;
  if (scripts.typecheck) {
    commands.typecheck = { cmd: npmCmd(), args: ['run', 'typecheck', '--silent'], label: 'typecheck' };
  } else if (exists(path.join(root, 'tsconfig.json'))) {
    const localTsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    commands.typecheck = exists(localTsc)
      ? { cmd: localTsc, args: ['--noEmit'], label: 'tsc --noEmit' }
      : { cmd: npmCmd(), args: ['exec', '--no-install', 'tsc', '--', '--noEmit'], label: 'tsc --noEmit' };
  } else {
    commands.typecheck = null;
  }
  if (scripts.test) {
    commands.test = { cmd: npmCmd(), args: ['test', '--silent'], label: 'test' };
  } else if (exists(path.join(root, 'test'))) {
    commands.test = { cmd: process.execPath, args: ['--test'], label: 'node --test' };
  } else {
    commands.test = null;
  }
  return commands;
}

// 执行单个命令，超时/失败不抛出，返回结构化结果
export function runCheckCommand(root, spec) {
  if (!spec) return { status: 'skip', note: '未配置', passed: true };
  const started = Date.now();
  let res;
  try {
    res = spawnSync(spec.cmd, spec.args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1048576,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    return { status: 'fail', note: '执行失败: ' + String((err && err.message) || err), passed: false };
  }
  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  const truncated = out.length > 4000 ? out.slice(0, 4000) + '\n…(截断)' : out;
  const elapsed = Date.now() - started;
  if (res.error && res.error.code === 'ETIMEDOUT') {
    return { status: 'fail', note: spec.label + ' 超时（120s）', output: truncated, passed: false };
  }
  if (res.status === 0) {
    return { status: 'pass', note: spec.label + ' 通过（' + elapsed + 'ms）', output: truncated || '(无输出)', passed: true };
  }
  return { status: 'fail', note: spec.label + ' 未通过 (exit ' + res.status + ')', output: truncated, passed: false };
}

// 自动门禁三连：lint / typecheck / test（项目级，PRD 6.2 第 1 层）
export async function runAutoChecks(root) {
  const commands = detectAutoCommands(root);
  const auto = {
    lint: runCheckCommand(root, commands.lint),
    typecheck: runCheckCommand(root, commands.typecheck),
    test: runCheckCommand(root, commands.test)
  };
  const ran = Object.keys(auto).filter((k) => auto[k].status !== 'skip');
  const failed = Object.keys(auto).filter((k) => auto[k].status === 'fail');
  auto.passed = failed.length === 0;
  auto.summary = ran.length === 0
    ? '未检测到可运行的 lint/typecheck/test（跳过）'
    : (failed.length === 0 ? '自动检查全部通过（' + ran.join(' / ') + '）' : '自动检查未通过: ' + failed.join(' / '));
  return auto;
}

// 完整门禁：静态检查 + 文件检查 + 自动检查（lint/typecheck/test），产出 check_results 回填字段
export async function runFullChecks(task, root) {
  const sc = runStaticChecks(task);
  const fc = await runFileChecks(task, root);
  const auto = await runAutoChecks(root);
  const passed = sc.passed && fc.passed && auto.passed;
  return {
    static: sc,
    file: fc,
    auto,
    passed,
    check_results: {
      lint: auto.lint.status,
      typecheck: auto.typecheck.status,
      test: auto.test.status,
      acceptance: (sc.checks.acceptance || {}).status || 'fail',
      deps: (sc.checks.deps || {}).status || 'info',
      files_exist: fc.files_exist
    }
  };
}

// 收集审查材料：任务关联文件的实际代码 + git 提交改动统计
export async function collectCodeMaterials(task, root) {
  const materials = [];
  const files = task.files || [];
  for (const f of files) {
    try {
      const p = path.join(root, f);
      const stat = await fs.stat(p);
      if (stat.size > 200000) {
        materials.push('【文件】' + f + '（过大，跳过内容）');
        continue;
      }
      const content = await fs.readFile(p, 'utf8');
      materials.push('【文件】' + f + ' 内容：');
      materials.push(content.slice(0, 8000));
    } catch (e) {
      materials.push('【文件】' + f + '（读取失败或不存在）');
    }
  }
  const changes = task.changes || [];
  for (const c of changes) {
    if (c.commit) {
      try {
        const stat = execSync('git -C "' + root + '" show ' + c.commit + ' --stat', {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        });
        materials.push('【提交 ' + c.commit + ' 改动统计】');
        materials.push(stat.slice(0, 4000));
      } catch (e) { /* git 命令失败，忽略 */ }
    }
  }
  // 未提交的本地改动（工作区 + 已暂存），即使没有 commit 也能审查
  try {
    const filesArg = files.length ? ' -- ' + files.map(function (f) { return '"' + f + '"'; }).join(' ') : '';
    const diff = execSync('git -C "' + root + '" diff HEAD' + filesArg, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 10485760
    });
    if (diff && diff.trim()) {
      materials.push('【未提交的本地改动 diff】');
      materials.push(diff.slice(0, 8000));
    }
  } catch (e) { /* 非 git 仓库或无改动，忽略 */ }
  return materials;
}

export function aiReview(task, impactReport) {
  const comments = [];
  const ac = task.acceptance || [];
  if (ac.length === 0) comments.push('缺少验收标准，无法判断是否满足需求');
  if (impactReport && impactReport.affected && impactReport.affected.length > 0) {
    comments.push('影响下游任务: ' + impactReport.affected.map((a) => a.id).join(', ') + ' —— 请确认未破坏其行为');
  }
  if ((task.files || []).length === 0) comments.push('未关联文件，无法做 diff 审查');
  if (comments.length === 0) comments.push('未发现明显问题');
  return comments;
}

export function approve(task, reviewer, checkResults) {
  if (!reviewer) throw new Error('需要 reviewer');
  task.review = task.review || {};
  task.review.verdict = 'passed';
  task.review.reviewer = reviewer;
  task.review.check_results = Object.assign({}, task.review.check_results || {}, checkResults || {});
  return task;
}

export function reject(task, reviewer, comments) {
  task.review = task.review || {};
  task.review.verdict = 'rejected';
  task.review.reviewer = reviewer;
  task.review.comments = (task.review.comments || []).concat(comments || []);
  return task;
}

export function buildReviewPrompt(task, impactReport, codeMaterials, autoResults) {
  const lines = [];
  lines.push('你是资深代码审查员，请审查以下任务的代码改动。');
  lines.push('');
  lines.push('【任务信息】');
  lines.push('- 任务: ' + task.id + ' ' + (task.title || ''));
  lines.push('- 描述: ' + (task.description || '（无）'));
  const ac = task.acceptance || [];
  lines.push('- 验收标准: ' + (ac.length ? ac.map((a, i) => (i + 1) + '. ' + a).join('；') : '（未定义）'));
  const files = task.files || [];
  lines.push('- 关联文件: ' + (files.length ? files.join(', ') : '（未关联）'));
  lines.push('');
  lines.push('【改动记录】');
  const changes = task.changes || [];
  if (changes.length === 0) lines.push('（暂无改动记录，请在任务中补充 changes 后重新运行检查）');
  for (const c of changes) {
    lines.push('- 文件: ' + ((c.file_paths || []).join(', ') || '未知'));
    lines.push('  diff 摘要: ' + (c.diff_summary || '（无）'));
    lines.push('  改动理由: ' + (c.rationale || '（无）'));
  }
  lines.push('');
  lines.push('【影响分析】');
  lines.push('- ' + (impactReport ? impactReport.summary : '（无）'));
  if (autoResults) {
    lines.push('');
    lines.push('【自动检查结果】');
    const ar = autoResults || {};
    lines.push('- lint: ' + (ar.lint || 'skip') + '；typecheck: ' + (ar.typecheck || 'skip') + '；test: ' + (ar.test || 'skip'));
    lines.push('- ' + (ar.summary || ''));
  }
  lines.push('');
  lines.push('【实际代码/改动】');
  if (codeMaterials && codeMaterials.length) {
    for (const m of codeMaterials) {
      lines.push(m);
      lines.push('');
    }
  } else {
    lines.push('（未能读取到实际代码，仅基于改动记录审查）');
  }
  lines.push('');
  lines.push('请基于以上材料（尤其是实际代码）严格审查，只输出 JSON（不要解释、不要代码块）：');
  lines.push('{');
  lines.push('  "summary": "本次改动总结（2-3句话：改了什么、为什么）",');
  lines.push('  "quality": "代码质量评估（结构/命名/可维护性/边界处理/安全性，结合实际代码）",');
  lines.push('  "issues": [{"severity": "blocker|suggestion|info", "content": "具体问题", "suggestion": "改进建议"}],');
  lines.push('  "acceptance_check": [{"criterion": "验收点原文", "satisfied": true, "note": "是否满足及理由"}],');
  lines.push('  "verdict": "approve 或 reject",');
  lines.push('  "verdict_reason": "审查结论与理由",');
  lines.push('  "learning": {');
  lines.push('    "snippets": [{"title": "片段标题", "code": "推荐或改进后的优质代码片段（可直接学习/复用，从改动中提取或给出更优写法）", "note": "为什么这样写更好"}],');
  lines.push('    "design": "设计思维与架构思路（这个功能背后的设计模式/架构决策，如组合优于继承、单向数据流、可组合性等）",');
  lines.push('    "knowledge": "相关的前端知识点（结合本次改动，如响应式、状态管理、性能优化、浏览器原理等）",');
  lines.push('    "interview_points": "可作面试考点的知识（面试官可能怎么问+应该怎么答）"');
  lines.push('  }');
  lines.push('}');
  return lines.join(String.fromCharCode(10));
}

export function parseReviewReport(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('LLM 审查输出不是 JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export async function aiReviewWithLLM(task, impactReport, codeMaterials, autoResults) {
  const prompt = buildReviewPrompt(task, impactReport, codeMaterials, autoResults);
  try {
    const raw = await callLLM(prompt, '你是资深代码审查员，严格、客观、直接指出问题，重点检查验收标准是否满足、代码质量与边界情况。');
    const parsed = parseReviewReport(raw);
    return parsed;
  } catch (err) {
    return { error: 'LLM 审查失败: ' + err.message, fallback: aiReview(task, impactReport) };
  }
}
