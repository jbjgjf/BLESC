#!/usr/bin/env bash
# blesc.online/demo-view に置く、静的なデモ表示を書き出す。
#
#   scripts/build-demo-view.sh <出力先>
#   例: scripts/build-demo-view.sh ../../main-checkout/sentra/frontend/demo-view-export
#
# 本番の画面（main）とは別物。このブランチの画面を、固定のデモデータだけで
# 動く静的なファイルにして、main の demo-view-export/ に置く。main の
# `npm run build` がそれを public/demo-view に写す（パイロットのビルドでは写さない）。
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

# 何を元にしたかを成果物に書き残す（BUILD_INFO.json）。書き出しの id もこの
# コミットから決まるので、同じコミットから同じ手順で作れば同じものになる。
SOURCE_REF="$(git -C "$HERE" rev-parse --abbrev-ref HEAD)"
SOURCE_COMMIT="$(git -C "$HERE" rev-parse HEAD)"
if [ -n "$(git -C "$HERE" status --porcelain -- "$HERE")" ]; then
  SOURCE_COMMIT="$SOURCE_COMMIT-dirty"
  echo "警告: 作業ツリーに未コミットの変更があります。BUILD_INFO には -dirty と記録します。" >&2
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# .next と .env* は持ち込まない。node_modules は APFS の複製で手早く写す。
find "$HERE" -mindepth 1 -maxdepth 1 ! -name .next ! -name out ! -name '.env*' -exec cp -cR {} "$WORK/" \; 2>/dev/null \
  || find "$HERE" -mindepth 1 -maxdepth 1 ! -name .next ! -name out ! -name '.env*' -exec cp -R {} "$WORK/" \;
rm -rf "$WORK/src/app/api"

(
  cd "$WORK"
  DEMO_VIEW_EXPORT=1 \
  DEMO_VIEW_SOURCE_COMMIT="$SOURCE_COMMIT" \
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

# 画面遷移のとき、ルーターは RSC: 1 を付けて <ページ>.txt を取りに来る。Vercel は
# RSC: 1 の要求を「パス + .rsc」に書き換えてから探す（/a.txt → /a.txt.rsc。
# 先読みの .segments/… が無いときも同じ所に落ちる）ので、同じ中身を .rsc でも
# 置く。無いと 404 になり、遷移のたびにページ全体を読み直してしまう。
twins = 0
for path in out.rglob("*.txt"):
    path.with_name(path.name + ".rsc").write_bytes(path.read_bytes())
    twins += 1
print(f"RSC twins written: {twins}")
PY

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$WORK/out/." "$OUT_DIR/"

# 出所の記録。これが無いと、置いてあるファイルがどのコミットから出たものか
# コミットメッセージの散文にしか残らない（jbjgjf/BLESC#194）。
cat > "$OUT_DIR/BUILD_INFO.json" <<JSON
{
  "source_ref": "$SOURCE_REF",
  "source_commit": "$SOURCE_COMMIT",
  "built_at": "$BUILT_AT",
  "command": "sentra/frontend/scripts/build-demo-view.sh <出力先>",
  "note": "source_commit を checkout して同じコマンドを実行すると、BUILD_INFO.json の built_at 以外は同じ内容になる。"
}
JSON
echo "demo view written to $OUT_DIR ($(find "$OUT_DIR" -name '*.html' | wc -l | tr -d ' ') pages, $(du -sh "$OUT_DIR" | cut -f1))"
