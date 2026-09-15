#!/usr/bin/env bash
# W-14: 字幕ファイルを付ける（docs/03 W-14、docs/04 §12、docs/07 §7）。
# import（SRT）→ subtitle add --mode burn → render → render verify →
# subtitle set --mode soft → render で音声／映像／字幕の 3 ストリームになることまで確認する。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --json >/dev/null || exit 1
# 5 秒の映像を 1 本置く（字幕を載せる土台。150 フレーム）
montash -C "$proj" clip add --asset a --in 0 --out 5 --at 0 --json >/dev/null || exit 1

section "W-14 step 1: import the SRT"
out=$(montash -C "$proj" import "$fixtures/ja.srt" --json)
assert_exit 0 "import ja.srt"
assert_json "$out" '.result.imported[0].id' 'ja' "the subtitle asset is registered"
assert_json "$out" '.result.imported[0].type' 'subtitle' "it is a subtitle asset"
assert_json "$out" '.result.imported[0].format' 'srt' "the format is detected from the extension"

section "W-14 step 2: burn it in"
out=$(montash -C "$proj" subtitle add --asset ja --mode burn --size 40 --margin-bottom 60 --lang ja --json)
assert_exit 0 "subtitle add --mode burn"
assert_json "$out" '.result.track_created' 'T1' "T1 was created automatically"
assert_json "$out" '.result.clip.id' 's1' "the first subtitle clip is s1"
assert_json "$out" '.result.clip.mode' 'burn' "burn mode"
assert_json "$out" '.result.clip.format' 'srt' "the clip knows the asset format"
assert_json "$out" '.result.clip.style.size' '40' "--size is stored"
assert_json "$out" '.result.clip.style.margin_bottom' '60' "--margin-bottom is stored"
assert_json "$out" '.result.clip.offset_f' '0' "no offset by default"

out=$(montash -C "$proj" subtitle list --json)
assert_exit 0 "subtitle list"
assert_json "$out" '.result.clips[0].id' 's1' "s1 is listed"
assert_json "$out" '.result.clips[0].track' 'T1' "it sits on T1"
assert_json "$out" '.op' 'null' "listing records no op"

out=$(montash -C "$proj" validate --json)
assert_json "$out" '.result.ok' 'true' "invariants hold"

section "W-14 step 3: render the burned-in subtitles"
# 字幕クリップは尺を持たないので、タイムラインは素材の 150 フレームのまま
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '150' "the subtitle clip does not extend the timeline"

out=$(montash -C "$proj" render -o "$root/burned.mp4" --preset web-preview --resolution 320x180 \
  --crf 30 --preset-speed ultrafast --progress none --json)
assert_exit 0 "render with burned-in subtitles"
assert_json "$out" '.result.valid' 'true' "render verify passed inside render"
assert_json "$out" '.result.actual_frames' '150' "the frame count matches timelineDurationF"

out=$(montash -C "$proj" render verify "$root/burned.mp4" --json)
assert_exit 0 "render verify"
assert_json "$out" '.result.expected_frames' '150' "render verify agrees on the frame count"
assert_json "$out" '.result.output.streams[0].codec_type' 'video' "video stream"
assert_json "$out" '.result.output.streams[1].codec_type' 'audio' "audio stream"
assert_json "$out" '.result.output.streams[2]' 'null' "burned-in subtitles add no stream"

section "W-14 step 4: switch to soft subtitles (muxed)"
out=$(montash -C "$proj" subtitle set s1 --mode soft --lang ja --json)
assert_exit 0 "subtitle set --mode soft"
assert_json "$out" '.result.clip.mode' 'soft' "soft mode"
assert_json "$out" '.result.clip.lang' 'ja' "the language is stored"

out=$(montash -C "$proj" render -o "$root/soft.mp4" --preset web-preview --resolution 320x180 \
  --crf 30 --preset-speed ultrafast --progress none --json)
assert_exit 0 "render with soft subtitles"
assert_json "$out" '.result.actual_frames' '150' "the frame count is unchanged"
assert_json "$out" '.result.output.streams[0].codec_type' 'video' "1/3: video"
assert_json "$out" '.result.output.streams[1].codec_type' 'audio' "2/3: audio"
assert_json "$out" '.result.output.streams[2].codec_type' 'subtitle' "3/3: the muxed subtitle track"
assert_json "$out" '.result.output.streams[2].codec_name' 'mov_text' "MP4 carries subtitles as mov_text"

section "W-14 step 5: offset and undo"
out=$(montash -C "$proj" subtitle set s1 --offset +0.5 --json)
assert_exit 0 "subtitle set --offset"
assert_json "$out" '.result.clip.offset_f' '15' "+0.5s is stored as 15 frames"
montash -C "$proj" undo --json >/dev/null || exit 1
out=$(montash -C "$proj" subtitle list --json)
assert_json "$out" '.result.clips[0].offset_f' '0' "undo restores the offset"

section "W-14 failure handling"
out=$(montash -C "$proj" subtitle add --asset a --mode burn --json)
assert_exit 1 "a video asset is not a subtitle"
assert_json "$out" '.error.code' 'E_ASSET_TYPE_MISMATCH' "E_ASSET_TYPE_MISMATCH"
out=$(montash -C "$proj" subtitle add --asset nope --json)
assert_exit 1 "an unknown asset fails"
assert_json "$out" '.error.code' 'E_ASSET_NOT_FOUND' "E_ASSET_NOT_FOUND"
out=$(montash -C "$proj" subtitle remove s9 --json)
assert_exit 1 "removing an unknown clip fails"
assert_json "$out" '.error.code' 'E_CLIP_NOT_FOUND' "E_CLIP_NOT_FOUND"

out=$(montash -C "$proj" subtitle remove s1 --json)
assert_exit 0 "subtitle remove"
out=$(montash -C "$proj" subtitle list --json)
assert_json "$out" '.result.clips[0]' 'null' "no subtitle clips are left"

finish
