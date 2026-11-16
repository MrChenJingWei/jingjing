#!/usr/bin/env bash
# 开发调试：用当前仓库的代码构建 App 并直接运行（不安装、不打包）。
# 默认用仓库里的 data/ 和 7787 端口，不碰已安装的静静（~/Library/Application Support/Jingjing、7777 端口）。
#   JINGJING_DATA_DIR=... JINGJING_PORT=... bash packaging/macos/dev.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$ROOT/packaging/macos/build.sh" --app-only

export JINGJING_DATA_DIR="${JINGJING_DATA_DIR:-$ROOT/data}"
export JINGJING_PORT="${JINGJING_PORT:-7787}"
export JINGJING_OPEN_WINDOW=1
echo "==> 运行：数据目录 ${JINGJING_DATA_DIR}，端口 ${JINGJING_PORT}（Ctrl+C 退出）"
exec "$ROOT/packaging/macos/build/Jingjing.app/Contents/MacOS/Jingjing"
