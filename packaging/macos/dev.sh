#!/usr/bin/env bash
# 开发调试：用当前仓库的代码构建 App 并直接运行（不安装、不打包）。
# 默认用仓库里的 data/ 和 7787 端口，不碰已安装的静静（~/Library/Application Support/Jingjing、7777 端口）。
#   JINGJING_DATA_DIR=... JINGJING_PORT=... bash packaging/macos/dev.sh
#
# 用 open（LaunchServices）启动，而不是直接执行 App 里的可执行文件：直接执行时 App 会挂在
# 启动它的终端名下（比如 Cursor / VS Code 的内置终端），点 Dock 图标、菜单栏「打开静静」
# 或按 ⌥⌘J 时，系统激活的是那个编辑器的窗口，而不是静静。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/packaging/macos/build/Jingjing.app"
EXE="$APP/Contents/MacOS/Jingjing"

# 只认这个构建目录里的进程，不会碰已安装的静静。
dev_running() { pgrep -f "$EXE" >/dev/null 2>&1; }
stop_dev() {
  pkill -TERM -f "$EXE" 2>/dev/null || true
  for _ in $(seq 1 50); do dev_running || return 0; sleep 0.2; done
}

# 上一次 dev.sh 起的还开着：先退掉，不然构建会删掉正在运行的 App。
if dev_running; then
  echo "==> 退出上一次的开发版"
  stop_dev
fi

bash "$ROOT/packaging/macos/build.sh" --app-only

DATA_DIR="${JINGJING_DATA_DIR:-$ROOT/data}"
PORT="${JINGJING_PORT:-7787}"
LOG="$DATA_DIR/logs/server.log"
mkdir -p "$DATA_DIR/logs"
touch "$LOG"

TAIL_PID=""
cleanup() {
  [[ -n "$TAIL_PID" ]] && kill "$TAIL_PID" 2>/dev/null || true
  stop_dev
}
trap 'echo; echo "==> 退出开发版"; cleanup; exit 0' INT TERM
trap cleanup EXIT

echo "==> 运行：数据目录 ${DATA_DIR}，端口 ${PORT}（Ctrl+C 退出，日志见下方）"
tail -n 0 -F "$LOG" &
TAIL_PID=$!

# -n 起一个新实例，-W 等它退出（在菜单栏点「退出静静」或这里 Ctrl+C 都行）。
open -n -W \
  --env JINGJING_DATA_DIR="$DATA_DIR" \
  --env JINGJING_PORT="$PORT" \
  --env JINGJING_OPEN_WINDOW=1 \
  "$APP"
