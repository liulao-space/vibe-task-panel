<p align="center">
  <img src="web/logo-mark.svg" width="72" height="72" alt="Vibe Task Panel">
</p>

<h1 align="center">Vibe Task Panel</h1>
<p align="center">
  <strong>面向 Vibe Coding / AI 结对开发的 Agent 任务管理面板</strong>
  <br>
  零依赖 · 文件存储 · 可追溯 · 可接入 AI
</p>

<p align="center">
  <a href="#quick-start"><b>快速开始</b></a> ·
  <a href="#workflow"><b>工作流</b></a> ·
  <a href="#cli"><b>CLI</b></a> ·
  <a href="#api"><b>HTTP API</b></a> ·
  <a href="#mcp"><b>MCP</b></a> ·
  <a href="#opencode"><b>AI 集成</b></a> ·
  <a href="#install"><b>安装</b></a>
</p>

---

## 概述

Vibe Task Panel 把 AI 开发中的「需求 → 拆解 → 实现 → 审查 → 回顾」沉淀成**结构化数据与可视化面板**，解决 AI 结对开发中的四个痛点：

| 痛点 | 解决 |
|------|------|
| 需求散落在对话里，关掉就丢 | 需求文档 → 结构化任务，随代码进 Git |
| 事后无法回溯"为什么这么改" | 每个任务记录会话摘要、决策日志、改动 diff |
| 改 A 影响 B、C 却不可见 | 依赖图 + 影响分析（传递闭包 + 风险排序） |
| 缺乏统一质量门禁 | 每任务自动 lint/typecheck/test + AI 审查 + 人工确认 |

---

## <a id="quick-start"></a>快速开始

环境要求：**Node.js >= 18**（零外部依赖，无需 npm install）

```bash
# 1. 克隆或下载本项目
git clone https://github.com/liulao-space/vibe-task-panel.git
cd vibe-task-panel

# 2. 拆解需求文档为任务（已内置示例 docs/需求.md）
node src/cli/decompose.mjs docs/需求.md

# 3. 启动任务面板，浏览器打开 http://127.0.0.1:4317
node src/cli/task-panel.mjs
```

> 端口默认 4317，用 `VTP_PORT=8080 node src/cli/task-panel.mjs` 可覆盖。
> 项目根（.vibe-task-panel 所在目录）默认当前目录，用 `VTP_ROOT` 可指向任意项目。

### 第一次使用指南

1. 把需求文档（Markdown 格式）放进 `docs/` 目录
2. 跑 `node src/cli/decompose.mjs docs/你的需求.md` 拆解为任务
3. 打开任务面板，查看自动生成的看板、依赖图
4. 点击任务卡片开始执行，修改代码后通过面板更新状态
5. 任务完成后流转到「待审查」，自动触发 AI 代码审查
6. 审查通过，任务自动标记「已完成」

---

## <a id="workflow"></a>工作流

### 状态机

```
待办 (todo) → 进行中 (in_progress) → 待审查 (in_review) → 已完成 (done)
                ↕                       ↕
             阻塞 (blocked)          打回 (reject)
```

- **待办 → 进行中**：认领任务，开始实现
- **进行中 → 待审查**：任务完成，提交审查（自动跑自动检查 + AI 审查）
- **待审查 → 已完成**：审查通过（人工或 force_approve）
- **任意状态 → 阻塞**：遇到阻碍，记录原因
- **依赖成环**：写入时直接被拒绝，保证 DAG 完整性

### 完整开发流程

```
需求文档 → decompose 拆解 → 任务列表 → 看板 / 依赖图 / 影响分析
                                          ↓
                              AI 执行 / 手动实现 → 代码改动
                                          ↓
                               Code Review（自动检查 + AI 审查 + 人工确认）
                                          ↓
                                       已完成
```

---

## <a id="cli"></a>CLI 命令

| 命令 | 功能 | 示例 |
|------|------|------|
| `vibe-task-panel` / `cli.mjs` | 统一入口 | `node src/cli/cli.mjs server` |
| `decompose <doc>` | 拆解需求文档为任务 | `node src/cli/decompose.mjs docs/需求.md` |
| `task-panel [port]` | 启动面板 + 打开浏览器 | `node src/cli/task-panel.mjs` |
| `server [port]` | 仅启动服务，不开浏览器 | `node src/cli/cli.mjs server` |

