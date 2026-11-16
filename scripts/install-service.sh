#!/usr/bin/env bash
# 把静静安装成 macOS LaunchAgent，开机自启、崩溃自动拉起。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 node。请先安装 Node.js 24（或 23.4+）。" >&2
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
if (( NODE_MAJOR < 23 )); then
  echo "当前 Node 是 $NODE_VERSION，静静需要 23.4+。" >&2
  exit 1
fi

HOST="${JINGJING_HOST:-0.0.0.0}"
PORT="${JINGJING_PORT:-7777}"
LABEL="${JINGJING_LABEL:-com.jingjing.server}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ROOT/data/logs"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

PLIST_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE_BIN")</string>
    <string>$(xml_escape "$ROOT/server.js")</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>JINGJING_HOST</key>
    <string>$(xml_escape "$HOST")</string>
    <key>JINGJING_PORT</key>
    <string>$(xml_escape "$PORT")</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$(xml_escape "$HOME/.local/bin")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$LOG_DIR/server.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$LOG_DIR/server.err.log")</string>
</dict>
</plist>
"

if [[ "${JINGJING_DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' "$PLIST_CONTENT"
  exit 0
fi

printf '%s\n' "$PLIST_CONTENT" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

sleep 1
echo ""
echo "静静已经装成常驻服务（$LABEL）。"
echo "  本机：   http://127.0.0.1:$PORT"
if [[ "$HOST" == "0.0.0.0" ]]; then
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || true)"
  [[ -z "$LAN_IP" ]] && LAN_IP="$(ipconfig getifaddr en1 2>/dev/null || true)"
  if [[ -n "$LAN_IP" ]]; then
    echo "  局域网： http://$LAN_IP:$PORT"
  fi
  if command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
    [[ -n "$TS_IP" ]] && echo "  Tailscale： http://$TS_IP:$PORT"
  fi
fi
echo "  日志：   $LOG_DIR/server.log"
echo ""
echo "停止并卸载：bash scripts/uninstall-service.sh"
