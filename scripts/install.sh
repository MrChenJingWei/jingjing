#!/usr/bin/env bash
# 静静安装脚本：一条命令装好。
#
#   命令行版（macOS / Linux）：
#     curl -fsSL https://github.com/MrChenJingWei/jingjing/releases/latest/download/install.sh | bash
#
#   Windows：用 PowerShell 版 install.ps1（见 README）。
#
#   macOS App（菜单栏 + 原生窗口，Apple Silicon）：
#     curl -fsSL https://github.com/MrChenJingWei/jingjing/releases/latest/download/install.sh | bash -s -- --app
#
# 不指定版本时安装最新 Release；也可以用 --version v0.3.1 装指定版本。
# 环境变量：JINGJING_REPO、JINGJING_RELEASE_BASE、JINGJING_VERSION、JINGJING_NODE_VERSION、
#          JINGJING_DATA_DIR（只影响安装后拉起的服务）。
set -euo pipefail

REPO="${JINGJING_REPO:-MrChenJingWei/jingjing}"
RELEASE_BASE="${JINGJING_RELEASE_BASE:-https://github.com/$REPO/releases}"
NODE_VERSION="${JINGJING_NODE_VERSION:-24.22.3}"
NODE_MIN_MAJOR=23
NODE_MIN_MINOR=4
APP_BUNDLE_NAME="静静.app"
APP_INSTALL_DIR="/Applications"

MODE="cli"
VERSION="${JINGJING_VERSION:-}"
PREFIX=""
HOST="0.0.0.0"
PORT="7777"
WITH_SERVICE=0
AUTO_NODE=1
DRY_RUN=0
NODE_BIN_RESOLVED=""
META_FILE=""
TAG=""
TMP_DIR=""

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""
  GREEN=""
  YELLOW=""
  RED=""
  RESET=""
fi

# info 给终端看；detail 给「被 $() 捕获的函数」用，必须写 stderr。
info() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
detail() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*" >&2; }
warn() { printf '%s警告：%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
fail() {
  printf '%s安装失败：%s %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

usage() {
  cat <<'HELP'
静静安装脚本

用法：
  install.sh [选项]

选项：
  --app               安装 macOS App（.pkg，Apple Silicon；会用到 sudo）
  --version <版本>     指定版本，如 v0.3.1（默认最新 Release）
  --prefix <目录>      命令行版的安装目录（默认 macOS 下
                      ~/Library/Application Support/Jingjing/cli，
                      Linux 下 ~/.local/share/jingjing）
  --host <地址>        服务监听地址（默认 0.0.0.0，手机/局域网可访问）
  --port <端口>        服务端口（默认 7777）
  --service            安装完顺手装成 macOS LaunchAgent（开机自启）
  --no-node            缺少 Node.js 时直接报错，不自动下载
  --dry-run            只打印将要执行的步骤
  -h, --help           显示帮助

示例：
  curl -fsSL https://github.com/MrChenJingWei/jingjing/releases/latest/download/install.sh | bash
  curl -fsSL https://github.com/MrChenJingWei/jingjing/releases/latest/download/install.sh | bash -s -- --app
  bash scripts/install.sh --version v0.3.1 --prefix /opt/jingjing

环境变量：
  JINGJING_REPO             GitHub 仓库（默认 MrChenJingWei/jingjing）
  JINGJING_RELEASE_BASE     替换 Release 下载地址（调试/镜像用）
  JINGJING_VERSION          同 --version
  JINGJING_NODE_VERSION     自动下载 Node 时用的版本（默认 24.22.3）
  JINGJING_DATA_DIR         运行时数据目录（默认 <prefix>/data）
HELP
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) MODE="app" ;;
    --version)
      [ $# -ge 2 ] || fail "--version 需要一个版本号"
      VERSION="$2"
      shift
      ;;
    --prefix)
      [ $# -ge 2 ] || fail "--prefix 需要一个目录"
      PREFIX="$2"
      shift
      ;;
    --host)
      [ $# -ge 2 ] || fail "--host 需要一个地址"
      HOST="$2"
      shift
      ;;
    --port)
      [ $# -ge 2 ] || fail "--port 需要一个端口"
      PORT="$2"
      shift
      ;;
    --service) WITH_SERVICE=1 ;;
    --no-node) AUTO_NODE=0 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "不认识的参数：${1}（用 --help 看用法）"
      ;;
  esac
  shift
