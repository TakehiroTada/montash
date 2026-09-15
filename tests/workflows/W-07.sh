#!/usr/bin/env bash
# W-07: BGM・音量を整える（docs/03 W-07）。
# BGM トラックを足してタイムライン全長に敷き、音量を下げ、会話でダッキングし、
# 末尾フェード・ラウドネス正規化を設定して書き出すまでを通しで検証する。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

unquote() { printf '%s' "$1" | tr -d '"'; }

# BGM は 200Hz の 2 秒（タイムラインより短い＝`--loop` が無い場合の警告を確かめるため）、
# 会話は 3kHz を 1.0〜2.0 秒だけ（ダッキングの効き目をローパスで測り分けられるようにする）
bgm="$root/bgm.wav"
voice="$root/voice.wav"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=f=200:r=48000:d=2" -ac 2 -c:a pcm_s16le -t 2 "$bgm" || exit 1
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=f=3000:r=48000:d=3,volume='if(between(t,1,2),1,0)':eval=frame" \
  -ac 2 -c:a pcm_s16le -t 3 "$voice" || exit 1

montash init "$proj" --fps 30 --resolution 320x180 --sample-rate 48000 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" "$bgm" "$voice" --json >/dev/null || exit 1
# 映像 3 秒 = 90 フレームと、その上に載せる会話トラック A1
montash -C "$proj" clip add --asset a --in 0 --out 3 --video-only --json >/dev/null || exit 1
montash -C "$proj" clip add --asset voice --track A1 --at 0 --json >/dev/null || exit 1

section "W-07 step 1: BGM 用トラックを足す"
out=$(montash -C "$proj" track add --kind audio --name A2 --json)
assert_exit 0 "track add --kind audio --name A2"
assert_json "$out" '.result.track.id' 'A2' "A2 was created"
assert_json "$out" '.result.track.kind' 'audio' "A2 is an audio track"

section "W-07 step 2: BGM をタイムライン全長に配置する"
# `clip add --loop` は未実装。尺分だけ置いて W_CLIP_SHORTER_THAN_REQUESTED を確認する
out=$(montash -C "$proj" clip add --asset bgm --track A2 --at 0 --duration timeline --json)
assert_exit 0 "clip add --track A2 --duration timeline"
bgm_clip=$(unquote "$(json_get "$out" '.result.clip.id')")
assert_json "$out" '.warnings[0].code' 'W_CLIP_SHORTER_THAN_REQUESTED' "a BGM shorter than the timeline warns"
assert_json "$out" '.result.clip.out_f' '60' "the BGM covers its own 2 seconds"
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '90' "the timeline is still 90 frames"

section "W-07 step 3: BGM の音量を下げる"
out=$(montash -C "$proj" audio gain --clip "$bgm_clip" --db=-12 --json)
assert_exit 0 "audio gain --db=-12"
assert_json "$out" '.result.gain_db' '-12' "the BGM clip is 12 dB down"
assert_json "$out" '.result.previous_db' '0' "the previous gain is reported"

section "W-07 step 4: 会話トラックを基準にダッキングする"
out=$(montash -C "$proj" audio duck --target A2 --sidechain A1 --threshold=-30dB --ratio 8 --release 0.5 --json)
assert_exit 0 "audio duck --target A2 --sidechain A1"
duck_id=$(unquote "$(json_get "$out" '.result.added.id')")
assert_json "$out" '.result.added.target' 'A2' "A2 is ducked"
assert_json "$out" '.result.added.sidechain' 'A1' "A1 drives the ducking"
assert_json "$out" '.result.added.threshold_db' '-30' "the threshold is kept in dB"
assert_json "$out" '.result.added.release_ms' '500' "--release 0.5 is read as 500ms"

section "W-07 step 5: 末尾のフェードアウト"
out=$(montash -C "$proj" audio fade --clip "$bgm_clip" --out 2.0 --json)
assert_exit 0 "audio fade --out 2.0"
assert_json "$out" '.result.fade.out_f' '60' "the fade is 60 frames"

