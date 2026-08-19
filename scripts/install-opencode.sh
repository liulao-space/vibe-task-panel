#!/usr/bin/env bash
# 全局安装 vibe-task-panel 的 opencode skill + 命令
# 让任意项目里的 opencode agent 都能用 /task-panel、/decompose 和 task-panel skill
# 用法：bash scripts/install-opencode.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$DEST"
if [ -d "$ROOT/.opencode/skills" ]; then cp -R "$ROOT/.opencode/skills/." "$DEST/skills/"; fi
if [ -d "$ROOT/.opencode/command" ]; then cp -R "$ROOT/.opencode/command/." "$DEST/command/"; fi
echo "已安装到 $DEST"
echo "在任意目录运行 opencode，输入 /task-panel 或 /decompose 即可使用"
