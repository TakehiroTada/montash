#!/usr/bin/env bash
# W-20: 複数コマンドを 1 ファイル（JSON Lines）から一括実行する（docs/04 §16、docs/10 §10、F-AI-5）。
# 正常系（1 op にまとまる）→ 途中失敗でロールバック → 壊れた入力 → --continue-on-error → stdin + -m → --dry-run。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --id a --json >/dev/null || exit 1

section "W-20-1 1 行 1 コマンドの JSON Lines を一括実行する"
cat > "$root/edits.jsonl" <<'EOF'
# 3 通りの書き方を混ぜられる（空行と # は読み飛ばす）
{"args": ["clip", "add", "--asset", "a", "--in", "f:0", "--duration", "f:30", "--at", "end"]}

["clip", "add", "--asset", "a", "--in", "f:30", "--duration", "f:30", "--at", "end"]
montash clip add --asset a --in f:60 --duration f:30 --at end
EOF
out=$(montash -C "$proj" batch "$root/edits.jsonl" --json)
assert_exit 0 "batch が成功する"
assert_json "$out" '.result.mode' 'atomic' "既定は --atomic"
assert_json "$out" '.result.total' '3' "3 行を読む"
assert_json "$out" '.result.succeeded' '3' "3 行とも成功"
assert_json "$out" '.result.failed' '0' "失敗 0"
assert_json "$out" '.result.lines[0].line' '2' "どの行かが分かる（コメントを飛ばして 2 行目）"
assert_json "$out" '.result.lines[0].command' 'clip add' "解決されたコマンドが分かる"
assert_json "$out" '.result.lines[2].status' 'ok' "素の bash 行も実行できる"
assert_json "$out" '.result.lines[0].result.clip.id' 'c1' "行ごとの結果（新しいクリップ ID）が読める"

section "W-20-1b 履歴にはバッチ全体で 1 op だけ残る（docs/11 §3.2）"
op=$(json_get "$out" '.op')
case "$op" in
  '"o_0003"') pass "バッチが 1 op（init + import の次）" ;;
  *) fail "バッチが 1 op（init + import の次）" "op: $op" ;;
esac
assert_json "$out" '.result.lines[0].op' 'null' "行ごとの op は積まない"
out2=$(montash -C "$proj" log --ops --json)
assert_json "$out2" '.result.pending | length' '3' "op は init / import / batch の 3 つだけ"
assert_json "$out2" '.result.pending[0].id' 'o_0003' "最新 op が batch"
out2=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$out2" '.result.clips | length' '3' "クリップが 3 本並んでいる"

section "W-20-2 途中で失敗したら開始前へ巻き戻る（--atomic）"
cat > "$root/bad.jsonl" <<'EOF'
clip add --asset a --in f:0 --duration f:30 --at end
clip delete c_does_not_exist
clip add --asset a --in f:0 --duration f:30 --at end
EOF
out=$(montash -C "$proj" batch "$root/bad.jsonl" --json)
assert_exit 1 "バッチが失敗する"
assert_json "$out" '.ok' 'false' "ok: false"
assert_json "$out" '.error.code' 'E_BATCH_FAILED' "E_BATCH_FAILED が返る"
assert_json "$out" '.error.detail.rolled_back' 'true' "巻き戻したと明示される"
assert_json "$out" '.error.detail.rollback.via' 'checkout' "既存の履歴機構（checkout）で戻す"
assert_json "$out" '.error.detail.lines[0].status' 'ok' "1 行目は成功していた"
assert_json "$out" '.error.detail.lines[1].status' 'failed' "2 行目で失敗"
assert_json "$out" '.error.detail.lines[1].error.code' 'E_CLIP_NOT_FOUND' "失敗の理由が分かる"
assert_json "$out" '.error.detail.lines[2].status' 'skipped' "3 行目は実行されない"

out=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$out" '.result.clips | length' '3' "タイムラインは開始前のまま（3 本）"
out=$(montash -C "$proj" log --ops --json)
assert_json "$out" '.result.pending | length' '3' "op も増えていない"
out=$(montash -C "$proj" history verify --json)
assert_json "$out" '.result.ok' 'true' "履歴は壊れていない"

section "W-20-3 壊れた入力は 1 行も実行せずに落とす"
printf 'clip add --asset a --at end\n{"args": ["clip"\n' > "$root/broken.jsonl"
out=$(montash -C "$proj" batch "$root/broken.jsonl" --json)
assert_exit 1 "構文エラーで失敗する"
assert_json "$out" '.error.code' 'E_BATCH_PARSE' "E_BATCH_PARSE が返る"
assert_json "$out" '.error.detail.line' '2' "直すべき行番号が分かる"
out=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$out" '.result.clips | length' '3' "1 行目も実行されていない"

printf '\n# nothing to do\n' > "$root/empty.jsonl"
out=$(montash -C "$proj" batch "$root/empty.jsonl" --json)
assert_exit 1 "空のバッチは失敗する"
assert_json "$out" '.error.code' 'E_BATCH_EMPTY' "E_BATCH_EMPTY が返る"

section "W-20-4 一部でも通したいときは --continue-on-error（各行が op になる）"
out=$(montash -C "$proj" batch "$root/bad.jsonl" --continue-on-error --json)
assert_exit 1 "失敗した行があるので終了コードは 1"
assert_json "$out" '.ok' 'true' "適用された分があるので ok: true（import / proxy build と同じ扱い）"
assert_json "$out" '.result.mode' 'continue-on-error' "モードが分かる"
assert_json "$out" '.result.succeeded' '2' "2 行成功"
assert_json "$out" '.result.failed' '1' "1 行失敗"
assert_json "$out" '.result.lines[2].status' 'ok' "失敗の後も実行を続ける"
assert_json "$out" '.op' 'null' "バッチ全体の op は作らない"
out2=$(montash -C "$proj" log --ops --json)
assert_json "$out2" '.result.pending | length' '5' "成功した 2 行がそれぞれ op になる"

section "W-20-5 標準入力から読み、そのままコミットする（-m）"
out=$(printf '{"args": ["clip", "add", "--asset", "a", "--in", "f:0", "--duration", "f:15", "--at", "end"]}\n' \
  | montash -C "$proj" batch - -m "末尾に 0.5 秒のカットを足す" --json)
assert_exit 0 "標準入力から実行できる"
assert_json "$out" '.result.source' '<stdin>' "入力が標準入力と分かる"
assert_json "$out" '.commit' 'k_0001' "バッチ全体が 1 コミットになる"
assert_json "$out" '.head.pending' '0' "pending は残らない"

section "W-20-6 --dry-run は解釈だけして何も変えない"
out=$(montash -C "$proj" batch "$root/edits.jsonl" --dry-run --json)
assert_exit 0 "dry-run は成功する"
assert_json "$out" '.result.dry_run' 'true' "dry_run: true"
assert_json "$out" '.result.lines[2].command' 'clip add' "各行がどのコマンドになるか分かる"
assert_json "$out" '.op' 'null' "op は作らない"
before=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$before" '.result.clips | length' '6' "タイムラインは変わらない"

section "W-20 失敗: 履歴を動かすコマンドは atomic バッチに入れられない"
printf 'undo\n' > "$root/undo.jsonl"
out=$(montash -C "$proj" batch "$root/undo.jsonl" --json)
assert_exit 1 "失敗する"
assert_json "$out" '.error.detail.lines[0].error.code' 'E_BATCH_UNSUPPORTED' "E_BATCH_UNSUPPORTED が返る"
assert_json "$out" '.error.detail.rolled_back' 'false' "何も適用されていないので巻き戻しも不要"

finish
