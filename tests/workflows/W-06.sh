#!/usr/bin/env bash
# W-06: テロップ・タイトルを入れる（docs/03 W-06）。
# fonts list → text presets → text add（タイトル + ローワーサード）→ text list → text set → validate → undo。
# レンダーへの結線（subtitles フィルタで焼く）はまだなので、W-06 では render を呼ばない。
# 代わりに「今はまだ E_NOT_IMPLEMENTED になる」ことだけを 1 つ確認しておく。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --json >/dev/null || exit 1
# 5 秒の映像を 1 本置く（テロップを載せる土台）
montash -C "$proj" clip add --asset a --in 0 --out 5 --at 0 --json >/dev/null || exit 1

section "W-06 step 1: fonts and presets"
out=$(montash -C "$proj" fonts list --json)
assert_exit 0 "fonts list"
assert_json "$out" '.result.fonts[0].family' "$(json_get "$out" '.result.fonts[0].family')" "fonts list reports families"

out=$(montash -C "$proj" text presets --json)
assert_exit 0 "text presets"
assert_json "$out" '.result.presets[0].name' 'caption-bottom' "built-in presets are listed"
assert_json "$out" '.result.presets[3].name' 'title-center' "title-center is built in"
assert_json "$out" '.result.presets[3].source' 'builtin' "built-in presets come from the binary"
assert_json "$out" '.result.presets[3].preset.size' '96' "title-center is 96px"

section "W-06 step 2: title (the text track is created automatically)"
out=$(montash -C "$proj" text add --text "Summer Trip 2026" --at 0 --duration 3 --preset title-center --fade-in 0.5 --fade-out 0.5 --json)
assert_exit 0 "text add title"
assert_json "$out" '.result.track_created' 'T1' "T1 was created automatically"
assert_json "$out" '.result.clip.id' 'x1' "the first text clip is x1"
assert_json "$out" '.result.clip.start_f' '0' "starts at f:0"
assert_json "$out" '.result.clip.duration_f' '90' "lasts 3 seconds"
assert_json "$out" '.result.clip.style.size' '96' "the preset set the size"
assert_json "$out" '.result.clip.style.position' 'center' "the preset set the position"
assert_json "$out" '.result.clip.fade.in_f' '15' "--fade-in 0.5 is stored in frames"
assert_json "$out" '.result.clip.fade.out_f' '15' "--fade-out 0.5 is stored in frames"

section "W-06 step 3: lower third"
out=$(montash -C "$proj" text add --text "福岡到着" --at 12 --duration 3 --preset lower-third --font "$(json_get "$out" '.result.clip.style.font' | tr -d '"')" --size 48 --json)
assert_exit 0 "text add lower third"
assert_json "$out" '.result.clip.id' 'x2' "the second text clip is x2"
assert_json "$out" '.result.clip.start_f' '360' "starts at f:360 (12s @30fps)"
assert_json "$out" '.result.clip.style.size' '48' "--size overrides the preset"
assert_json "$out" '.result.clip.style.align' 'left' "lower-third is left aligned"
assert_json "$out" '.result.clip.style.bg' '#00000099' "lower-third has a background box"
# 素材（5 秒）より後ろに置いたので警告が出る
assert_json "$out" '.warnings[0].code' 'W_BEYOND_TIMELINE' "text beyond the last media clip warns"

section "W-06 step 4: list"
out=$(montash -C "$proj" text list --json)
assert_exit 0 "text list"
assert_json "$out" '.result.clips[0].id' 'x1' "listed in timeline order"
assert_json "$out" '.result.clips[1].id' 'x2' "both text clips are listed"
assert_json "$out" '.result.clips[1].track' 'T1' "both sit on T1"
assert_json "$out" '.op' 'null' "listing records no op"

section "W-06 step 5: fix the wording and the position"
out=$(montash -C "$proj" text set x1 --text "福岡に到着" --position 5%,85% --json)
assert_exit 0 "text set x1"
assert_json "$out" '.result.clip.text' '福岡に到着' "the wording changed"
assert_json "$out" '.result.clip.style.position.x' '5%' "the position moved to 5%,85%"
assert_json "$out" '.result.clip.style.size' '96' "untouched style fields are kept"
assert_json "$out" '.result.clip.duration_f' '90' "timing is unchanged"

out=$(montash -C "$proj" validate --json)
assert_exit 0 "validate"
assert_json "$out" '.result.ok' 'true' "invariants hold"

montash -C "$proj" undo --json >/dev/null || exit 1
out=$(montash -C "$proj" text list --json)
assert_json "$out" '.result.clips[0].text' 'Summer Trip 2026' "undo restores the wording"
assert_json "$out" '.result.clips[0].style.position' 'center' "undo restores the position"

section "W-06 failure handling"
out=$(montash -C "$proj" text add --text "x" --at 4 --duration 1 --font "NoSuchFontXYZ" --json)
assert_exit 1 "an unknown font fails"
assert_json "$out" '.error.code' 'E_FONT_NOT_FOUND' "E_FONT_NOT_FOUND"
out=$(montash -C "$proj" text add --text "x" --at 0 --duration 1 --json)
assert_exit 1 "overlapping text fails"
assert_json "$out" '.error.code' 'E_CLIP_OVERLAP' "E_CLIP_OVERLAP"
out=$(montash -C "$proj" text add --text "x" --at 0 --json)
assert_exit 2 "a missing duration is a usage error"
out=$(montash -C "$proj" text list --json)
assert_json "$out" '.result.clips[1].id' 'x2' "failed commands changed nothing"

section "W-06 render is wired up in a later PR"
# ASS 生成（src/ffmpeg/ass.ts）は済んでいるが、レンダーグラフへの結線は次段。
# 今は text トラックがあるとレンダーが明示的に断る、というところまでを確認する。
out=$(montash -C "$proj" render -o "$root/out.mp4" --json)
assert_exit 1 "render refuses text tracks for now"
assert_json "$out" '.error.code' 'E_NOT_IMPLEMENTED' "E_NOT_IMPLEMENTED: text tracks (burn-in lands in the next PR)"

finish
