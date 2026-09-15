#!/usr/bin/env bash
# E2E ワークフローテスト用ヘルパ（docs/03 の W-XX をそのまま bash で再現する）。
# bash 3.2（macOS 既定）互換: 連想配列・${var,,} などは使わない。
#
# 使い方（W-01.sh を参照）:
#   source "$(dirname "$0")/lib.sh"
#   out=$(montash doctor --json); assert_json "$out" '.ok' 'true' 'doctor ok'
#   finish   # summary を出して終了コードを返す

set -u

# リポジトリルート（tests/workflows/lib.sh から 2 つ上）
MONTASH_REPO="${MONTASH_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export MONTASH_REPO

_PASS=0
_FAIL=0
_SKIP=0
_FAILED_NAMES=""
_TMP_DIRS=""
# 直前の montash の終了コード。`out=$(montash ...)` のようにサブシェルで呼ばれても
# 親から読めるようにファイル経由で受け渡す。
_EXIT_FILE=$(mktemp "${TMPDIR:-/tmp}/montash-e2e-exit-XXXXXX")
printf '0' > "$_EXIT_FILE"

# montash CLI を bun で直接実行する。
montash() {
  bun "$MONTASH_REPO/src/cli/index.ts" "$@"
  local rc=$?
  printf '%s' "$rc" > "$_EXIT_FILE"
  return $rc
}

last_exit() {
  cat "$_EXIT_FILE"
}

pass() {
  _PASS=$((_PASS + 1))
  printf '  ok   %s\n' "$1"
}

# まだ実装されていない依存コマンドなどで検証を飛ばす（失敗にはしない）
skip() {
  _SKIP=$((_SKIP + 1))
  printf '  skip %s\n' "$1"
  if [ $# -gt 1 ]; then
    shift
    printf '       %s\n' "$@"
  fi
}

# has_command <path...>  montash schema にそのコマンドが登録されているか。
# 別エージェントが並行実装中のコマンドを skip するために使う（last_exit を汚さないよう直接 bun を呼ぶ）。
_SCHEMA_CACHE=""
has_command() {
  local path="$*"
  if [ -z "$_SCHEMA_CACHE" ]; then
    _SCHEMA_CACHE=$(bun "$MONTASH_REPO/src/cli/index.ts" schema --json 2>/dev/null)
  fi
  case "$_SCHEMA_CACHE" in
    *"\"path\":\"$path\""* | *"\"path\": \"$path\""*) return 0 ;;
    *) return 1 ;;
  esac
}

fail() {
  _FAIL=$((_FAIL + 1))
  _FAILED_NAMES="${_FAILED_NAMES}
    - $1"
  printf '  FAIL %s\n' "$1" >&2
  if [ $# -gt 1 ]; then
    shift
    printf '       %s\n' "$@" >&2
  fi
}

# JSON から jq フィルタで値を取り出す（-c: 1 行の JSON）。jq が無ければ bun で代替する。
# bun 代替は ".a.b[0]" 形式のパス参照のみ対応。E2E_NO_JQ=1 で強制的に bun 側を使う（代替の動作確認用）。
json_get() {
  local json="$1" filter="$2"
  if [ "${E2E_NO_JQ:-0}" != "1" ] && command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -c "$filter"
  else
    _json_get_bun "$json" "$filter"
  fi
}

_json_get_bun() {
  local json="$1" filter="$2"
  MONTASH_JSON_INPUT="$json" MONTASH_JSON_FILTER="$filter" bun -e '
      const json = JSON.parse(process.env.MONTASH_JSON_INPUT);
      const filter = process.env.MONTASH_JSON_FILTER.trim();
      let cur = json;
      const re = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g;
      let m;
      while ((m = re.exec(filter)) !== null) {
        if (cur === null || cur === undefined) break;
        cur = m[1] !== undefined ? cur[m[1]] : cur[Number(m[2])];
      }
      console.log(cur === undefined ? "null" : JSON.stringify(cur));
    '
}

# assert_json <json> <jq-filter> <expected(1 行 JSON 文字列)> [name]
# 例: assert_json "$out" '.result.settings.fps' '{"num":30000,"den":1001}'
assert_json() {
  local json="$1" filter="$2" expected="$3" name="${4:-$2 == $3}"
  local actual
  actual=$(json_get "$json" "$filter" 2>/dev/null)
  # 期待値が文字列の場合は引用符ありでも無しでも比較できるようにする
  if [ "$actual" = "$expected" ] || [ "$actual" = "\"$expected\"" ]; then
    pass "$name"
  else
    fail "$name" "filter:   $filter" "expected: $expected" "actual:   $actual"
  fi
}

# assert_exit <expected> [name]  直前の montash 呼び出しの終了コードを検査する
assert_exit() {
  local expected="$1" name="${2:-exit code == $1}" actual
  actual=$(last_exit)
  if [ "$actual" -eq "$expected" ]; then
    pass "$name"
  else
    fail "$name" "expected exit $expected, got $actual"
  fi
}

# assert_file_exists <path> [name]
assert_file_exists() {
  local path="$1" name="${2:-exists: $1}"
  if [ -e "$path" ]; then pass "$name"; else fail "$name" "missing: $path"; fi
}

assert_dir_exists() {
  local path="$1" name="${2:-dir exists: $1}"
  if [ -d "$path" ]; then pass "$name"; else fail "$name" "missing dir: $path"; fi
}

# 一時プロジェクトディレクトリ（finish で削除。KEEP_TMP=1 で残す）
tmp_project_dir() {
  local d
  d=$(mktemp -d "${TMPDIR:-/tmp}/montash-e2e-XXXXXX")
  _TMP_DIRS="${_TMP_DIRS} $d"
  printf '%s' "$d"
}

section() {
  printf '\n== %s\n' "$1"
}

# summary を出して終了コード（失敗があれば 1）で exit する
finish() {
  if [ "${KEEP_TMP:-0}" != "1" ]; then
    for d in $_TMP_DIRS; do rm -rf "$d"; done
  fi
  rm -f "$_EXIT_FILE"
  if [ "$_SKIP" -gt 0 ]; then
    printf '\n%s: %d passed, %d failed, %d skipped\n' "$(basename "$0")" "$_PASS" "$_FAIL" "$_SKIP"
  else
    printf '\n%s: %d passed, %d failed\n' "$(basename "$0")" "$_PASS" "$_FAIL"
  fi
  if [ "$_FAIL" -gt 0 ]; then
    printf 'failed:%s\n' "$_FAILED_NAMES" >&2
    exit 1
  fi
  exit 0
}
