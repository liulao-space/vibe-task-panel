---
name: task-panel
description: 打开或操作 Vibe Task Panel 任务管理面板。当用户说「打开任务面板」「查看任务」「拆解需求」「看依赖关系」「做影响分析」「code review」时使用。可执行 node src/cli/task-panel.mjs 打开面板、node src/cli/decompose.mjs <文档> 拆解需求、node --test 跑测试。
compatibility: opencode
metadata:
  project: vibe-task-panel
---

# Vibe Task Panel 任务面板

这是面向 Vibe Coding 的任务管理面板。本 skill 教你在何时、如何操作它。

## 何时使用

- 用户说「打开任务面板」「查看任务」「看任务」「task panel」→ 打开面板
- 用户给了一份需求文档想拆解 → 运行 decompose 命令
- 用户想查看任务依赖关系或做影响分析 → 打开面板后看「依赖图」或点任务详情「影响分析」
- 用户要做 code review → 打开面板，点任务详情里的「运行检查 / 通过 / 打回」

## 操作方式

项目根为 vibe-task-panel（默认端口 4317，可用 VTP_PORT 覆盖）。

打开面板（后台启动 + 打开浏览器）：

    node src/cli/task-panel.mjs

拆解需求文档（把 docs/ 下的需求文档拆成任务，写入 tasks/）：

    node src/cli/decompose.mjs docs/需求.md
    node src/cli/decompose.mjs docs/需求.md --llm   # LLM 智能拆解

只启动服务（不自动开浏览器）：

    node src/cli/cli.mjs server

运行测试：

    node --test

回填任务附件（扫描 description 中的图片名自动登记 attachments，缺图文案置 ui_status=pending；默认 dry run）：

    node scripts/backfill-attachments.mjs [项目根] [--apply]

## 面板能力

- 看板 / 列表 / 依赖图三种视图
- 多维度筛选：按需求 / 状态 / 依赖 / 文件 / 搜索
- 任务状态机：待办 -> 进行中 -> 待审查 -> 已完成，支持阻塞；依赖成环写入被拒绝
- 影响分析：改动某任务，自动列出受影响下游任务与共享文件，含风险排序 + 回归测试建议
- 回看模式：按时间轴还原任务的会话摘要、改动记录、审查结论
- Code Review：进入待审查自动跑 lint/typecheck/test，每任务必经自动检查 + AI 审查 + 人工确认，未通过无法「已完成」
- AI 执行：调用 AI（多供应商自动切换）执行任务并回填会话/改动记录
- 协作：任务指派、评论、@ 提醒；上游任务变更自动提醒下游
- UI 图/附件：任务可挂 attachments（仓库相对路径图片或面板上传），详情渲染缩略图墙 + 点击放大；描述内支持 ![说明](项目根相对路径) 图片语法；ui_status=pending 时卡片挂「⚠️ 缺UI图」徽标
- MCP：opencode 内可用 vtp_* 工具直接操作（含 vtp_create_task 创建任务落盘）

## 数据

任务数据存于 .vibe-task-panel/tasks/ 目录（每个任务一个 JSON 文件 + index.json 索引 + requirements.json 需求清单），随代码进 Git。
任务字段：id、requirement、title、acceptance、status、depends_on、files、attachments（UI图/附件 [{path,label,kind}]）、ui_status（ready/pending，pending=缺UI图）、sessions（会话上下文）、changes（改动记录）、assignee（负责人）、comments（评论）、notices（下游提醒）、review（审查门禁）。
图片访问路由：GET /files/<项目根相对路径>（仅 png/jpg/jpeg/webp/gif/svg，沙箱限制在项目根内）。

## 与面板协作的约定

AI 编码时：
1. 领取任务：把任务状态改为 in_progress
2. 改动前先做影响分析（GET /api/impact/<id>），看清会波及谁
3. 完成后向任务的 sessions 追加「摘要+决策」，向 changes 追加「commit+diff+理由」（也可用 POST /api/tasks/<id>/execute 让 AI 自动回填）
4. 进入待审查，跑 code review（进入时自动跑 lint/typecheck/test），通过后才能标记「已完成」
5. 上游任务变更会自动给下游任务写 notices，注意查看被影响的任务
