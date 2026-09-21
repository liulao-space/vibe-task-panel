#!/usr/bin/env node
// 扫描任务 description 中提到的图片文件名，回填 attachments；「无 UI 图/待补充」文案回填 ui_status=pending
// 用法：node scripts/backfill-attachments.mjs [项目根] [--apply]   （默认 dry run，加 --apply 才写盘）
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { currentProjectRoot } from '../src/core/git.mjs';
import { loadAllTasks, saveTask, rebuildIndex } from '../src/core/store.mjs';

const IMG_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt']);

async function walk(dir, out) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.vibe-task-panel') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(full, out); }
    else if (IMG_EXT.test(e.name)) out.push(full);
  }
}

const rootArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
const root = currentProjectRoot(rootArg || process.cwd());

// 1) 索引项目内全部图片：basename -> [项目根相对路径]
const images = [];
await walk(root, images);
const byBase = new Map();
for (const p of images) {
  const rel = path.relative(root, p).split(path.sep).join('/');
  const base = path.basename(p);
  if (!byBase.has(base)) byBase.set(base, []);
  byBase.get(base).push(rel);
}

// 2) 逐任务匹配 description 中提到的图片名
const tasks = await loadAllTasks(root);
let changed = 0;
for (const t of tasks) {
  const desc = t.description || '';
  const atts = (t.attachments || []).slice();
  let touched = false;
  for (const [base, rels] of byBase) {
    if (desc.indexOf(base) === -1) continue;
    for (const rel of rels) {
      if (atts.some((a) => a.path === rel)) continue;
      atts.push({ path: rel, label: base, kind: 'ui' });
      touched = true;
    }
  }
  let ui = t.ui_status || null;
  // 显式「无 UI 图/待补充」文案优先：即使引用了其他图片（如列表页整体图），确认弹窗本身仍缺图
  const explicitMissing = /无\s*UI\s*图|UI\s*图待补充|待补图|缺\s*UI/.test(desc);
  if (explicitMissing) {
    if (ui !== 'pending') { ui = 'pending'; touched = true; }
  } else if (atts.length && ui === 'pending') {
    ui = 'ready'; touched = true;
  }
  if (!touched) continue;
  t.attachments = atts;
  t.ui_status = ui;
  console.log((apply ? '[apply] ' : '[dry]   ') + t.id + '  attachments=' + atts.length + '  ui_status=' + ui +
    (atts.length ? '  (' + atts.map((a) => a.path).join(', ') + ')' : ''));
  changed++;
  if (apply) await saveTask(root, t);
}
if (apply) await rebuildIndex(root);
console.log('扫描任务 ' + tasks.length + ' 个，图片索引 ' + images.length + ' 张，变更 ' + changed + ' 个' + (apply ? '（已写入）' : '（dry run，加 --apply 生效）'));
