import test from 'node:test';
import assert from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTask, loadTask } from '../src/core/store.mjs';
import { decomposeWithLLM } from '../src/core/decompose.mjs';
import { startServer } from '../src/server/server.mjs';

async function tmpRoot() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'vtp-'));
}

test('createTask 保留 attachments 与 ui_status（schema v2）', async () => {
  const root = await tmpRoot();
  const t = await createTask(root, {
    requirement: '术语库',
    title: '列表页',
    attachments: [{ path: 'docs/img 8.png', label: '列表页', kind: 'ui' }],
    ui_status: 'pending'
  });
  assert.equal(t.schema_version, 2);
  assert.equal(t.attachments.length, 1);
  assert.equal(t.attachments[0].path, 'docs/img 8.png');
  assert.equal(t.ui_status, 'pending');
  const loaded = await loadTask(root, t.id);
  assert.equal(loaded.attachments.length, 1);
  assert.equal(loaded.ui_status, 'pending');
});

test('createTask 不传新字段时给默认值', async () => {
  const root = await tmpRoot();
  const t = await createTask(root, { requirement: 'r', title: 'a' });
  assert.deepEqual(t.attachments, []);
  assert.equal(t.ui_status, null);
});

test('decomposeWithLLM 清洗 attachments 与 ui_status', async () => {
  const raw = JSON.stringify([
    {
      id: 'T-001', title: 'A',
      attachments: [
        { path: ' docs/a.png ', label: '图A', kind: 'ui' },
        { label: '无 path 应被丢弃' },
        { path: 'b.png', kind: 'unknown-kind' }
      ],
      ui_status: 'pending'
    },
    { id: 'T-002', title: 'B', attachments: '不是数组', ui_status: '乱值' }
  ]);
  const llmFn = async () => raw;
  const tasks = await decomposeWithLLM('文档', llmFn);
  assert.equal(tasks[0].attachments.length, 2);
  assert.equal(tasks[0].attachments[0].path, 'docs/a.png');
  assert.equal(tasks[0].attachments[1].kind, 'ui');
  assert.equal(tasks[0].ui_status, 'pending');
  assert.deepEqual(tasks[1].attachments, []);
  assert.equal(tasks[1].ui_status, null);
});

test('/files/ 路由：白名单 mime、404、沙箱拒绝路径穿越', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, 'docs'));
  // 1x1 红色 png
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await fs.writeFile(path.join(root, 'docs', 'a.png'), png);
  await fs.writeFile(path.join(root, 'docs', 'b.txt'), 'not image');
  const srv = await startServer(root, { port: 0 });
  const port = srv.address().port;
  try {
    const ok = await fetch('http://127.0.0.1:' + port + '/files/' + encodeURIComponent('docs/a.png'));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await ok.arrayBuffer());
    assert.equal(buf.length, png.length);

    const miss = await fetch('http://127.0.0.1:' + port + '/files/' + encodeURIComponent('docs/nope.png'));
    assert.equal(miss.status, 404);

    const txt = await fetch('http://127.0.0.1:' + port + '/files/' + encodeURIComponent('docs/b.txt'));
    assert.equal(txt.status, 415);

    const trav = await fetch('http://127.0.0.1:' + port + '/files/' + encodeURIComponent('../../' + path.basename(os.tmpdir()) + '/x.png'));
    assert.equal(trav.status, 403);

    const abs = await fetch('http://127.0.0.1:' + port + '/files/' + encodeURIComponent('/etc/hosts'));
    assert.equal(abs.status, 403);
  } finally {
    srv.close();
  }
});

test('DELETE /api/notes：删除上传文件、404、拒绝路径穿越', async () => {
  const root = await tmpRoot();
  const notesDir = path.join(root, '.vibe-task-panel', 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  await fs.writeFile(path.join(notesDir, 'T-001-2026.png'), 'pngdata');
  const srv = await startServer(root, { port: 0 });
  const port = srv.address().port;
  try {
    const ok = await fetch('http://127.0.0.1:' + port + '/api/notes?file=' + encodeURIComponent('T-001-2026.png'), { method: 'DELETE' });
    assert.equal(ok.status, 200);
    await assert.rejects(() => fs.access(path.join(notesDir, 'T-001-2026.png')), Error);

    const again = await fetch('http://127.0.0.1:' + port + '/api/notes?file=' + encodeURIComponent('T-001-2026.png'), { method: 'DELETE' });
    assert.equal(again.status, 404);

    const trav = await fetch('http://127.0.0.1:' + port + '/api/notes?file=' + encodeURIComponent('../tasks/T-001.json'), { method: 'DELETE' });
    assert.equal(trav.status, 400);
    const abs = await fetch('http://127.0.0.1:' + port + '/api/notes?file=' + encodeURIComponent('/etc/hosts'), { method: 'DELETE' });
    assert.equal(abs.status, 400);
  } finally {
    srv.close();
  }
});
