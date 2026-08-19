---
description: 打开 Vibe Task Panel 任务管理面板
---

启动任务面板服务并打开。执行下面命令（后台启动服务，输出访问地址）：

!`(node src/cli/task-panel.mjs > /tmp/vibe-task-panel.log 2>&1 &) && sleep 1.5 && cat /tmp/vibe-task-panel.log`

把上面的地址（默认 http://127.0.0.1:4317）告诉用户，让用户在浏览器打开。
如果服务已在运行（端口被占用），直接告诉用户现有地址即可。