section "W-07 step 6: ラウドネス正規化をレンダー設定に入れる"
out=$(montash -C "$proj" audio normalize --loudness=-14 --true-peak=-1 --json)
assert_exit 0 "audio normalize --loudness=-14"
assert_json "$out" '.result.normalize.enabled' 'true' "normalization is on"
assert_json "$out" '.result.normalize.i' '-14' "the target is -14 LUFS"

section "W-07 audio offset（サンプル単位の同期補正）"
# リンクされたクリップ（映像＋音声の対）にはサンプル単位のずらしを掛けられない
montash -C "$proj" clip add --asset a --in 3 --out 4 --at end --json >/dev/null || exit 1
linked=$(unquote "$(json_get "$(montash -C "$proj" clip list --track A1 --json)" '.result.clips[1].id')")
out=$(montash -C "$proj" audio offset --clip "$linked" --by s:-960 --json)
assert_exit 1 "offsetting a linked clip fails"
assert_json "$out" '.error.code' 'E_CLIP_LINKED' "E_CLIP_LINKED"
montash -C "$proj" undo --json >/dev/null || exit 1
out=$(montash -C "$proj" audio offset --clip "$bgm_clip" --by s:-960 --json)
assert_exit 0 "audio offset --by s:-960"
assert_json "$out" '.result.offset_smp' '-960' "the offset is stored in samples"
out=$(montash -C "$proj" audio offset --clip "$bgm_clip" --set s:0 --json)
assert_json "$out" '.result.offset_smp' '0' "--set replaces the offset"

section "W-07 audio show / analyze"
out=$(montash -C "$proj" audio show --json)
assert_exit 0 "audio show"
assert_json "$out" '.op' 'null' "audio show records no op"
assert_json "$out" '.result.normalize.i' '-14' "show reports the normalization target"
assert_json "$out" '.result.ducking[0].id' "$duck_id" "show reports the ducking"
assert_json "$out" '.result.tracks[1].gain_db' '0' "A2 has no track gain"
assert_json "$out" '.result.tracks[1].clips[0].gain_db' '-12' "show reports the BGM clip gain"
assert_json "$out" '.result.tracks[1].clips[0].fade.out_f' '60' "show reports the BGM fade"

out=$(montash -C "$proj" audio analyze A1 --json)
assert_exit 0 "audio analyze A1"
assert_json "$out" '.result.target.kind' 'track' "analyze reports the target kind"
lufs=$(json_get "$out" '.result.integrated_lufs')
if awk -v v="$lufs" 'BEGIN { exit !(v + 0 < 0 && v != "null") }'; then
  pass "analyze returns an integrated loudness ($lufs LUFS)"
else
  fail "analyze returns an integrated loudness" "got: $lufs"
fi

section "W-07 step 7: 音声だけのプレビュー"
out=$(montash -C "$proj" preview build --audio-only --height 90 --json)
assert_exit 0 "preview build --audio-only"
assert_json "$out" '.result.audio_only' 'true' "audio-only build reported"
assert_file_exists "$proj/.montash/preview/audio.m4a" "audio.m4a was rendered"

section "W-07 render: ダッキングと正規化を適用して書き出す"
out=$(montash -C "$proj" render -o "$proj/out.mp4" --preset web-preview --crf 40 --preset-speed ultrafast --json)
assert_exit 0 "render"
assert_json "$out" '.result.valid' 'true' "render verified itself"
assert_json "$out" '.result.actual_frames' '90' "the render is 90 frames"
assert_json "$out" '.result.loudnorm.passes' '2' "loudnorm ran in two passes"
measured=$(json_get "$out" '.result.loudnorm.measured.input_i')
if [ -n "$measured" ] && [ "$measured" != "null" ]; then
  pass "pass 1 measured the timeline ($measured LUFS)"
else
  fail "pass 1 measured the timeline" "got: $measured"
fi

