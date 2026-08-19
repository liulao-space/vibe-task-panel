#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decomposeCommand } from './decompose.mjs';
import { taskPanelCommand } from './task-panel.mjs';

function help() {
  console.log('Vibe Task Panel 命令');
  console.log('  node cli.mjs decompose [docPath]   拆解需求文档为任务');
  console.log('  node cli.mjs task-panel [port]    启动并打开任务面板');
  console.log('  node cli.mjs server [port]        仅启动面板服务');
}

async function main() {
  const cmd = process.argv[2] || 'help';
  const root = path.resolve(process.env.VTP_ROOT || process.cwd());
  if (cmd === 'decompose') {
    return await decomposeCommand(root, process.argv[3]);
  }
  if (cmd === 'task-panel' || cmd === 'panel') {
    const r = await taskPanelCommand(root, process.argv[3]);
    console.log('面板已启动: ' + r.url);
    return;
  }
  if (cmd === 'server') {
    const { startServer } = await import('../server/server.mjs');
    const port = process.argv[3] ? Number(process.argv[3]) : undefined;
    const srv = await startServer(root, { port });
    const addr = srv.address();
    console.log('服务已启动: http://127.0.0.1:' + (addr && addr.port));
    return;
  }
  help();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(String(err)); process.exit(1); });
}
