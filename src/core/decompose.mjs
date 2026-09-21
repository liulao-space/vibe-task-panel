import { createTask, listTaskIds } from './store.mjs';

const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);

export function normalizeLines(text) {
  return text.split(CR).join('').split(NL);
}

export function extractRequirementName(lines) {
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('# ')) return t.slice(2).trim();
  }
  return '未命名需求';
}

export function extractBullets(lines) {
  const bullets = [];
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('## ') || line.startsWith('### ')) {
      section = line.replace(/#/g, '').trim();
      continue;
    }
    let content = null;
    if (line.startsWith('- ')) content = line.slice(2).trim();
    else if (line.startsWith('* ')) content = line.slice(2).trim();
    else if (/^[0-9]+[.] /.test(line)) content = line.replace(/^[0-9]+[.] /, '').trim();
    if (content) bullets.push({ section, title: content });
  }
  return bullets;
}

// 启发式拆解：每个 bullet 生成一个任务，顺序依赖（后面的依赖前面的）。
export function isAcceptanceSection(section) {
  return !!section && (section.indexOf('验收') >= 0 || section.indexOf('标准') >= 0);
}

// 启发式过滤：跳过明显非任务的说明性内容（UI 图/权限/背景/术语等）
export function isNonTaskContent(content, section) {
  const c = content || '';
  const s = section || '';
  const skipSections = ['背景', '术语', '说明', '概述', '约定', '纪律', '原则', '参考', '附录', '简介', '角色', '权限', '职责', '全局', '范围'];
  for (const kw of skipSections) {
    if (s.indexOf(kw) >= 0) return true;
  }
  const skipContents = ['![', 'http', '图片', '原型', '截图', '示意图', '附件', '占位', 'UI 链接', 'ui 链接', 'ui链接'];
  for (const kw of skipContents) {
    if (c.indexOf(kw) >= 0) return true;
  }
  return false;
}

const MATCH_KEYWORDS = ['注册', '登录', '密码', 'bcrypt', '哈希', '失败', '锁定', '退出', '会话', '验证', '支付', '上传', '通知', '权限'];

