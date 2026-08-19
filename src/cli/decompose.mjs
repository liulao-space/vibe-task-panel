#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { decomposeToStore, decomposeWithLLM, extractRequirementName, normalizeLines, remapTaskIds } from '../core/decompose.mjs';
import { callLLM, loadEnvFile } from '../core/llm.mjs';
import { createTask, clearBranchTasks } from '../core/store.mjs';
import { currentProjectRoot, currentBranch } from '../core/git.mjs';

// 核心：拆解文本并写入任务（CLI 与 server 共用）
// clearOld=true 表示「重新拆解」语义：先清空当前分支旧任务再写入；默认 false 为追加模式：
// 同一分支下已有任务保留（每个任务归属自己的模块 requirement），新拆解任务 id 自动避让。
export async function decomposeText(root, text, branch, useLLM, assignee, clearOld) {
  const requirement = extractRequirementName(normalizeLines(text));
  const br = branch || 'default';

  let cleared = 0;
  if (clearOld) {
    cleared = await clearBranchTasks(root, br);
    if (cleared > 0) console.log('已清空当前分支旧任务 ' + cleared + ' 个');
  }

  let llmTasks = null;
  if (useLLM) {
    try {
      llmTasks = await decomposeWithLLM(text, callLLM);
    } catch (err) {
      llmTasks = null;
      console.error('LLM 拆解不可用，回退启发式拆解: ' + err.message);
    }
  }

  if (llmTasks && llmTasks.length) {
    // 追加模式下避免与已有任务 id 冲突：LLM 给的 T-001… 若已存在则重新编号，并同步改写 depends_on
    const remapped = await remapTaskIds(root, llmTasks);
    const out = [];
    for (const t of remapped.tasks) {
      out.push(await createTask(root, {
        id: t.id,
        branch: br,
        requirement: t.requirement || requirement,
        title: t.title,
        description: t.description || '',
        acceptance: t.acceptance || [],
        depends_on: t.depends_on || [],
        assignee: assignee || t.assignee || null,
        status: 'todo'
      }));
    }
    return { requirement, branch: br, tasks: out, mode: 'llm', cleared };
  }

  const parsed = await decomposeToStore(root, text, br, assignee);
  return { requirement, branch: br, tasks: parsed.tasks, mode: 'heuristic', cleared };
}

// 自动定位需求文档：指定路径 -> docs/ 下第一个 md/txt -> 清晰报错
async function resolveDoc(root, docPath) {
  if (docPath) {
    const p = path.resolve(root, docPath);
    try { await fs.access(p); return p; } catch (e) {
      throw new Error('找不到需求文档: ' + docPath + '，请检查路径');
    }
  }
  const docsDir = path.join(root, 'docs');
  try {
    const files = await fs.readdir(docsDir);
    const md = files.filter((f) => f.endsWith('.md') || f.endsWith('.markdown') || f.endsWith('.txt'));
    if (md.length) return path.join(docsDir, md[0]);
  } catch (e) { /* docs 目录不存在 */ }
  throw new Error('未指定需求文档，且 docs/ 下没有 .md/.txt 文件。用法：decompose <文档路径>');
}

export async function decomposeCommand(root, docPath, useLLM, branch) {
  const p = await resolveDoc(root, docPath);
  const text = await fs.readFile(p, 'utf8');
  return await decomposeText(root, text, branch, useLLM);
}

function openBrowserUrl(url) {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url]);
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', url]);
    else execFileSync('xdg-open', [url]);
  } catch (e) { /* 打开浏览器失败，忽略 */ }
}

function findFreePort(startPort) {
  return new Promise(function (resolve) {
    function tryPort(p) {
      const srv = net.createServer();
      srv.once('error', function () { tryPort(p + 1); });
      srv.listen(p, '127.0.0.1', function () {
        const port = srv.address().port;
        srv.close(function () { resolve(port); });
      });
    }
    tryPort(startPort);
  });
}

async function openPanel(root) {
  try {
    const port = await findFreePort(Number(process.env.VTP_PORT) || 4317);
    const serverScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'server.mjs');
    const child = spawn(process.execPath, [serverScript], {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, { VTP_ROOT: root, VTP_PORT: String(port) })
    });
    child.unref();
    // 等待端口就绪
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/');
        if (res.ok) break;
      } catch (e) { /* 未就绪，继续等 */ }
      await new Promise(function (r2) { setTimeout(r2, 500); });
    }
    const url = 'http://127.0.0.1:' + port + '/';
    openBrowserUrl(url);
    console.log('面板已启动（后台运行）: ' + url);
  } catch (e) {
    console.log('面板启动失败: ' + e.message);
  }
}

async function main() {
  const root = currentProjectRoot(process.env.VTP_ROOT || process.cwd());
  loadEnvFile(root);
  const branch = currentBranch(root);
  const args = process.argv.slice(2);
  const useLLM = !args.includes('--heuristic');
  const docPath = args.find((a) => !a.startsWith('--')) || undefined;
  const result = await decomposeCommand(root, docPath, useLLM, branch);
  console.log('项目: ' + root);
  console.log('分支: ' + result.branch);
  console.log('需求: ' + result.requirement + '  (拆解方式: ' + result.mode + ')');
  console.log('已生成 ' + result.tasks.length + ' 个任务:');
  for (const t of result.tasks) {
    const dep = (t.depends_on && t.depends_on.length) ? ('  依赖 ' + t.depends_on.join(',')) : '';
    console.log('  ' + t.id + ' [' + t.status + '] ' + t.title + dep);
  }
  await openPanel(root);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(String(err)); process.exit(1); });
}