done

OS="$(uname -s)"
MACHINE="$(uname -m)"

case "$OS" in
  Darwin|Linux) ;;
  MINGW*|MSYS*|CYGWIN*)
    fail "Windows 请在 PowerShell 里用 install.ps1 安装：irm $RELEASE_BASE/latest/download/install.ps1 -OutFile \"\$env:TEMP\\jingjing-install.ps1\"; powershell -NoProfile -ExecutionPolicy Bypass -File \"\$env:TEMP\\jingjing-install.ps1\""
    ;;
  *) fail "暂时只支持 macOS 和 Linux（当前：${OS}）。" ;;
esac

if [ -z "$PREFIX" ]; then
  if [ "$OS" = "Darwin" ]; then
    PREFIX="$HOME/Library/Application Support/Jingjing/cli"
  else
    PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/jingjing"
  fi
fi

DATA_DIR="${JINGJING_DATA_DIR:-$PREFIX/data}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令 ${1}，请先安装。"
}

download() { # download <url> <输出文件>
  curl -fsSL --retry 3 --retry-delay 1 -o "$2" "$1" || fail "下载失败：$1"
}

try_download() { # 失败时返回非 0，不退出
  curl -fsSL --retry 2 --retry-delay 1 -o "$2" "$1" 2>/dev/null
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "找不到 shasum / sha256sum，无法校验安装包。"
  fi
}

json_string() { # json_string <json 文件> <字段名>
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" | head -n 1
}

sha256_allowed() { # sha256_allowed <期望值> <文件>；供 $() 调用，输出走 stderr
  local want="$1" got
  got="$(sha256_of "$2")"
  [ "$want" = "$got" ] || fail "$(basename "$2") 校验失败：期望 ${want}，实际 $got"
  detail "已校验 $(basename "$2") 的 sha256"
}

node_version_ok() {
  local bin="$1" version major minor
  version="$("$bin" -v 2>/dev/null || true)"
  version="${version#v}"
  major="${version%%.*}"
  minor="$(printf '%s' "$version" | cut -d. -f2)"
  [ -n "$major" ] && [ -n "$minor" ] || return 1
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt "$NODE_MIN_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ] && return 0
  return 1
}

find_node() {
  local bin
  bin="$(command -v node || true)"
  if [ -n "$bin" ] && node_version_ok "$bin"; then
    printf '%s' "$bin"
  fi
}

node_platform() {
  case "$OS/$MACHINE" in
    Darwin/arm64) echo "darwin-arm64" ;;
    Darwin/x86_64) echo "darwin-x64" ;;
    Linux/aarch64|Linux/arm64) echo "linux-arm64" ;;
    Linux/x86_64) echo "linux-x64" ;;
    *) fail "没有适合 $OS/$MACHINE 的 Node.js 预编译包。" ;;
  esac
}

provision_node() { # 输出 node 路径（stdout 只放路径）
  local platform url name archive shasums expected
  platform="$(node_platform)"
  name="node-v${NODE_VERSION}-${platform}.tar.gz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${name}"

  if [ "$DRY_RUN" = "1" ]; then
    detail "（演练）下载 Node v${NODE_VERSION}：$url"
    printf '%s\n' "$PREFIX/runtime/bin/node"
    return 0
  fi

  TMP_DIR="${TMP_DIR:-$(mktemp -d)}"
  archive="$TMP_DIR/$name"
  shasums="$TMP_DIR/SHASUMS256.txt"

  detail "本机没有可用的 Node.js，下载 Node v${NODE_VERSION}（${platform}）"
  download "$url" "$archive"
  download "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$shasums"
  expected="$(awk -v f="$name" '$2==f {print $1; exit}' "$shasums")"
  [ -n "$expected" ] || fail "Node.js 官方校验文件里找不到 $name"
  sha256_allowed "$expected" "$archive"

  rm -rf "$PREFIX/runtime"
  mkdir -p "$PREFIX/runtime"
  tar -xzf "$archive" -C "$PREFIX/runtime" --strip-components=1
  [ -x "$PREFIX/runtime/bin/node" ] || fail "解压后找不到 $PREFIX/runtime/bin/node"
  printf '%s\n' "$PREFIX/runtime/bin/node"
}

