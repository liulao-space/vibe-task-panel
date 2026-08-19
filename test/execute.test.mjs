import { test } from 'node:test';
import assert from 'node:assert';
import { buildExecutePrompt, parseExecuteReport } from '../src/core/execute.mjs';

test('buildExecutePrompt：包含任务信息与验收标准', () => {
  const p = buildExecutePrompt(
    { id: 'T-1', title: '实现哈希', description: 'd', acceptance: ['密码不明文'], files: ['src/a.ts'], depends_on: ['T-0'] },
    ['【文件】src/a.ts 内容：code']
  );
  assert.ok(p.includes('T-1'));
  assert.ok(p.includes('密码不明文'));
  assert.ok(p.includes('src/a.ts'));
  assert.ok(p.includes('acceptance_check'));
});

test('parseExecuteReport：解析 AI 输出', () => {
  const r = parseExecuteReport('{ "summary": "做了", "decision": "选 bcrypt", "file_paths": ["a.ts"], "diff_summary": "新增函数", "rationale": "满足验收", "acceptance_check": [{"criterion":"x","satisfied":true}], "next_steps": ["y"] }');
  assert.equal(r.summary, '做了');
  assert.deepEqual(r.file_paths, ['a.ts']);
  assert.equal(r.acceptance_check.length, 1);
  assert.equal(r.next_steps[0], 'y');
});

test('parseExecuteReport：非 JSON 抛错', () => {
  assert.throws(() => parseExecuteReport('随便写点什么'), /不是 JSON/);
});
