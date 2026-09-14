#!/usr/bin/env bash
# tests/workflows/W-*.sh を番号順に実行し、まとめて結果を出す。
set -u
here=$(cd "$(dirname "$0")" && pwd)
failed=""
total=0
for script in "$here"/W-*.sh; do
  [ -e "$script" ] || continue
  total=$((total + 1))
  printf '\n######## %s\n' "$(basename "$script")"
  if ! bash "$script"; then
    failed="$failed $(basename "$script")"
  fi
done
printf '\n######## workflows: %d run' "$total"
if [ -n "$failed" ]; then
  printf ', failed:%s\n' "$failed"
  exit 1
fi
printf ', all passed\n'
