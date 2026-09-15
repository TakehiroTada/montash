#!/usr/bin/env bash
# M1/M3: 取り込み → プロキシ・サムネイル・波形 → 一覧・詳細。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1
montash init "$proj" --resolution 640x360 --json >/dev/null || exit 1

section "W-02 import and inspect"
out=$(montash -C "$proj" import "$fixtures/a.mp4" "$fixtures/tone.wav" --copy --json)
assert_exit 0 "import exits 0"
assert_json "$out" '.result.imported[0].id' 'a' "filename slug"
assert_json "$out" '.result.imported[0].duration_f' '150' "project-frame duration"
assert_json "$out" '.result.imported[1].type' 'audio' "audio detected"
assert_json "$out" '.op' 'o_0002' "import is one history operation"
out=$(montash -C "$proj" proxy build --all --height 64 --thumbs --waveform --json)
assert_exit 0 "proxy build --thumbs --waveform exits 0"
assert_json "$out" '.result.thumbs[0].id' 'a' "thumbnail sprite built for the video"
assert_json "$out" '.result.waveforms[0].id' 'a' "waveform built for the video"
assert_file_exists "$proj/.montash/cache/a/thumbs.jpg" "sprite written"
assert_file_exists "$proj/.montash/cache/a/thumbs.json" "thumbnail index written"
assert_file_exists "$proj/.montash/cache/tone/waveform.json" "waveform written"
out=$(montash -C "$proj" proxy status --json)
assert_json "$out" '.result.proxies[0].state' 'ready' "video proxy ready"
assert_json "$out" '.result.proxies[0].thumbs' 'ready' "video thumbs ready"
assert_json "$out" '.result.proxies[0].waveform' 'ready' "video waveform ready"
assert_json "$out" '.result.proxies[1].state' 'ready' "audio proxy ready"
assert_json "$out" '.result.proxies[1].thumbs' 'null' "audio has no thumbnails"
assert_json "$out" '.result.proxies[1].waveform' 'ready' "audio waveform ready"
out=$(montash -C "$proj" assets list --json)
assert_json "$out" '.result.assets[0].id' 'a' "assets listed"
out=$(montash -C "$proj" assets show a --probe --json)
assert_json "$out" '.result.asset.usage.clips' '[]' "unused source"
assert_json "$out" '.result.probe.streams[0].codec_type' 'video' "raw probe available"

section "W-02 partial failure"
out=$(montash -C "$proj" import "$root/missing.mp4" "$fixtures/logo.png" --json)
assert_exit 4 "partial failure exits 4"
assert_json "$out" '.result.imported[0].type' 'image' "good input retained"
assert_json "$out" '.result.failed[0].error.code' 'E_ASSET_MISSING' "missing input reported"
out=$(montash -C "$proj" proxy build logo --thumbs --json)
assert_exit 0 "proxy build --thumbs on an image exits 0"
assert_json "$out" '.result.proxies' '[]' "images have no proxy"
assert_json "$out" '.result.thumbs[0].state' 'ready' "image thumbnail built"
out=$(montash -C "$proj" proxy status --json)
assert_json "$out" '.result.proxies[2].id' 'logo' "image listed in proxy status"
assert_json "$out" '.result.proxies[2].state' 'null' "image has no proxy state"
assert_json "$out" '.result.proxies[2].thumbs' 'ready' "image thumbs ready"

section "W-02 organise, text assets and fonts"
out=$(montash -C "$proj" assets set a --label "冒頭ドローン" --tags 空撮,冒頭 --add-tag drone --remove-tag 冒頭 --color "#3B82F6" --json)
assert_exit 0 "assets set exits 0"
assert_json "$out" '.result.asset.label' '冒頭ドローン' "label stored"
assert_json "$out" '.result.asset.tags[1]' 'drone' "tag added"
out=$(montash -C "$proj" assets list --tag drone --json)
assert_json "$out" '.result.assets[0].id' 'a' "assets list --tag filters"
out=$(montash -C "$proj" assets new-text title --text "Summer Trip" --json)
assert_exit 0 "assets new-text exits 0"
assert_json "$out" '.result.asset.owned' 'true' "text asset is project-owned"
assert_file_exists "$proj/assets/text/title.txt" "assets/text/<id>.txt written"
out=$(montash -C "$proj" assets show title --json)
assert_json "$out" '.result.asset.text_preview' 'Summer Trip' "text_preview in assets show"
assert_json "$out" '.result.text' 'Summer Trip' "body readable"
out=$(montash -C "$proj" assets set-text title --text "Summer Trip 2026" --json)
assert_json "$out" '.result.asset.text_preview' 'Summer Trip 2026' "set-text updates the body"

section "W-02 removing an asset that is in use"
montash -C "$proj" clip add --asset a --in f:0 --out f:30 --json >/dev/null
out=$(montash -C "$proj" assets remove a --json)
assert_exit 1 "assets remove refuses an asset in use"
assert_json "$out" '.error.code' 'E_ASSET_IN_USE' "E_ASSET_IN_USE reported"
assert_json "$out" '.error.detail.clips[0].id' 'c2' "referencing clips listed (linked audio first)"
assert_json "$out" '.error.detail.clips[1].id' 'c1' "referencing video clip listed"

section "W-02 fonts"
out=$(montash fonts list --json)
assert_exit 0 "fonts list exits 0"
family=$(json_get "$out" '.result.fonts[0].family')
if [ -n "$family" ] && [ "$family" != "null" ]; then
  pass "fonts list returns at least one font"
else
  fail "fonts list returns at least one font" "got: $family"
fi
finish