ensure_node() { # 结果写进 NODE_BIN_RESOLVED
  local found
  found="$(find_node)"
  if [ -n "$found" ]; then
    NODE_BIN_RESOLVED="$found"
    detail "使用系统 Node：${found}（$("$found" -v)）"
    return 0
  fi
  [ "$AUTO_NODE" = "1" ] || fail "需要 Node.js ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+（推荐 24），本机没有满足要求的 node。装好后重试，或去掉 --no-node 让脚本自动下载。"
  NODE_BIN_RESOLVED="$(provision_node)"
  [ -n "$NODE_BIN_RESOLVED" ] || fail "Node.js 准备失败"
}

resolve_version() {
  local meta_url meta_version
  [ -n "$VERSION" ] && VERSION="${VERSION#v}"
  if [ -n "$VERSION" ]; then
    TAG="v$VERSION"
    meta_url="$RELEASE_BASE/download/$TAG/latest.json"
  else
    meta_url="$RELEASE_BASE/latest/download/latest.json"
  fi

  TMP_DIR="${TMP_DIR:-$(mktemp -d)}"
  META_FILE="$TMP_DIR/latest.json"
  info "读取 Release 信息：$meta_url"
  download "$meta_url" "$META_FILE"

  meta_version="$(json_string "$META_FILE" version)"
  [ -n "$meta_version" ] || fail "Release 清单里没有 version 字段：$meta_url"

  if [ -z "$VERSION" ]; then
    VERSION="$meta_version"
    TAG="v$VERSION"
  elif [ "$VERSION" != "$meta_version" ]; then
    fail "请求的版本是 ${VERSION}，但清单里的版本是 $meta_version"
  fi

  info "目标版本：$VERSION"
}

sed_escape() { # 供 sed 替换用的转义
  printf '%s' "$1" | sed 's/[&/|\\]/\\&/g'
}

write_launcher() { # write_launcher <node 路径>
  local node_bin="$1" launcher="$PREFIX/bin/jingjing" tmp
  mkdir -p "$PREFIX/bin"

  cat > "$launcher" <<'LAUNCHER'
#!/usr/bin/env bash
# 静静命令行入口（由 install.sh 生成）。
set -euo pipefail

PREFIX="__JINGJING_PREFIX__"
DATA_DIR="__JINGJING_DATA_DIR__"
NODE_BIN="__JINGJING_NODE__"
APP_DIR="$PREFIX/current"

export JINGJING_DATA_DIR="${JINGJING_DATA_DIR:-$DATA_DIR}"
export JINGJING_HOST="${JINGJING_HOST:-__JINGJING_HOST__}"
export JINGJING_PORT="${JINGJING_PORT:-__JINGJING_PORT__}"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到 Node.js 运行时（${NODE_BIN}）。重新运行 install.sh 可以补上。" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/server.js" ]; then
  echo "静静的程序目录不完整：${APP_DIR}（重新运行 install.sh）" >&2
  exit 1
fi

app_version() {
  sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -n 1
}

pair_url() {
  local key=""
  if [ -f "$DATA_DIR/access-key" ]; then
    key="$(tr -d '[:space:]' < "$DATA_DIR/access-key")"
  fi
  if [ -n "$key" ]; then
    printf 'http://127.0.0.1:%s/pair?key=%s' "$JINGJING_PORT" "$key"
  else
    printf 'http://127.0.0.1:%s' "$JINGJING_PORT"
  fi
}

open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1
  else
    echo "请手动打开：$1"
  fi
}

usage() {
  cat <<EOF
用法：jingjing <命令>

  （无参数）/ start   前台启动服务（Ctrl+C 停止）
  open               用浏览器打开（自动带上配对码）
  url                打印本机地址和配对码
  status             查看服务是否在运行
  service install     装成 macOS LaunchAgent：开机自启、崩溃自动拉起
  service uninstall   卸载 LaunchAgent
  version            打印版本

当前数据目录：$DATA_DIR
监听地址：     $JINGJING_HOST:$JINGJING_PORT
EOF
}