```bash
# 统一入口
node src/cli/cli.mjs decompose docs/需求.md    # 拆解
node src/cli/cli.mjs task-panel                  # 面板
node src/cli/cli.mjs server                      # 仅服务

# 拆解支持 --llm 参数使用 AI 智能拆解
node src/cli/decompose.mjs docs/需求.md --llm
```

---

## <a id="api"></a>HTTP API

服务启动后（默认 `http://127.0.0.1:4317`），提供以下 REST API：

### 任务管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/tasks` | 任务列表（支持 `?status=in_progress` 筛选） |
| `POST` | `/api/tasks` | 创建任务 |
| `GET` | `/api/tasks/:id` | 单任务详情 |
| `PATCH` | `/api/tasks/:id` | 更新任务字段（依赖成环会被拒绝） |
| `DELETE` | `/api/tasks/:id` | 删除任务 |

### 状态流转

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tasks/:id/transition` | 状态流转 `{ to, reason? }` |
| `POST` | `/api/tasks/:id/review` | 审查操作 `{ action: run_checks|approve|reject|force_approve }` |
| `POST` | `/api/tasks/:id/execute` | AI 执行任务并回填会话/改动记录 |

### 协作

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tasks/:id/comments` | 添加评论 `{ author?, content }`（`@用户名` 提醒该负责人） |

### 分析

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/impact/:id` | 影响分析（风险排序 + 回归建议） |
| `GET` | `/api/deps` | 依赖图数据（nodes/edges/layers） |
| `GET` | `/api/validate` | 依赖校验（成环检测） |
| `GET` | `/api/tasks/:id/changes/:idx/diff` | 反查改动的完整 diff |

### 需求管理

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/requirements` | 需求列表 |
| `POST` | `/api/requirements` | 创建需求 |
| `PATCH` | `/api/requirements/:name` | 编辑需求 |
| `DELETE` | `/api/requirements/:name` | 删除需求 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/index` | 需求分组索引 |
| `POST` | `/api/decompose` | 拆解 `{ docPath | text }` |
| `GET` | `/files/<项目根相对路径>` | 访问任务附件图片（仅 png/jpg/jpeg/webp/gif/svg；沙箱限制在项目根内，拒绝路径穿越） |

### UI 图 / 附件（schema v2）

任务新增两个字段：

- `attachments`: `[{ path, label?, kind? }]` —— `path` 为**项目根相对路径**（随 git 走），`kind` 取 `ui | doc | template | note`
- `ui_status`: `ready | pending | null` —— `pending` 表示缺 UI 图，看板卡片挂「⚠️ 缺UI图」徽标

面板交互：任务详情「UI 图 / 附件」区块渲染缩略图墙（点击放大，hover 缩略图出现 × 删除——统一走自定义确认弹窗，仅移除登记、不删仓库文件）；支持「登记仓库图片」与「上传图片」（上传存 `.vibe-task-panel/notes/` 并自动登记）；任务描述支持 `![说明](项目根相对路径)` 内嵌图片语法。

存量任务回填：

    node scripts/backfill-attachments.mjs <项目根> [--apply]

（扫描任务 description 中提到的图片文件名自动登记 attachments；命中「无 UI 图/待补充」文案置 `ui_status=pending`；默认 dry run）

---

## <a id="mcp"></a>MCP Server（AI 直接操作面板）

本仓库自带 stdio MCP Server，暴露 15 个 `vtp_*` 工具，让支持 MCP 的 AI 客户端（Claude Desktop、Cursor、opencode 等）**直接读取和操作任务面板**。

### 注册配置

```json
{
  "mcpServers": {
    "vibe-task-panel": {
      "command": "node",
      "args": ["<绝对路径>/src/mcp/server.mjs"]
    }
  }
}
```

> ⚠️ MCP Server 会在当前工作目录向上查找 git 根作为任务仓库，启动时请把工作目录设为你要管理的项目。

### 工具列表

| 工具 | 说明 |
|------|------|
| `vtp_list_tasks` | 列出当前项目当前分支的任务，可筛选状态 |
| `vtp_create_task` | 创建任务（单个 task 或 tasks 批量），自动绑定当前分支；支持 attachments/ui_status |
| `vtp_transition` | 流转任务状态（todo/in_progress/in_review/done/blocked） |
| `vtp_update_task` | 更新任务字段（files/attachments/ui_status/sessions/changes/acceptance 等） |
| `vtp_batch_start` | 批量认领任务（按顺序自动标记 in_progress） |
| `vtp_batch_advance` | 完成当前任务，推进到下一个 |
| `vtp_batch_complete` | 标记一批任务完成 |
| `vtp_batch_review` | 批量流转到待审查 |
| `vtp_add_session` | 添加会话记录（summary + decision） |
| `vtp_sync_changes` | 自动收集未提交 git 改动写入任务 |
| `vtp_impact` | 查看改动某任务会影响哪些下游任务 |
| `vtp_review_checks` | AI 代码审查（基于实际代码，返回质量问题/学习点） |
| `vtp_review_approve` | 审查通过任务（自动流转到已完成） |
| `vtp_execute_task` | AI 执行任务并回填 sessions + changes |
| `vtp_add_comment` | 添加评论（@用户名 提醒负责人） |

### 配置 AI 供应商

需要 AI 审查 / AI 执行时，在项目根放 `.env` 文件：

```bash
# 推荐：DeepSeek 云 API
VTP_LLM=deepseek
DEEPSEEK_API_KEY=sk-你的key

