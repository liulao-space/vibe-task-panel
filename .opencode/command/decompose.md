---
description: 拆解需求文档为最小任务单元
---

把需求文档拆解为最小任务单元，写入 .vibe-task-panel/tasks/ 目录（随代码进 Git）。执行：

!`node src/cli/decompose.mjs $ARGUMENTS`

如果用户没有指定文档路径，使用默认的 docs/需求.md。
如需用 LLM 智能拆解，在命令后追加 --llm。
拆解完成后，简要总结生成了多少个任务及其依赖关系。
