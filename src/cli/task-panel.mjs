#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { startServer } from '../server/server.mjs';
import { currentProjectRoot } from '../core/git.mjs';
import { loadEnvFile } from '../core/llm.mjs';

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url]);
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', url]);
    else execFileSync('xdg-open', [url]);
    return true;
  } catch (err) {
    return false;
  }
}

// 启动前清理占用该端口的旧进程，避免打开旧面板
function freePort(port) {
  try {
    const out = execSync('lsof -ti:' + port, { encoding: 'utf8' }).trim();
    if (!out) return;
    const pids = out.split(String.fromCharCode(10)).filter(Boolean);
    for (const pid of pids) {
      try { execSync('kill -9 ' + pid, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    /* 端口空闲或 lsof 不可用，忽略 */
  }
}

export async function taskPanelCommand(root, portArg) {
  const port = portArg ? Number(portArg) : (Number(process.env.VTP_PORT) || 4317);
  // 先清理占用该端口的旧面板进程，避免旧代码进程残留导致功能不生效
  freePort(port);
  const srv = await startServer(root, { port });
  const addr = srv.address();
  const actualPort = addr && addr.port;
  const url = 'http://127.0.0.1:' + actualPort + '/';
  openBrowser(url);
  return { url, port: actualPort };
}

async function main() {
  const root = currentProjectRoot(process.env.VTP_ROOT || process.cwd());
  loadEnvFile(root);
  const r = await taskPanelCommand(root, process.argv[2]);
  console.log('Vibe Task Panel 已启动: ' + r.url);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(String(err)); process.exit(1); });
}
