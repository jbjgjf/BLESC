#!/usr/bin/env bash
# blesc.online/demo-view に置く、静的なデモ表示を書き出す。
#
#   scripts/build-demo-view.sh <出力先>
#   例: scripts/build-demo-view.sh ../../main-checkout/sentra/frontend/public/demo-view
#
# 本番の画面（main）とは別物。このブランチの画面を、固定のデモデータだけで
# 動く静的なファイルにして、main の public/demo-view に置く。
#  - デモモードを常に有効にする（ログイン不要。表示するのは fixtures だけ）
#  - API は含めない（POST を持つ Route Handler は静的に書き出せないうえ、
#    デモでは使わない）。Supabase の宛先は解決できない .invalid にして、
#    万一呼ばれても実在のサーバーには届かないようにする
#  - public のファイルへの絶対パスに /demo-view を付ける（basePath は next/image
#    の src と CSS の url() には効かない）
#  - 検索エンジンに載せない
set -euo pipefail

OUT_DIR="${1:?出力先のディレクトリを指定してください}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# .next と .env* は持ち込まない。node_modules は APFS の複製で手早く写す。
find "$HERE" -mindepth 1 -maxdepth 1 ! -name .next ! -name out ! -name '.env*' -exec cp -cR {} "$WORK/" \; 2>/dev/null \
  || find "$HERE" -mindepth 1 -maxdepth 1 ! -name .next ! -name out ! -name '.env*' -exec cp -R {} "$WORK/" \;
rm -rf "$WORK/src/app/api"

(
  cd "$WORK"
  DEMO_VIEW_EXPORT=1 \
  NEXT_PUBLIC_DEMO_MODE=1 \
  NEXT_PUBLIC_SUPABASE_URL=https://demo.invalid \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=demo-view \
  NEXT_PUBLIC_API_URL=https://demo.invalid/api \
    ./node_modules/.bin/next build
)

python3 - "$WORK/out" <<'PY'
import pathlib, re, sys
out = pathlib.Path(sys.argv[1])
base = "/demo-view"
assets = ("/flower.png", "/fonts/material-symbols-rounded.woff2")
prefixed = noindex = 0
for path in out.rglob("*"):
    if not path.is_file() or path.suffix not in (".html", ".js", ".css", ".txt"):
        continue
    text = path.read_text(errors="surrogateescape")
    new = text
    for asset in assets:
        # 直前が英数字・/・.・- のもの（すでに付いている /demo-view/… など）は触らない
        new, n = re.subn(r"(?<![\w/.-])" + re.escape(asset), base + asset, new)
        prefixed += n
    if path.suffix == ".html" and 'name="robots"' not in new:
        new = new.replace("<head>", '<head><meta name="robots" content="noindex, nofollow"/>', 1)
        noindex += 1
    if new != text:
        path.write_text(new, errors="surrogateescape")
print(f"asset paths prefixed: {prefixed}; pages marked noindex: {noindex}")
PY

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$WORK/out/." "$OUT_DIR/"
echo "demo view written to $OUT_DIR ($(find "$OUT_DIR" -name '*.html' | wc -l | tr -d ' ') pages, $(du -sh "$OUT_DIR" | cut -f1))"
