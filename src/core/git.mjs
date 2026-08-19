import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// 从 startDir 向上找 .git，返回项目根目录
// 用于：在子目录运行时，任务数据仍落到项目根的 .vibe-task-panel/
export function currentProjectRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 64; i++) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir || process.cwd());
}

// 当前 git 分支名；不在 git 仓库或失败时返回 'default'
export function currentBranch(root) {
  try {
    const b = execSync('git -C "' + root + '" branch --show-current', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const name = b.trim();
    return name || 'default';
  } catch (err) {
    return 'default';
  }
}

// 收集未提交的本地改动：返回 { stat, diff, file_paths }
// stat = git diff HEAD --stat 的可读摘要；diff = 完整 diff（截断）；file_paths = 改动的文件列表
export function collectUncommittedChanges(root, files) {
  const filesArg = (files && files.length) ? ' -- ' + files.map(function (f) { return '"' + f + '"'; }).join(' ') : '';
  let stat = '';
  let diff = '';
  try {
    stat = execSync('git -C "' + root + '" diff HEAD --stat' + filesArg, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 10485760
    });
  } catch (e) { /* 非 git 仓库或无改动 */ }
  try {
    diff = execSync('git -C "' + root + '" diff HEAD' + filesArg, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 10485760
    });
  } catch (e) { /* ignore */ }
  const filePaths = [];
  if (stat && stat.trim()) {
    const lines = stat.trim().split(String.fromCharCode(10));
    for (const line of lines) {
      const t = line.trim();
      if (t.indexOf('|') > 0 && t.indexOf('file changed') < 0 && t.indexOf('files changed') < 0) {
        filePaths.push(t.split('|')[0].trim());
      }
    }
  }
  return { stat: stat.trim(), diff: diff.slice(0, 20000), file_paths: filePaths };
}