# 或 OpenAI 兼容 API
# VTP_LLM=openai
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_API_KEY=sk-xxx
# OPENAI_MODEL=gpt-4o-mini

# 或本地 Ollama
# VTP_LLM=ollama
# OLLAMA_HOST=http://localhost:11434
# OLLAMA_MODEL=模型名称
```

参照 `.env.example` 文件配置。

---

## <a id="opencode"></a>AI 集成（opencode）

本项目已内置 [opencode](https://opencode.ai) 集成（`.opencode/` 目录），让 AI agent 能自动识别并操作任务面板。

### 内置命令和 Skill

| 方式 | 触发方式 | 说明 |
|------|---------|------|
| `/task-panel` | 在 opencode 输入 | 自动启动面板服务并打开浏览器 |
| `/decompose <文档路径>` | 在 opencode 输入 | 拆解需求文档为任务 |
| Skill `task-panel` | agent 自动加载 | 当用户说「打开面板」「查看任务」「拆解需求」「影响分析」「code review」时自动触发 |

### 使用方式

```bash
# 在项目目录里
cd vibe-task-panel
opencode

# 然后输入：
/task-panel         # 打开面板
/decompose 文档.md  # 拆解需求
# 或直接说中文：
"打开任务面板"
"查看任务依赖关系"
"帮我做 code review"
```

### 全局安装（让任意项目都能用）

```bash
# 方式一：一键安装脚本
bash scripts/install-opencode.sh

# 方式二：手动复制
mkdir -p ~/.config/opencode
cp -r .opencode/skills ~/.config/opencode/
cp -r .opencode/command ~/.config/opencode/
```

安装后，在任意目录运行 opencode，`/task-panel` 和 `/decompose` 命令都可用。

---

## <a id="install"></a>安装方式

### 方式一：源码（GitHub）

```bash
git clone https://github.com/liulao-space/vibe-task-panel.git
cd vibe-task-panel
node src/cli/task-panel.mjs    # 零依赖，直接运行
```

### 方式二：npm 全局安装

```bash
npm install -g vibe-task-panel
# 或 npx
npx vibe-task-panel server

