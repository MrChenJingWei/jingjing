#!/usr/bin/env bash
# 生成在线升级用的代码包（含 server.js / src / public 等），以及 latest.json 清单。
# 产物：dist/jingjing-app-<version>.zip、dist/latest.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/dist"
STAGE="$OUT/update-stage"
VERSION="$(node -p "require('$ROOT/package.json').version")"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  echo "package.json 里的版本号不合法：$VERSION" >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$OUT"

rsync -a \
  --exclude 'data' --exclude 'dist' --exclude 'docs' --exclude 'tests' \
  --exclude 'packaging' --exclude '.git' --exclude '.github' --exclude '.toolchain' \
  --exclude 'node_modules' --exclude 'plugin-src' --exclude 'inbox' --exclude '.DS_Store' \
  "$ROOT/" "$STAGE/app/"

for required in server.js package.json src public plugins; do
  if [[ ! -e "$STAGE/app/$required" ]]; then
    echo "升级包缺少 $required，打包中止" >&2
    exit 1
  fi
done

ZIP_NAME="jingjing-app-$VERSION.zip"
rm -f "$OUT/$ZIP_NAME"
(cd "$STAGE" && zip -qr "$OUT/$ZIP_NAME" app)

if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$OUT/$ZIP_NAME" | awk '{print $1}')"
else
  SHA="$(shasum -a 256 "$OUT/$ZIP_NAME" | awk '{print $1}')"
fi
SIZE="$(wc -c < "$OUT/$ZIP_NAME" | tr -d ' ')"
NOTES="${JINGJING_UPDATE_NOTES:-$(git -C "$ROOT" log -1 --pretty=%s 2>/dev/null || echo "静静 $VERSION")}"
NODE_REQUIRED="$(node -p "require('$ROOT/package.json').engines.node" 2>/dev/null || echo "")"

cat > "$OUT/latest.json" <<JSON
{
  "version": "$VERSION",
  "sha256": "$SHA",
  "notes": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$NOTES"),
  "node": "$NODE_REQUIRED",
  "size": $SIZE
}
JSON

rm -rf "$STAGE"

echo "==> 升级包：$OUT/$ZIP_NAME"
echo "    版本：$VERSION"
echo "    sha256：$SHA"
echo "    清单：$OUT/latest.json"
