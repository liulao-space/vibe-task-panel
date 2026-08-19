# Vibe Task Panel

面向 Vibe Coding / AI 结对开发的 Agent 任务管理面板。把 AI 开发中的「需求 → 任务 → 改动 → 回顾 → 审查」沉淀成结构化数据与可视化面板。

## 核心能力

- 需求拆解：丢一份需求文档，自动拆成最小任务单元 + 依赖建议
- 任务管理：按需求分类（可建/改/删需求）、状态机流转、看板 / 列表 / 依赖图三种视图
- 多维度筛选：按需求 / 状态 / 依赖 / 文件 / 搜索（标题、描述、验收、改动内容）
- 依赖影响分析：改动任务 A，自动找出受影响的下游任务 B、C 及共享文件，风险排序 + 回归测试建议
- 上下文回顾 + 回看模式：每个任务记录会话摘要、改动记录、关键决策，按时间轴还原
- Code Review：每个任务必经「自动 lint/typecheck/test + AI 审查 + 人工确认」门禁才能完成
- AI 执行：调用 AI（多供应商自动切换）执行任务并回填会话/改动记录
- 协作：任务指派、评论、@ 提醒；上游任务变更自动提醒下游
- 写入时成环校验：依赖成环写入被直接拒绝

## 快速开始

环境要求：Node.js >= 18（零外部依赖，无需 npm install）

    # 1. 把需求文档放进 docs/（已内置示例 docs/需求.md）
    # 2. 拆解需求 -> 生成任务
    node src/cli/decompose.mjs docs/需求.md

    # 3. 启动并打开任务面板（浏览器访问 http://127.0.0.1:4317）
    node src/cli/task-panel.mjs

    # 或通过统一入口
    node src/cli/cli.mjs decompose docs/需求.md
    node src/cli/cli.mjs task-panel
    node src/cli/cli.mjs server

端口默认 4317，可用环境变量 VTP_PORT 覆盖；项目根可用 VTP_ROOT 覆盖（默认当前目录）。

## 目录结构

    vibe-task-panel/
    ├── src/
    │   ├── core/          核心逻辑（无依赖，纯函数）
    │   │   ├── store.mjs      任务读写 / 索引 / 需求分组 / 下游提醒
    │   │   ├── status.mjs     状态机（含 review 门禁约束）
    │   │   ├── deps.mjs       依赖校验 / 成环检测 / 拓扑排序
    │   │   ├── impact.mjs     影响分析（传递闭包 + 共享文件 + 风险排序）
    │   │   ├── review.mjs     code review 门禁（lint/typecheck/test + AI 审查）
    │   │   ├── execute.mjs    AI 执行任务并回填（多供应商）
    │   │   └── decompose.mjs  需求文档 -> 任务（启发式，可插拔 LLM）
    │   ├── cli/           命令入口（decompose / task-panel / server）
    │   ├── server/        HTTP API + 静态文件服务
    │   └── mcp/           MCP server（opencode AI 直连）
    ├── web/index.html     前端面板（单文件，零依赖，SVG 依赖图）
    ├── test/              单元测试（node:test）
    ├── specs/task-schema.json   任务数据契约
    ├── .vibe-task-panel/  运行时数据（tasks/ 任务 + index.json + requirements.json）
    └── docs/              需求文档（拆解输入）

## 数据存储

任务数据存于 .vibe-task-panel/tasks/ 目录：每个任务一个 <id>.json 文件（权威数据），index.json 为聚合索引，requirements.json 为需求清单。数据随代码进 Git，天然可追溯、可回看。

任务字段：id / requirement / title / description / acceptance / status / blocked_reason / depends_on / files / sessions / changes / assignee / comments / notices / review

状态机：待办 -> 进行中 -> 待审查 -> 已完成，另支持「阻塞」。已完成前必须通过 code review；进入「待审查」自动跑 lint/typecheck/test 并回填 check_results；依赖成环写入被直接拒绝（写入时校验）。

