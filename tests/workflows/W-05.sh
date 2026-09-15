#!/usr/bin/env bash
# W-05: トランジションを入れる（docs/03 W-05）。
# 一括追加 → 個別変更 → 冒頭／末尾フェード → 一覧 → ハンドル不足 → レンダーとフレーム検証 → undo。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --json >/dev/null || exit 1
# 前後にハンドル（素材の余白）が残る位置で 3 カット並べる（W-03 の成果物に相当）
montash -C "$proj" clip add --asset a --in f:10 --duration f:40 --json >/dev/null || exit 1
montash -C "$proj" clip add --asset a --in f:60 --duration f:40 --json >/dev/null || exit 1
montash -C "$proj" clip add --asset a --in f:105 --duration f:30 --json >/dev/null || exit 1

section "W-05 step 1: add a crossfade at every cut"
out=$(montash -C "$proj" transition add --track V1 --all-cuts --type crossfade --duration 0.5 --json)
assert_exit 0 "transition add --all-cuts"
assert_json "$out" '.result.transitions[0].id' 't1' "first transition is t1"
assert_json "$out" '.result.transitions[0].type' 'fade' "crossfade is stored as the xfade name fade"
assert_json "$out" '.result.transitions[0].duration_f' '15' "0.5s at 30fps is f:15"
assert_json "$out" '.result.transitions[0].mode' 'handle' "handle mode by default"
assert_json "$out" '.result.transitions[1].id' 't2' "second transition is t2"
# handle モードはタイムラインの長さを変えない
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '110' "timeline length is unchanged"

section "W-05 step 2: change one transition"
out=$(montash -C "$proj" transition set t2 --type wipeleft --duration 0.8 --json)
assert_exit 0 "transition set t2"
assert_json "$out" '.result.transition.type' 'wipeleft' "t2 is now wipeleft"
assert_json "$out" '.result.transition.duration_f' '24' "0.8s at 30fps is f:24"

section "W-05 step 3: head and tail fades"
out=$(montash -C "$proj" fade --track V1 --in 1.0 --out 2.0 --with-audio --json)
assert_exit 0 "fade --track V1 --with-audio"
assert_json "$out" '.result.in_f' '30' "fade in is f:30"
assert_json "$out" '.result.out_f' '60' "fade out is f:60"
assert_json "$out" '.result.tracks[1]' 'A1' "--with-audio also fades the linked audio track"

section "W-05 step 4: list"
out=$(montash -C "$proj" transition list --json)
assert_exit 0 "transition list"
assert_json "$out" '.result.transitions[0].from' 'c1' "t1 joins c1 ..."
assert_json "$out" '.result.transitions[0].to' 'c3' "... and c3"
assert_json "$out" '.result.transitions[1].audio' 'crossfade' "linked audio crossfades"

section "W-05 failure: not enough handle"
out=$(montash -C "$proj" transition set t1 --duration 5.0 --json)
assert_exit 1 "insufficient handle exits non-zero"
assert_json "$out" '.error.code' 'E_INSUFFICIENT_HANDLE' "E_INSUFFICIENT_HANDLE reported"
assert_json "$out" '.error.detail.max_duration_f' '121' "hint carries the maximum duration"
out=$(montash -C "$proj" transition list --json)
assert_json "$out" '.result.transitions[0].duration_f' '15' "t1 is unchanged after the failure"

section "W-05 step 5: render and verify the exact frame count"
out=$(montash -C "$proj" render --preset web-preview --resolution 320x180 --preset-speed ultrafast --crf 35 \
  -o "$proj/out/w05.mp4" --progress none --json)
assert_exit 0 "render exits 0"
assert_json "$out" '.result.actual_frames' '110' "xfade output is exactly 110 frames"
assert_file_exists "$proj/out/w05.mp4"
out=$(montash -C "$proj" render verify "$proj/out/w05.mp4" --json)
assert_exit 0 "render verify exits 0"
assert_json "$out" '.result.valid' 'true' "streams and timing verified"

section "W-05 overlap mode shortens the timeline"
out=$(montash -C "$proj" transition remove t2 --json)
assert_exit 0 "transition remove t2"
out=$(montash -C "$proj" transition add --between c3 c5 --type dissolve --duration f:12 --mode overlap --json)
assert_exit 0 "transition add --mode overlap"
assert_json "$out" '.result.transitions[0].mode' 'overlap' "overlap mode stored"
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '98' "timeline shrank by the overlap"
out=$(montash -C "$proj" validate --json)
assert_json "$out" '.result.ok' 'true' "overlap timeline still validates"
# 音声側にも対になるトランジションが置かれる（重なりを許すため。ID は末尾 a）
out=$(montash -C "$proj" transition list --track A1 --json)
assert_json "$out" '.result.transitions[0].id' 't3a' "the linked audio pair gets t3a"
out=$(montash -C "$proj" render --preset web-preview --resolution 320x180 --preset-speed ultrafast --crf 35 \
  -o "$proj/out/w05-overlap.mp4" --progress none --json)
assert_exit 0 "overlap render exits 0"
assert_json "$out" '.result.actual_frames' '98' "overlap render is exactly 98 frames"

section "W-05 undo"
montash -C "$proj" undo --json >/dev/null
assert_exit 0 "undo exits 0"
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '110' "undo restored the length"
out=$(montash -C "$proj" transition list --json)
assert_json "$out" '.result.transitions[1]' 'null' "the overlap transition and its audio pair are gone"

finish
