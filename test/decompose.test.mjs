import test from 'node:test';
import assert from 'node:assert';
import { decomposeDoc, extractRequirementName, extractBullets } from '../src/core/decompose.mjs';

const doc = '# 需求：用户登录功能\n\n## 需求描述\n- 邮箱注册\n- 邮箱登录\n\n## 验收要点\n- 密码 bcrypt 哈希\n- 5 次失败锁定';

test('提取需求名', () => {
  assert.equal(extractRequirementName(doc.split(String.fromCharCode(10))), '需求：用户登录功能');
});

test('提取 bullets', () => {
  const bullets = extractBullets(doc.split(String.fromCharCode(10)));
  assert.equal(bullets.length, 4);
  assert.equal(bullets[0].title, '邮箱注册');
  assert.equal(bullets[0].section, '需求描述');
});

test('拆解：需求描述为任务，验收要点为 acceptance', () => {
  const r = decomposeDoc(doc);
  assert.equal(r.requirement, '需求：用户登录功能');
  assert.equal(r.tasks.length, 2);
  assert.equal(r.tasks[0].depends_on.length, 0);
  assert.deepEqual(r.tasks[1].depends_on, ['T-001']);
  // 验收要点应作为 acceptance 而非独立任务
  const allAcceptance = r.tasks.reduce(function (s, t) { return s + t.acceptance.length; }, 0);
  assert.equal(allAcceptance, 2);
});
