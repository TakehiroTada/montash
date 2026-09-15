#!/usr/bin/env bash
# W-12. 複数フォーマットで一括書き出し（docs/03-workflows.md W-12, docs/04 §14, docs/07 §9）
#   render presets → render --preset instagram-reel --reframe center --dry-run
#   → render batch --preset web-preview --preset instagram-reel:--reframe=center -o out/
source "$(dirname "$0")/lib.sh"

fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1
root=$(tmp_project_dir)
proj="$root/trip"

section "W-12 setup"
montash init "$proj" --fps 30 --resolution 320x180 --json >/dev/null
assert_exit 0 "init exits 0"
montash -C "$proj" import "$fixtures/a.mp4" --json >/dev/null
montash -C "$proj" clip add --asset a --in f:0 --duration f:30 --json >/dev/null
assert_exit 0 "clip add exits 0"

section "W-12 step 1: プリセット確認"
out=$(montash -C "$proj" render presets --json)
assert_exit 0 "render presets exits 0"
assert_json "$out" '.result.presets[0].name' 'youtube-1080p' "1 番目は youtube-1080p"
assert_json "$out" '.result.presets[2].name' 'instagram-reel' "instagram-reel がある"
assert_json "$out" '.result.presets[2].resolution.width' '1080' "instagram-reel は 1080x1920"
assert_json "$out" '.result.presets[2].resolution.height' '1920' "instagram-reel は 1080x1920"
assert_json "$out" '.result.presets[9].name' 'thumbnail' "docs/07 §9 + docs/04 §14 の 10 プリセット"
assert_json "$out" '.result.presets[10]' 'null' "プリセットはちょうど 10 種"

section "W-12 step 2: 縦動画のクロップ方針を決めて確認（--dry-run）"
out=$(montash -C "$proj" render --preset instagram-reel --reframe center -o "$proj/out/reel.mp4" --dry-run --json)
assert_exit 0 "dry-run exits 0"
assert_json "$out" '.result.dry_run' 'true' "計画だけを返す"
assert_json "$out" '.result.resolution.width' '1080' "出力は 1080x1920"
assert_json "$out" '.result.resolution.height' '1920' "出力は 1080x1920"
# docs/04 §14: result.command は配列（AI がそのまま渡せる。クォート事故がない）
assert_json "$out" '.result.command[1]' '-n' "command は配列（[ffmpeg, -n, ...]）"
filter=$(json_get "$out" '.result.filter_complex')
case "$filter" in
  *"crop="*"scale=1080:1920"*) pass "--reframe center で crop → scale が入る" ;;
  *) fail "--reframe の crop 式が見つからない" "filter_complex: ${filter:0:200}" ;;
esac
# --reframe を省略するとレターボックス（pad）
out=$(montash -C "$proj" render --preset instagram-reel -o "$proj/out/reel.mp4" --dry-run --json)
filter=$(json_get "$out" '.result.filter_complex')
case "$filter" in
  *"pad=1080:1920"*) pass "--reframe 省略時はレターボックス（pad）" ;;
  *) fail "レターボックスの pad が見つからない" "filter_complex: ${filter:0:200}" ;;
esac
assert_dir_exists "$proj" "dry-run は出力を作らない"
if [ -e "$proj/out/reel.mp4" ]; then fail "dry-run が出力を作ってしまった"; else pass "dry-run は出力を作らない"; fi

section "W-12 step 3: 一括実行"
out=$(montash -C "$proj" render batch \
  --preset "web-preview:--resolution=160x90,--preset-speed=ultrafast" \
  --preset "instagram-reel:--reframe=center,--resolution=90x160,--preset-speed=ultrafast" \
  -o "$proj/out" --progress none --json)
assert_exit 0 "render batch exits 0"
assert_json "$out" '.result.count' '2' "2 ファイル書き出す"
assert_json "$out" '.result.outputs[0].preset' 'web-preview' "1 本目は web-preview"
assert_json "$out" '.result.outputs[1].preset' 'instagram-reel' "2 本目は instagram-reel"
assert_json "$out" '.result.outputs[1].resolution.width' '90' "instagram-reel は縦（90x160）"
assert_json "$out" '.result.outputs[1].resolution.height' '160' "instagram-reel は縦（90x160）"
# プリセット名をファイル名サフィックスに（<project>_<preset>.mp4）
assert_file_exists "$proj/out/trip_web-preview.mp4" "trip_web-preview.mp4"
assert_file_exists "$proj/out/trip_instagram-reel.mp4" "trip_instagram-reel.mp4"

section "W-12 完了条件: 両方の出力が厳密検証を通る"
out=$(montash -C "$proj" render verify "$proj/out/trip_web-preview.mp4" --json)
assert_exit 0 "verify (web-preview) exits 0"
assert_json "$out" '.result.valid' 'true' "web-preview のフレーム数が一致"
out=$(montash -C "$proj" render verify "$proj/out/trip_instagram-reel.mp4" --json)
assert_exit 0 "verify (instagram-reel) exits 0"
assert_json "$out" '.result.valid' 'true' "instagram-reel のフレーム数が一致"

section "W-12 失敗系"
out=$(montash -C "$proj" render --preset nope -o "$proj/out/x.mp4" --dry-run --json)
assert_exit 1 "未知のプリセットは失敗する"
out=$(montash -C "$proj" render batch --preset web-preview -o "$proj/out" --json)
assert_exit 4 "既存の出力は上書きしない（IO エラー）"
assert_json "$out" '.error.code' 'E_OUTPUT_EXISTS' "E_OUTPUT_EXISTS"

finish