out=$(montash -C "$proj" render verify "$proj/out.mp4" --json)
assert_exit 0 "render verify"
assert_json "$out" '.result.valid' 'true' "frame count, fps and audio duration match"

# 出力の統合ラウドネスが目標（-14 LUFS）付近に収まっているか
rendered=$(ffmpeg -hide_banner -nostats -i "$proj/out.mp4" -vn -af ebur128=peak=true -f null - 2>&1 |
  awk '/^ *I: /{v=$2} END{print v}')
if awk -v v="$rendered" 'BEGIN { exit !(v + 0 > -15.5 && v + 0 < -12.5) }'; then
  pass "the render is normalized to about -14 LUFS ($rendered)"
else
  fail "the render is normalized to about -14 LUFS" "got: $rendered"
fi

section "W-07 undo"
montash -C "$proj" undo --json >/dev/null || exit 1
out=$(montash -C "$proj" audio show --json)
assert_json "$out" '.result.tracks[1].clips[0].offset_smp' '-960' "undo restored the previous audio offset"
out=$(montash -C "$proj" validate --json)
assert_json "$out" '.result.ok' 'true' "invariants still hold"

section "W-07 失敗時の扱い"
out=$(montash -C "$proj" audio duck --target A2 --sidechain A2 --json)
assert_exit 2 "ducking a track with itself is a usage error"
out=$(montash -C "$proj" audio duck remove "$duck_id" --json)
assert_exit 0 "audio duck remove"
out=$(montash -C "$proj" audio show --json)
assert_json "$out" '.result.ducking' '[]' "the ducking is gone"
out=$(montash -C "$proj" audio duck remove "$duck_id" --json)
assert_exit 1 "removing it twice fails"
assert_json "$out" '.error.code' 'E_DUCKING_NOT_FOUND' "E_DUCKING_NOT_FOUND"

section "W-07 ダッキングの効果（有り／無しの比較）"
# ダッキングが効いているか: BGM（200Hz）をローパスで取り出し、ダッキング有り／無しの
# 同じレンダーどうしで会話区間の音量を比べる（フェードの影響を両者で相殺する）
bgm_level() {
  ffmpeg -hide_banner -nostats -ss "$2" -t "$3" -i "$1" -vn \
    -af "lowpass=f=600,lowpass=f=600,volumedetect" -f null - 2>&1 |
    awk -F': ' '/mean_volume:/ { split($2, a, " "); v = a[1] } END { print v }'
}
# ダッキングを外した以外は同じ設定でもう 1 本書き出す（オフセットも out.mp4 と揃える）
montash -C "$proj" audio offset --clip "$bgm_clip" --set s:0 --json >/dev/null || exit 1
montash -C "$proj" render -o "$proj/plain.mp4" --preset web-preview --crf 40 --preset-speed ultrafast --json >/dev/null || exit 1

ducked_speech=$(bgm_level "$proj/out.mp4" 1.05 0.8)
plain_speech=$(bgm_level "$proj/plain.mp4" 1.05 0.8)
ducked_quiet=$(bgm_level "$proj/out.mp4" 0.05 0.5)
plain_quiet=$(bgm_level "$proj/plain.mp4" 0.05 0.5)
if awk -v d="$ducked_speech" -v p="$plain_speech" 'BEGIN { exit !(p + 0 - (d + 0) > 4) }'; then
  pass "the BGM is ducked while the dialogue plays ($plain_speech dB -> $ducked_speech dB)"
else
  fail "the BGM is ducked while the dialogue plays" "plain: $plain_speech  ducked: $ducked_speech"
fi
if awk -v d="$ducked_quiet" -v p="$plain_quiet" 'BEGIN { exit !(((d + 0) - (p + 0)) ^ 2 < 2.25) }'; then
  pass "the BGM keeps its level where nobody speaks ($plain_quiet dB -> $ducked_quiet dB)"
else
  fail "the BGM keeps its level where nobody speaks" "plain: $plain_quiet  ducked: $ducked_quiet"
fi


finish
