# AI 协作工作流

本文说明 Vibe Task Panel 如何与你的 AI 编码 agent（Claude Code / OpenCode / Cursor 等）配合使用。AI 通过 HTTP API 或直接读写 tasks/ 目录的 JSON 文件与面板交互。

## 标准流程

### 1. 拆解（人触发）

    node src/cli/decompose.mjs docs/需求.md        # 启发式拆解
    node src/cli/decompose.mjs docs/需求.md --llm  # LLM 拆解（需配置 ollama 或 OPENAI_API_KEY）

生成任务 + 依赖，写入 tasks/，随后打开面板即可看到。

### 2. 领取任务（AI 开始前）

把任务状态改为「进行中」：

    POST /api/tasks/T-001/transition  body: { "to": "in_progress" }

### 3. 影响分析（改动前，AI 必做）

改动任务 A 之前，先查它会影响的其它任务：

    GET /api/impact/T-001

返回 downstream（下游传递闭包）、upstream（上游）、sharedFiles（共享文件）、affected（并集）。据此决定实现方式，规避破坏下游。

### 4. 干活并写回上下文（AI 完成后）

向任务的 sessions 字段追加「会话摘要 + 决策」，向 changes 字段追加「改动记录」：

    PATCH /api/tasks/T-001
    body: {
      "sessions": [ { "at": "时间", "role": "assistant", "summary": "做了什么", "decision": "为什么这么做" } ],
      "changes": [ { "commit": "abc1234", "file_paths": ["src/xx.ts"], "diff_summary": "改了什么", "rationale": "为什么改" } ]
    }

注意 PATCH 是整字段覆盖，追加时应先读旧值再拼接。

### 5. 进入审查（code review 门禁）

    POST /api/tasks/T-001/transition   body: { "to": "in_review" }
    POST /api/tasks/T-001/review       body: { "action": "run_checks" }

进入「待审查」时会自动执行项目级 lint / typecheck / test 并把结果回填到 review.check_results（lint/typecheck/test 任一失败都无法批准通过）。

run_checks 返回自动检查（验收标准/文件/依赖 + lint/typecheck/test）、文件检查、AI 审查意见、影响报告。

### 6. 通过后完成

    POST /api/tasks/T-001/review   body: { "action": "approve", "reviewer": "human" }
    POST /api/tasks/T-001/transition  body: { "to": "done" }

注意：未通过 review 的任务无法流转到「已完成」，状态机与 review 门禁会自动拦截。

## 回顾

任意时刻打开面板点击任务，即可看到三段完整记忆：

- sessions：当时的对话摘要与关键决策
- changes：改了哪些文件、为什么改
- review：自动检查结果与审查结论

### 7. AI 执行任务并回填（可选，P2）

不想手写 sessions/changes 时，让 AI 自动执行并回填：

    POST /api/tasks/T-001/execute

返回执行摘要/决策/改动摘要/后续步骤，并自动写入该任务的 sessions + changes（多供应商自动切换）。

### 8. 协作：评论与 @ 提醒

    POST /api/tasks/T-001/comments   body: { "author": "张三", "content": "请 @李四 协助检查" }

- @用户名 会提醒「负责人为该用户名的任务」
- 任务负责人字段为 assignee（PATCH /api/tasks/<id> { "assignee": "李四" }）

## 下游提醒（P2）

上游任务的状态 / 依赖 / 关联文件发生变化时，会自动给所有下游任务追加一条 notices（面板 🔔 铃铛可见）。

## 依赖影响约定

任务用 depends_on 表达「本任务依赖谁」。依赖图中箭头 A -> B 表示「A 影响 B」（B 依赖 A）。

- 改 A 前先 GET /api/impact/A，看清会波及谁；返回含 affectedRanked（风险排序）与 regression（回归测试建议）
- 依赖成环会被 GET /api/validate 与写入时校验拦截（POST/PATCH 直接拒绝）
- 影响面 = 显式依赖的传递闭包 并集 共享文件相关任务
