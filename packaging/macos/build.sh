#!/usr/bin/env bash
# 构建 macOS App（菜单栏 + 原生窗口）、pkg 和 zip。
# 用法：bash packaging/macos/build.sh [--app-only]
#   --app-only  只生成 packaging/macos/build/Jingjing.app，不打 pkg / zip / 升级包（开发调试用）
set -euo pipefail

APP_ONLY=0
[[ "${1:-}" == "--app-only" ]] && APP_ONLY=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$ROOT/packaging/macos/build"
APP="$BUILD/Jingjing.app"
DIST="$ROOT/dist"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 node，无法打包运行时。" >&2
  exit 1
fi

VERSION="$("$NODE_BIN" -p "require('$ROOT/package.json').version")"

rm -rf "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$APP/Contents/Resources/runtime" "$DIST"

echo "==> 编译 App"
CACHE="$BUILD/modulecache"
mkdir -p "$CACHE" "$BUILD/tmp"
CLANG_MODULE_CACHE_PATH="$CACHE" SWIFT_MODULE_CACHE_PATH="$CACHE" TMPDIR="$BUILD/tmp" \
swiftc -O -swift-version 5 -module-cache-path "$CACHE" \
  -framework AppKit -framework WebKit -framework UserNotifications -framework Carbon -framework ServiceManagement \
  -o "$APP/Contents/MacOS/Jingjing" \
  "$ROOT"/packaging/macos/*.swift

cp "$ROOT/packaging/macos/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist" >/dev/null

echo "==> 生成图标"
ICONSET="$BUILD/AppIcon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ROOT/public/icon-512.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$ROOT/public/icon-512.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"

echo "==> 复制服务与静态资源"
rsync -a \
  --exclude 'data' --exclude 'tests' --exclude 'docs' --exclude 'packaging' \
  --exclude '.git' --exclude '.toolchain' --exclude 'mobile' --exclude 'scripts' \
  --exclude 'dist' --exclude 'plugin-src' --exclude 'node_modules' --exclude '.DS_Store' \
  "$ROOT/" "$APP/Contents/Resources/app/"

echo "==> 打包 Node 运行时"
cp "$NODE_BIN" "$APP/Contents/Resources/runtime/node"
chmod +x "$APP/Contents/Resources/runtime/node"

echo "==> 修正权限"
chmod -R u+rwX,go+rX "$APP"
chmod 755 "$APP/Contents/MacOS/Jingjing" "$APP/Contents/Resources/runtime/node"

echo "==> 签名（ad-hoc）"
codesign --force --deep --sign - "$APP" >/dev/null

if [[ "$APP_ONLY" == 1 ]]; then
  echo "完成：$APP"
  exit 0
fi

echo "==> 生成安装包"
STAGE="$BUILD/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/静静.app"
pkgbuild --component "$STAGE/静静.app" --install-location /Applications \
  --identifier ai.jingjing.host --version "$VERSION" "$DIST/静静-$VERSION.pkg" >/dev/null
ditto -c -k --sequesterRsrc --keepParent "$STAGE/静静.app" "$DIST/静静-$VERSION.zip"
rm -rf "$STAGE"

echo "==> 生成在线升级包"
bash "$ROOT/scripts/package-update.sh"

echo ""
echo "完成："
echo "  App:  $APP"
echo "  PKG:  $DIST/静静-$VERSION.pkg"
echo "  ZIP:  $DIST/静静-$VERSION.zip"
du -sh "$APP" "$DIST/静静-$VERSION.pkg" "$DIST/静静-$VERSION.zip"
