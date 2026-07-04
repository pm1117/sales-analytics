#!/usr/bin/env bash
# PostToolUse hook: TS ファイル編集後に tsc --noEmit を走らせ、型エラーを Claude に返す。
#
# 入力 : PostToolUse のフック JSON を stdin で受け取る（.tool_input.file_path を使う）
# 契約 :
#   - 編集ファイルが .ts / .tsx でなければ何もしない (exit 0)
#   - 上位に tsconfig.json が無ければ何もしない (exit 0)   ← 空プロジェクトでも無害
#   - typescript 未インストールなら何もしない (exit 0)     ← 依存導入前でも無害
#   - 型エラーがあれば stderr にエラー内容を出して exit 2  ← Claude にフィードバックされる
#   - 型チェック成功時は無言 (exit 0)
set -uo pipefail

payload="$(cat)"

# jq が無ければ安全側に倒して何もしない
command -v jq >/dev/null 2>&1 || exit 0

file="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty')"

# TypeScript ファイルのみ対象
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac

# 編集ファイルから上位へ tsconfig.json を探す
dir="$(cd "$(dirname "$file")" 2>/dev/null && pwd)" || exit 0
root=""
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -f "$dir/tsconfig.json" ]; then
    root="$dir"
    break
  fi
  dir="$(dirname "$dir")"
done

# TS プロジェクトがまだ無い → 静かに終了（graceful degradation）
[ -z "$root" ] && exit 0

# ローカルの tsc を優先（npx より速く、未インストール時は無害に終了）
tsc_bin="$root/node_modules/.bin/tsc"
[ -x "$tsc_bin" ] || exit 0

# プロジェクト直下で実行 → tsc のパス表示が root 相対になり読みやすい
cd "$root" || exit 0
out="$("$tsc_bin" --noEmit 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  {
    echo "⛔ TypeScript 型チェックでエラーがあります (tsc --noEmit @ ${root/#$HOME/\~}):"
    echo "$out"
  } >&2
  exit 2
fi

exit 0