# 全局命令
vibe-task-panel server              # 启动服务
vibe-task-panel decompose docs/需求.md  # 拆解需求
decompose docs/需求.md               # 或直接 decompose 命令
task-panel                          # 或直接 task-panel 命令
```

- 面板静态资源随包分发，全局安装同样可用
- 任务数据默认读写当前目录的 `.vibe-task-panel/`，用 `VTP_ROOT` 可指向任意项目

---

## 数据存储

任务数据存于 `.vibe-task-panel/` 目录，采用**纯文件存储**（随代码进 Git，天然可追溯、可回看）。

```
.vibe-task-panel/
├── tasks/
│   ├── T-001.json       # 每个任务一个文件（权威数据）
│   ├── T-002.json
│   └── ...
├── index.json            # 聚合索引
└── requirements.json     # 需求清单
```

### 任务字段

| 字段 | 说明 |
|------|------|
| `id` | 任务 ID（如 T-001） |
| `requirement` | 所属需求 |
| `title` | 任务标题 |
| `description` | 任务描述 |
| `acceptance` | 验收标准 |
| `status` | todo / in_progress / in_review / done / blocked |
| `blocked_reason` | 阻塞原因 |
| `depends_on` | 依赖的任务 ID 列表 |
| `files` | 关联文件列表 |
| `sessions` | 会话上下文（摘要、决策、时间戳） |
| `changes` | 改动记录（diff、commit、说明） |
| `assignee` | 负责人 |
| `comments` | 评论 |
| `notices` | 下游提醒 |
| `review` | 审查结果（自动检查、AI 审查、人工确认） |

---

## 目录结构

```
vibe-task-panel/
├── src/
│   ├── core/             核心逻辑（零依赖，纯函数）
│   │   ├── store.mjs         任务读写 / 索引 / 需求分组 / 下游提醒
│   │   ├── status.mjs        状态机（含 review 门禁约束）
│   │   ├── deps.mjs          依赖校验 / 成环检测 / 拓扑排序
│   │   ├── impact.mjs        影响分析（传递闭包 + 共享文件 + 风险排序）
│   │   ├── review.mjs        Code Review 门禁（lint/typecheck/test + AI 审查）
│   │   ├── execute.mjs       AI 执行任务并回填（多供应商）
│   │   └── decompose.mjs     需求文档 → 任务（启发式，可插拔 LLM）
│   ├── cli/              命令入口
│   │   ├── cli.mjs           统一入口
│   │   ├── decompose.mjs     拆解命令
│   │   └── task-panel.mjs    面板命令
│   ├── server/           HTTP API + 静态文件服务
│   └── mcp/              MCP Server（AI 直连）
├── web/
│   └── index.html         前端面板（单文件，零依赖，SVG 依赖图）
├── test/                 单元测试（node:test）
├── specs/
│   └── task-schema.json    任务数据契约
├── .opencode/            opencode agent 集成（skill + 命令）
└── docs/                 需求文档（拆解输入）
```

---

## 测试

```bash
node --test
```

所有测试用例位于 `test/` 目录，使用 Node.js 内置 `node:test` 框架，无需额外依赖。当前 44 个测试全部通过。

---

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `VTP_PORT` | `4317` | HTTP 服务端口 |
| `VTP_ROOT` | `process.cwd()` | 项目根目录（.vibe-task-panel 所在目录） |
| `VTP_LLM` | — | AI 供应商：deepseek / openai / ollama |
| `DEEPSEEK_API_KEY` | — | DeepSeek API Key |
| `OPENAI_API_KEY` | — | OpenAI 兼容 API Key |
| `OPENAI_BASE_URL` | — | OpenAI 兼容 API 地址 |
| `OLLAMA_HOST` | — | Ollama 地址（默认 http://localhost:11434） |

---

## 技术栈

- **运行时**：Node.js >= 18（零外部依赖）
- **存储**：文件系统（JSON 文件，随代码进 Git）
- **前端**：单文件 HTML/CSS/JS（无框架，SVG 依赖图）
- **测试**：Node.js `node:test` 内置测试框架
- **AI 接入**：多供应商（DeepSeek / OpenAI / Ollama），自动切换

---

## 里程碑

| 阶段 | 状态 |
|------|------|
| M1 骨架 | ✅ 完成 |
| M2 数据层（store/status/deps） | ✅ 完成 |
| M3 拆解（decompose） | ✅ 完成 |
| M4 面板（web UI + server） | ✅ 完成 |
| M5 影响分析（impact） | ✅ 完成 |
| M6 Code Review（review/execute） | ✅ 完成 |
| M7 MCP Server | ✅ 完成 |
| M8 opencode 集成 | ✅ 完成 |

---

## 许可证

MIT License — 详见 [LICENSE](LICENSE) 文件。