cmd="${1:-start}"
[ $# -gt 0 ] && shift || true

case "$cmd" in
  start|run)
    mkdir -p "$DATA_DIR"
    echo "静静 v$(app_version) 启动中：http://127.0.0.1:$JINGJING_PORT （Ctrl+C 停止）"
    exec "$NODE_BIN" "$APP_DIR/server.js"
    ;;
  open)
    mkdir -p "$DATA_DIR"
    open_url "$(pair_url)"
    ;;
  url)
    echo "$(pair_url)"
    ;;
  status)
    if command -v curl >/dev/null 2>&1; then
      curl -fsS "http://127.0.0.1:$JINGJING_PORT/api/health" && echo
    else
      echo "缺少 curl，无法检查状态。" >&2
      exit 1
    fi
    ;;
  service)
    action="${1:-}"
    if [ "$(uname -s)" != "Darwin" ]; then
      echo "service 子命令只在 macOS 上可用；Linux 请用 systemd 托管。" >&2
      exit 1
    fi
    case "$action" in
      install)
        JINGJING_NODE="$NODE_BIN" bash "$APP_DIR/scripts/install-service.sh"
        ;;
      uninstall)
        bash "$APP_DIR/scripts/uninstall-service.sh"
        ;;
      *)
        echo "用法：jingjing service install|uninstall" >&2
        exit 1
        ;;
    esac
    ;;
  version)
    app_version
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac
LAUNCHER

  tmp="$launcher.tmp"
  sed \
    -e "s|__JINGJING_PREFIX__|$(sed_escape "$PREFIX")|g" \
    -e "s|__JINGJING_DATA_DIR__|$(sed_escape "$DATA_DIR")|g" \
    -e "s|__JINGJING_NODE__|$(sed_escape "$node_bin")|g" \
    -e "s|__JINGJING_HOST__|$(sed_escape "$HOST")|g" \
    -e "s|__JINGJING_PORT__|$(sed_escape "$PORT")|g" \
    "$launcher" > "$tmp"
  mv "$tmp" "$launcher"
  chmod +x "$launcher"
}

link_current() {
  ln -sfn "$PREFIX/versions/$VERSION" "$PREFIX/current"
}

print_cli_summary() {
  local launcher="$PREFIX/bin/jingjing"
  local shell_rc="~/.zshrc"
  [ "$OS" = "Linux" ] && shell_rc="~/.bashrc"
  cat <<EOF

${BOLD}静静已安装${RESET}  v${VERSION}

  程序目录：   $PREFIX/versions/$VERSION
  当前版本：   $PREFIX/current
  数据目录：   $DATA_DIR
  启动命令：   $launcher

接下来：

  1. ${BOLD}$launcher${RESET}            # 前台启动（Ctrl+C 停止）
  2. 打开 ${BOLD}http://127.0.0.1:$PORT${RESET}
     第一次启动后配对码在 $DATA_DIR/access-key
     或者直接：$launcher url   /   $launcher open

想让它常驻、开机自启（macOS）：

  $launcher service install     # 卸载：$launcher service uninstall

EOF
  if [ "$OS" = "Linux" ]; then
    echo "提示：Linux 下目前没有内置开机自启，可用 systemd 自行托管："
    echo "  ExecStart=$NODE_BIN_RESOLVED $PREFIX/current/server.js（WorkingDirectory=$PREFIX/current）"
    echo "  并设置 JINGJING_DATA_DIR=$DATA_DIR"
    echo ""
  fi
  case ":$PATH:" in
    *":$PREFIX/bin:"*) ;;
    *)
      echo "提示：把 $PREFIX/bin 加进 PATH 后就能直接用 \`jingjing\` 命令："
      echo "  echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> $shell_rc && source $shell_rc"
      echo ""
      ;;
  esac
}