function bestMatchIndex(tasks, acceptanceText) {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < tasks.length; i++) {
    let score = 0;
    for (const kw of MATCH_KEYWORDS) {
      if (acceptanceText.indexOf(kw) >= 0 && tasks[i].title.indexOf(kw) >= 0) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best >= 0 ? best : tasks.length - 1;
}

export function decomposeDoc(text) {
  const lines = normalizeLines(text);
  const requirement = extractRequirementName(lines);
  const bullets = extractBullets(lines);

  // 需求描述 -> 任务；验收要点 -> acceptance
  const taskBullets = [];
  const acceptance = [];
  for (const b of bullets) {
    if (isNonTaskContent(b.title, b.section)) continue;
    if (isAcceptanceSection(b.section)) acceptance.push(b.title);
    else taskBullets.push(b);
  }
  if (taskBullets.length === 0) {
    // 没有需求描述章节时，退回把所有 bullet 都当任务
    for (const b of bullets) taskBullets.push(b);
  }

  const tasks = taskBullets.map((b, i) => ({
    id: 'T-' + String(i + 1).padStart(3, '0'),
    requirement,
    title: b.title,
    description: b.section ? ('来自文档章节: ' + b.section) : '',
    acceptance: [],
    status: 'todo',
    depends_on: i === 0 ? [] : ['T-' + String(i).padStart(3, '0')],
    files: []
  }));

  // 验收要点按关键词匹配分配到对应任务
  for (const a of acceptance) {
    const idx = bestMatchIndex(tasks, a);
    tasks[idx].acceptance.push(a);
  }

  return { requirement, tasks };
}

// 追加模式下避免与已有任务 id 冲突：LLM/启发式拆解给出的 T-001… 若已存在则重新编号，并同步改写 depends_on
// 返回 { tasks(已重编号), idMap(旧id->新id) }
export async function remapTaskIds(root, tasks) {
  const existing = new Set(await listTaskIds(root));
  let max = 0;
  for (const id of existing) {
    const m = /^T-([0-9]+)$/.exec(id);
    if (m && Number(m[1]) > max) max = Number(m[1]);
  }
  const idMap = {};
  const out = tasks.map(function (t) {
    let newId = t.id;
    if (!newId || existing.has(newId)) {
      newId = 'T-' + String(++max).padStart(3, '0');
    } else {
      const m = /^T-([0-9]+)$/.exec(newId);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    }
    existing.add(newId);
    if (t.id && t.id !== newId) idMap[t.id] = newId;
    return Object.assign({}, t, { id: newId });
  });
  // 依赖改写要在全部 id 分配完成后进行（避免先处理的任务引用后处理任务的旧 id）
  for (const t of out) {
    t.depends_on = (t.depends_on || []).map(function (d) { return idMap[d] || d; });
  }
  return { tasks: out, idMap };
}

export async function decomposeToStore(root, text, branch, assignee) {
  const parsed = decomposeDoc(text);
  const remapped = await remapTaskIds(root, parsed.tasks);
  const created = [];
  for (const t of remapped.tasks) {
    created.push(await createTask(root, Object.assign({}, t, { branch: branch || 'default', assignee: assignee || t.assignee || null })));
  }
  return { requirement: parsed.requirement, tasks: created };
}

export function buildDecomposePrompt(text) {
  const lines = [
    '你是资深技术负责人，请把下面的需求文档拆解为可独立执行、可独立 review 的开发任务。',
    '拆解粒度要求：',
    '1. 一个任务 = 一个可独立完成、可验收的功能点（如「上传弹窗」「版本状态机」「课程清单列表」），不是一整句话，也不是整个大模块',
    '2. 先识别文档的模块结构：按一级/二级章节（如「方案版本」「方案详情」「体系图谱」）划分模块，模块名用章节标题提炼（去掉编号前缀）',
    '2.1 每个任务必须归属到它所在的模块，requirement 字段填模块名；文档无明显章节时用文档标题',
    '2.2 只保留真正的开发任务，以下内容一律跳过、不要拆成任务：',
    '   - UI 原型链接、设计稿引用、图片、截图、附件（如 .html 原型、js.design 链接）',
    '   - 角色与权限说明、背景描述、术语解释、全局约定、状态机定义表、枚举值说明',
    '   - 解析原理、提示词/Prompt、抽取纪律等文档性说明（这些是需求说明，不是开发任务）',
    '2.3 但图片引用不要丢弃：文档中出现的 UI 设计图（![说明](路径)、「见 image 8.png」、图片目录等）登记到所属任务的 attachments 数组，元素格式 {"path":"项目根相对路径","label":"简短说明","kind":"ui"}；模板/文档类附件 kind 用 "template"/"doc"',
    '2.4 文档明确标注「无 UI 图 / UI 待补充 / 开发时补图」的任务，设 ui_status="pending"；其余任务不要输出 ui_status 字段',
    '3. 每项字段：id(如 T-001)、requirement(所属模块名)、title(简短动宾短语)、description(一句话，可内嵌 ![说明](项目根相对路径) 引用关键 UI 图)、acceptance(验收标准数组)、depends_on(依赖的任务id数组，无则空数组)',
    '3.1 任务总数控制在 20~50 个（模块多可到 60），同一模块下 3~15 个任务为宜；不要过度细分，避免把一个功能拆成碎片任务',
    '4. depends_on 表示本任务依赖谁，保持无环；id 按依赖顺序 T-001、T-002 递增',
    '5. 只输出 JSON 数组，不要任何解释、不要 markdown 代码块',
    '',
    '需求文档：',
    text,
    '',
    '只输出 JSON 数组：'
  ];
  return lines.join(String.fromCharCode(10));
}

export function parseLLMTasks(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('LLM 输出不是 JSON 数组');
  }
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('LLM 输出不是数组');
  return arr;
}

export async function decomposeWithLLM(text, llmFn) {
  const raw = await llmFn(buildDecomposePrompt(text));
  const tasks = parseLLMTasks(raw);
  const KINDS = ['ui', 'doc', 'template', 'note'];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t.id) t.id = 'T-' + String(i + 1).padStart(3, '0');
    if (!t.title) t.title = t.id;
    if (!t.description) t.description = '';
    if (!t.acceptance) t.acceptance = [];
    if (!t.depends_on) t.depends_on = [];
    // attachments 归一化：仅保留 {path,label,kind}，path 必填（项目根相对路径）
    t.attachments = Array.isArray(t.attachments)
      ? t.attachments
          .filter((a) => a && typeof a.path === 'string' && a.path.trim())
          .map((a) => ({
            path: a.path.trim(),
            label: typeof a.label === 'string' ? a.label : '',
            kind: KINDS.indexOf(a.kind) >= 0 ? a.kind : 'ui'
          }))
      : [];
    // ui_status 归一化：仅接受 ready/pending，其余视为 null
    t.ui_status = (t.ui_status === 'ready' || t.ui_status === 'pending') ? t.ui_status : null;
  }
  return tasks;
}