## HTTP API

    GET  /api/tasks              任务列表
    POST /api/tasks              创建任务
    GET  /api/tasks/:id          单任务
    PATCH /api/tasks/:id         更新任务字段（依赖成环会被拒绝）
    DELETE /api/tasks/:id        删除任务
    POST /api/tasks/:id/transition   状态流转 { to, reason? }（to=in_review 自动跑检查）
    POST /api/tasks/:id/review       review { action: run_checks|approve|reject|force_approve }
    POST /api/tasks/:id/comments     添加评论 { author?, content }（@用户名 提醒该负责人）
    POST /api/tasks/:id/execute      AI 执行任务并回填会话/改动记录
    GET  /api/tasks/:id/changes/:idx/diff   反查该条改动的完整 diff（含 commit diff）
    GET  /api/impact/:id         影响分析（含 risk 风险排序 + regression 回归建议）
    GET  /api/deps               依赖图数据（nodes/edges/layers）
    GET  /api/validate           依赖校验（成环检测）
    GET  /api/index              需求分组索引
    GET/POST/PATCH/DELETE /api/requirements   需求管理（创建/编辑/删除/重命名）
    POST /api/decompose          拆解 { docPath | text }

## 测试

    node --test

## 里程碑状态

M1 骨架 / M2 数据层 / M3 拆解 / M4 面板 / M5 影响分析 / M6 Review —— 全部完成。

## 在 opencode 中使用

本项目已内置 opencode 集成（.opencode/ 目录）：

- 命令 /task-panel —— 打开任务面板
- 命令 /decompose <文档路径> —— 拆解需求文档为任务
- skill task-panel —— 让 agent 自动识别「打开面板 / 查看任务 / 拆解需求 / 影响分析 / code review」等意图

使用步骤：

    cd vibe-task-panel
    opencode
    # 在 opencode 里输入 /task-panel 打开面板
    # 或输入 /decompose docs/需求.md 拆解需求
    # 或直接说「打开任务面板」，agent 会自动加载 skill

全局使用（让任何项目都能用）：把 .opencode/ 下的内容复制到 ~/.config/opencode/。

    mkdir -p ~/.config/opencode
    cp -r .opencode/skills ~/.config/opencode/
    cp -r .opencode/command ~/.config/opencode/

## 安装与发布

### 方式一：源码（GitHub）

    git clone <你的仓库地址> vibe-task-panel
    cd vibe-task-panel
    node src/cli/task-panel.mjs        # 打开面板（零依赖，只需 Node >= 18）

### 方式二：npm 全局安装

    npm i -g vibe-task-panel
    vibe-task-panel server             # 仅启动服务，浏览器访问 http://127.0.0.1:4317
    vibe-task-panel decompose docs/需求.md   # 拆解需求

- 面板静态资源随包分发（按工具安装目录解析，全局安装同样可用）
- 任务数据默认读写当前目录的 .vibe-task-panel/，用 VTP_ROOT 环境变量可指向任意项目
- 端口默认 4317，VTP_PORT 可覆盖

### 方式三：让 opencode agent 全局可用

一键把 skill + 命令装到 opencode 全局配置，任意项目里 agent 都能用：

    bash scripts/install-opencode.sh   # 等价于手动复制到 ~/.config/opencode/

安装后在任意目录运行 opencode，输入 /task-panel 或 /decompose，或直接说「打开任务面板」。

### 方式四：MCP server 接入（让 AI 直接操作面板）

本仓库自带 stdio MCP server（src/mcp/server.mjs），暴露 14 个 vtp_* 工具：
vtp_list_tasks / vtp_transition / vtp_update_task / vtp_batch_start / vtp_batch_advance /
vtp_batch_complete / vtp_batch_review / vtp_add_session / vtp_sync_changes / vtp_impact /
vtp_review_checks / vtp_review_approve / vtp_execute_task / vtp_add_comment。

在支持 MCP 的客户端（Claude Desktop / Cursor / 支持 MCP 的编辑器等）中注册：

    {
      "mcpServers": {
        "vibe-task-panel": {
          "command": "node",
          "args": ["<vibe-task-panel 绝对路径>/src/mcp/server.mjs"]
        }
      }
    }

注意：

1. MCP server 会在当前工作目录向上查找 git 根作为任务仓库根，启动时请把工作目录设为你要管理的项目；
2. 需要 AI 审查 / AI 执行时，在项目根放 .env（参照 .env.example 填入 DEEPSEEK_API_KEY 或其它供应商 key）；
3. opencode 等客户端的具体 mcp 配置字段见各自官方文档。