install_cli() {
  local code_zip expected
  resolve_version
  ensure_node

  if [ "$DRY_RUN" = "1" ]; then
    info "（演练）程序目录：$PREFIX/versions/$VERSION"
    info "（演练）数据目录：$DATA_DIR"
    info "（演练）Node：$NODE_BIN_RESOLVED"
    info "（演练）下载：$RELEASE_BASE/download/$TAG/jingjing-app-$VERSION.zip"
    return 0
  fi

  need_cmd curl
  need_cmd unzip
  mkdir -p "$PREFIX/versions" "$PREFIX/bin" "$DATA_DIR"

  if [ -f "$PREFIX/versions/$VERSION/server.js" ]; then
    info "v$VERSION 已经在 $PREFIX/versions/${VERSION}，跳过下载"
  else
    TMP_DIR="${TMP_DIR:-$(mktemp -d)}"
    code_zip="$TMP_DIR/jingjing-app-$VERSION.zip"
    info "下载代码包：$RELEASE_BASE/download/$TAG/jingjing-app-$VERSION.zip"
    download "$RELEASE_BASE/download/$TAG/jingjing-app-$VERSION.zip" "$code_zip"

    expected="$(json_string "$META_FILE" sha256)"
    [ -n "$expected" ] || fail "Release 清单里没有 sha256 字段"
    sha256_allowed "$expected" "$code_zip"

    mkdir -p "$TMP_DIR/extract"
    unzip -q "$code_zip" -d "$TMP_DIR/extract" || fail "解压代码包失败"
    [ -f "$TMP_DIR/extract/app/server.js" ] || fail "代码包里没有 app/server.js"
    rm -rf "$PREFIX/versions/$VERSION"
    mv "$TMP_DIR/extract/app" "$PREFIX/versions/$VERSION"
  fi

  chmod +x "$PREFIX/versions/$VERSION/scripts/"*.sh 2>/dev/null || true
  link_current
  write_launcher "$NODE_BIN_RESOLVED"

  print_cli_summary

  if [ "$WITH_SERVICE" = "1" ]; then
    if [ "$OS" != "Darwin" ]; then
      warn "--service 只支持 macOS，已跳过。"
    else
      info "装成 LaunchAgent（$PREFIX/current）"
      JINGJING_NODE="$NODE_BIN_RESOLVED" bash "$PREFIX/current/scripts/install-service.sh"
    fi
  fi
}

install_app() {
  [ "$OS" = "Darwin" ] || fail "App 只有 macOS 版；其他系统请用命令行版（去掉 --app）。"
  [ "$MACHINE" = "arm64" ] || fail "目前只发布 Apple Silicon（arm64）的 App 包；Intel Mac 请用命令行版（去掉 --app）。"

  resolve_version

  local pkg_name pkg_url sums_url sums_file pkg_file expected sudo_cmd
  pkg_name="jingjing-$VERSION-macos-arm64.pkg"
  pkg_url="$RELEASE_BASE/download/$TAG/$pkg_name"
  sums_url="$RELEASE_BASE/download/$TAG/SHA256SUMS"

  if [ "$DRY_RUN" = "1" ]; then
    info "（演练）下载：$pkg_url"
    info "（演练）校验：$sums_url"
    info "（演练）sudo installer -pkg <下载的 pkg> -target /"
    info "（演练）open '$APP_INSTALL_DIR/$APP_BUNDLE_NAME'"
    return 0
  fi

  need_cmd curl
  need_cmd installer
  TMP_DIR="${TMP_DIR:-$(mktemp -d)}"
  pkg_file="$TMP_DIR/$pkg_name"
  sums_file="$TMP_DIR/SHA256SUMS"

  info "下载 App 安装包：$pkg_url"
  download "$pkg_url" "$pkg_file"

  if try_download "$sums_url" "$sums_file"; then
    expected="$(awk -v f="$pkg_name" '$2==f {print $1; exit}' "$sums_file")"
    if [ -n "$expected" ]; then
      sha256_allowed "$expected" "$pkg_file"
    else
      warn "SHA256SUMS 里没有 ${pkg_name}，跳过校验。"
    fi
  else
    warn "这个 Release 没有 SHA256SUMS，跳过校验。"
  fi

  sudo_cmd=""
  if [ "$(id -u)" -ne 0 ]; then
    sudo_cmd="sudo"
    info "需要管理员权限安装到 ${APP_INSTALL_DIR}（会提示输入开机密码）"
  fi

  $sudo_cmd installer -pkg "$pkg_file" -target / || fail "安装包安装失败"
  info "已安装到 $APP_INSTALL_DIR/$APP_BUNDLE_NAME"

  if [ -d "$APP_INSTALL_DIR/$APP_BUNDLE_NAME" ]; then
    if command -v open >/dev/null 2>&1; then
      open "$APP_INSTALL_DIR/$APP_BUNDLE_NAME" || true
    fi
    cat <<EOF

${BOLD}静静 App 已安装${RESET}  v${VERSION}

  · 菜单栏出现「静静」，服务自动启动（默认 7777）
  · 数据目录：~/Library/Application Support/Jingjing/
  · 配对码：~/Library/Application Support/Jingjing/access-key
  · 第一次打开若被 Gatekeeper 拦住：右键「静静.app」→「打开」

EOF
  fi
}

if [ "$MODE" = "app" ]; then
  install_app
else
  install_cli
fi
