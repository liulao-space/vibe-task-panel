import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  runStaticChecks, runFileChecks, runAutoChecks, runFullChecks,
  aiReview, approve, reject, buildReviewPrompt, parseReviewReport
} from '../src/core/review.mjs';

function tmpRoot() {
  return mkdtempSync(path.join(tmpdir(), 'vtp-review-'));
}

test('runStaticChecks：缺验收标准为 fail', () => {
  const r = runStaticChecks({ acceptance: [], files: [], depends_on: [] });
  assert.equal(r.passed, false);
  assert.equal(r.checks.acceptance.status, 'fail');
});

test('runStaticChecks：验收/文件/依赖齐全通过', () => {
  const r = runStaticChecks({ acceptance: ['a'], files: ['x.ts'], depends_on: ['T-001'] });
  assert.equal(r.passed, true);
});

test('runFileChecks：关联文件存在', async () => {
  const root = tmpRoot();
  writeFileSync(path.join(root, 'a.ts'), '// hi');
  const r = await runFileChecks({ files: ['a.ts'] }, root);
  assert.equal(r.passed, true);
  rmSync(root, { recursive: true, force: true });
});

test('runAutoChecks：无 lint/typecheck/test 时全部 skip', async () => {
  const root = tmpRoot(); // 无 package.json / tsconfig / test 目录
  const auto = await runAutoChecks(root);
  assert.equal(auto.lint.status, 'skip');
  assert.equal(auto.typecheck.status, 'skip');
  assert.equal(auto.test.status, 'skip');
  assert.equal(auto.passed, true);
  rmSync(root, { recursive: true, force: true });
});

test('runFullChecks：集成静态+文件+自动检查，未通过时可识别', async () => {
  const root = tmpRoot();
  const full = await runFullChecks({ id: 'T-1', acceptance: [], files: [], depends_on: [] }, root);
  assert.equal(full.passed, false); // 缺验收标准
  assert.equal(full.check_results.lint, 'skip');
  assert.ok(full.check_results.acceptance);
  rmSync(root, { recursive: true, force: true });
});

test('approve / reject 写入 verdict', () => {
  const t = { review: { verdict: 'pending', check_results: {}, comments: [], reviewer: null } };
  approve(t, 'human', { lint: 'pass' });
  assert.equal(t.review.verdict, 'passed');
  reject(t, 'human', ['需要改']);
  assert.equal(t.review.verdict, 'rejected');
  assert.deepEqual(t.review.comments, ['需要改']);
});

test('aiReview：无验收/无文件/有影响下游时给出问题清单', () => {
  const t = { acceptance: [], files: [], depends_on: [] };
  const impact = { affected: [{ id: 'T-002' }] };
  const comments = aiReview(t, impact);
  assert.ok(comments.some((c) => c.includes('影响下游任务') && c.includes('T-002')));
  assert.ok(comments.some((c) => c.includes('缺少验收标准')));
});

test('buildReviewPrompt：包含任务信息/影响分析/验收标准', () => {
  const p = buildReviewPrompt(
    { id: 'T-9', title: 'x', description: 'd', acceptance: ['a1'], files: ['f.ts'], depends_on: [] },
    { summary: '影响 2 个任务' },
    ['【文件】f.ts 内容：x'],
    { lint: 'pass', typecheck: 'pass', test: 'fail', summary: 'test 未通过' }
  );
  assert.ok(p.includes('T-9'));
  assert.ok(p.includes('a1'));
  assert.ok(p.includes('影响 2 个任务'));
  assert.ok(p.includes('test: fail'));
});

test('parseReviewReport：提取 JSON', () => {
  const r = parseReviewReport('前置说明 { "summary": "s", "verdict": "approve" } 尾部');
  assert.equal(r.verdict, 'approve');
  assert.throws(() => parseReviewReport('不是 JSON'));
});
