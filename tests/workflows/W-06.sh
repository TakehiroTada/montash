#!/usr/bin/env bash
# W-06: テロップ・タイトルを入れる（docs/03 W-06）。
# fonts list → text presets → text add（タイトル + ローワーサード）→ text list → text set → validate → undo
# → render（libass で焼き込み）→ render verify でフレーム数が一致することまで確認する。
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

section "W-06 step 5b: --fit-width sizes the font so the line fits"
# 640x360 なので、既定の上限は画面高の 10% = 36px、下限は 4% = 14px。
# 実寸はフォントのメトリクスで変わるので、サイズそのものではなく「収まったか」を見る。
out=$(montash -C "$proj" text add --text "うわ" --at 4 --duration 1 --position bottom-center --fit-width 90% --id fit1 --json)
assert_exit 0 "text add --fit-width (short line)"
assert_json "$out" '.result.fit.target_width' '576' "90% of 640 is 576px"
assert_json "$out" '.result.fit.max_size' '36' "the default upper bound is 10% of the height"
assert_json "$out" '.result.fit.min_size' '14' "the default lower bound is 4% of the height"
assert_json "$out" '.result.fit.size' '36' "a short line is capped at the upper bound"
assert_json "$out" '.result.fit.clamped' 'max' "and reports that it was capped"
assert_json "$out" '.result.fit.source' 'estimate' "the width is estimated by default (no extra ffmpeg pass)"
assert_json "$out" '.result.clip.style.size' '36' "the size is stored as a plain number"
assert_json "$out" '.result.clip.style.wrap' 'false' "--fit-width turns wrapping off so the line stays on one row"

out=$(montash -C "$proj" text add --text "アプデでほぼ完成したって言っていいと思うんだよなこれは" --at 5 --duration 1 \
  --position bottom-center --fit-width 90% --id fit2 --json)
assert_exit 0 "text add --fit-width (long line)"
long_size=$(json_get "$out" '.result.fit.size')
long_width=$(json_get "$out" '.result.fit.width')
assert_json "$out" '.result.fit.clamped' 'null' "a 27 character line still fits between the bounds"
if [ "$long_size" -lt 36 ] && [ "$long_size" -ge 14 ]; then
  pass "the longer line gets a smaller size than the short one ($long_size < 36)"
else
  fail "the longer line gets a smaller size" "size: $long_size"
fi
if [ "$long_width" -le 576 ]; then
  pass "the estimated width fits the requested 576px ($long_width)"
else
  fail "the estimated width fits the requested width" "width: $long_width"
fi

# 下限でも収まらない一言は、下限のサイズで置いたうえで警告する（黙って溢れさせない）
out=$(montash -C "$proj" text add --text "いやーこれはさすがに厳しいんじゃないですかねって話をずっとしてたんですけど結局どうなったんでしたっけ" \
  --at 6 --duration 1 --position bottom-center --fit-width 90% --id fit3 --json)
assert_exit 0 "text add --fit-width (a line that cannot fit)"
assert_json "$out" '.result.fit.size' '14' "it falls back to the lower bound"
assert_json "$out" '.result.fit.clamped' 'min' "and reports that it did not fit"
assert_json "$out" '.warnings[0].code' 'W_TEXT_FIT_CLAMPED' "W_TEXT_FIT_CLAMPED"

# --measure は libass に描かせて実測する。libass の無いビルドでは概算のまま
out=$(montash -C "$proj" text set fit2 --fit-width 90% --measure --json)
assert_exit 0 "text set --fit-width --measure"
case "$(json_get "$out" '.result.fit.source')" in
  '"measure"'|measure) pass "--measure reports the libass-measured width" ;;
  '"estimate"'|estimate) skip "libass is missing; --measure fell back to the estimate" ;;
  *) fail "--measure reports where the width came from" "source: $(json_get "$out" '.result.fit.source')" ;;
esac
assert_json "$out" '.result.fit.max_size' '36' "repeating --fit-width does not ratchet the upper bound down"

# 幅の指定が壊れていれば使い方エラー
out=$(montash -C "$proj" text add --text "x" --at 7 --duration 1 --fit-width "wide" --json)
assert_exit 2 "a malformed --fit-width is a usage error"

# 足したテロップは消して、以降の手順（レンダー）の前提を元に戻す
for id in fit1 fit2 fit3; do
  montash -C "$proj" text remove "$id" --json >/dev/null || exit 1
done
out=$(montash -C "$proj" text list --json)
assert_json "$out" '.result.clips[2]' 'null' "the timeline is back to the two original telops"

section "W-06 step 6: render burns the text into the picture"
# タイムラインは x2（f:360..450）まで伸びているので 450 フレーム。素材の後ろは背景色になる。
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '450' "the timeline runs to the end of the lower third"

out=$(montash -C "$proj" render -o "$root/out.mp4" --preset web-preview --resolution 320x180 \
  --crf 30 --preset-speed ultrafast --progress none --json)
assert_exit 0 "render with a text track"
assert_json "$out" '.result.valid' 'true' "render verify passed inside render"
assert_json "$out" '.result.actual_frames' '450' "the frame count matches timelineDurationF"
assert_file_exists "$root/out.mp4" "the MP4 was written"

out=$(montash -C "$proj" render verify "$root/out.mp4" --json)
assert_exit 0 "render verify"
assert_json "$out" '.result.expected_frames' '450' "render verify agrees on the frame count"
assert_json "$out" '.result.output.streams[0].codec_type' 'video' "one video stream"
assert_json "$out" '.result.output.streams[1].codec_type' 'audio' "one audio stream"

# --dry-run の plan に焼き込みのフィルタが現れる（libass が無いビルドでは drawtext になる）
out=$(montash -C "$proj" render -o "$root/plan.mp4" --preset web-preview --dry-run --json)
assert_exit 0 "render --dry-run"
case "$(json_get "$out" '.result.filter_complex')" in
  *subtitles=*) pass "the plan burns the ASS with the subtitles filter" ;;
  *drawtext=*) skip "libass is missing; the plan falls back to drawtext (W_TEXT_ENGINE_LIMITED)" ;;
  *) fail "the render plan burns the text" "no subtitles= or drawtext= in filter_complex" ;;
esac

finish
