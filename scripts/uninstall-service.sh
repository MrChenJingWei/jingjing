#!/usr/bin/env bash
# 卸载静静的 LaunchAgent。
set -euo pipefail

LABEL="${JINGJING_LABEL:-com.jingjing.server}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "已卸载 $LABEL。项目文件和数据库都没有动。"
echo "如果还想手动运行：cd \"$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)\" && npm start"
