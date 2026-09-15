#!/usr/bin/env bash
# W-08: ロゴ・PiP・画像を重ねる（docs/03 W-08、docs/04 §10、docs/07 §5）。
# track add → overlay add → overlay list → render → render verify → 右上が変わったことを画素で確認 → undo。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

# 画素の比較に ffmpeg を直接使う（make-fixtures.sh と同じ探索順）
if [ -n "${MONTASH_FFMPEG:-}" ]; then
  FFMPEG="$MONTASH_FFMPEG"
elif [ -x "$HOME/.local/share/montash/ffmpeg/bin/ffmpeg" ]; then
  FFMPEG="$HOME/.local/share/montash/ffmpeg/bin/ffmpeg"
else
  FFMPEG=$(command -v ffmpeg || true)
fi

# avg_luma <file> <crop=w:h:x:y>  切り出した領域を 1x1 に面積平均して輝度（0..255）を返す
avg_luma() {
  "$FFMPEG" -v error -nostdin -i "$1" -vf "crop=$2,scale=1:1:flags=area,format=gray" \
    -frames:v 1 -f rawvideo - 2>/dev/null | od -An -tu1 | tr -d ' \n'
}

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" "$fixtures/logo.png" --json >/dev/null || exit 1
montash -C "$proj" clip add --asset a --in f:0 --duration f:60 --json >/dev/null || exit 1

section "W-08 baseline render (no overlay)"
out=$(montash -C "$proj" render --preset web-preview --resolution 640x360 --preset-speed ultrafast \
  -o "$proj/out/base.mp4" --progress none --json)
assert_exit 0 "baseline render exits 0"
assert_json "$out" '.result.actual_frames' '60' "baseline is 60 frames"

section "W-08 add an overlay track and a logo"
out=$(montash -C "$proj" track add --kind video --name V2 --json)
assert_exit 0 "track add --kind video --name V2 exits 0"
assert_json "$out" '.result.track.kind' 'video' "V2 is a video track"
out=$(montash -C "$proj" overlay add --asset logo --track V2 --at 0 --duration timeline \
  --position top-right --scale 0.12 --opacity 0.9 --json)
assert_exit 0 "overlay add exits 0"
assert_json "$out" '.result.overlay.track' 'V2' "overlay lands on V2"
assert_json "$out" '.result.overlay.start_f' '0' "overlay starts at f:0"
assert_json "$out" '.result.overlay.end_f' '60' "--duration timeline covers the whole timeline"
assert_json "$out" '.result.overlay.transform.position' 'top-right' "position preset stored"
assert_json "$out" '.result.overlay.transform.scale' '0.12' "scale stored"
assert_json "$out" '.result.overlay.opacity' '0.9' "opacity stored"
overlay_id=$(json_get "$out" '.result.overlay.id' | tr -d '"')

out=$(montash -C "$proj" overlay list --json)
assert_exit 0 "overlay list exits 0"
assert_json "$out" '.result.overlays[0].id' "$overlay_id" "overlay listed"
assert_json "$out" '.result.overlays[0].asset' 'logo' "listed with its asset"

section "W-08 render with the overlay"
out=$(montash -C "$proj" render --preset web-preview --resolution 640x360 --preset-speed ultrafast \
  -o "$proj/out/with.mp4" --progress none --json)
assert_exit 0 "render exits 0"
assert_json "$out" '.result.actual_frames' '60' "overlay render is still 60 frames"
out=$(montash -C "$proj" render verify "$proj/out/with.mp4" --json)
assert_exit 0 "render verify exits 0"
assert_json "$out" '.result.valid' 'true' "streams and frame count verified"
assert_json "$out" '.result.expected_frames' '60' "expected frame count matches the timeline"

section "W-08 the top-right corner actually changed"
if [ -z "$FFMPEG" ]; then
  skip "pixel comparison" "ffmpeg not found"
else
  # 640x360 に 256x128 を 0.12 倍 → 30x16 くらい。余裕をみて右上 40x24 を比べる
  corner="40:24:600:0"
  base_luma=$(avg_luma "$proj/out/base.mp4" "$corner")
  over_luma=$(avg_luma "$proj/out/with.mp4" "$corner")
  # 対照として左下は変わらないこと
  base_other=$(avg_luma "$proj/out/base.mp4" "40:24:0:336")
  over_other=$(avg_luma "$proj/out/with.mp4" "40:24:0:336")
  if [ -z "$base_luma" ] || [ -z "$over_luma" ]; then
    fail "top-right luma is readable" "base=$base_luma overlay=$over_luma"
  else
    diff=$((base_luma - over_luma))
    [ "$diff" -lt 0 ] && diff=$((-diff))
    if [ "$diff" -ge 4 ]; then
      pass "top-right differs from the source (|$base_luma - $over_luma| = $diff)"
    else
      fail "top-right differs from the source" "base=$base_luma overlay=$over_luma diff=$diff"
    fi
    other_diff=$((base_other - over_other))
    [ "$other_diff" -lt 0 ] && other_diff=$((-other_diff))
    if [ "$other_diff" -le 2 ]; then
      pass "bottom-left is untouched (|$base_other - $over_other| = $other_diff)"
    else
      fail "bottom-left is untouched" "base=$base_other overlay=$over_other diff=$other_diff"
    fi
  fi
fi

section "W-08 adjust and undo"
out=$(montash -C "$proj" overlay set "$overlay_id" --position bottom-right --margin 16 --json)
assert_exit 0 "overlay set exits 0"
assert_json "$out" '.result.overlay.transform.position' 'bottom-right' "position changed"
assert_json "$out" '.result.overlay.transform.margin' '16' "margin changed"
out=$(montash -C "$proj" undo --json)
assert_exit 0 "undo exits 0"
out=$(montash -C "$proj" overlay list --json)
assert_json "$out" '.result.overlays[0].transform.position' 'top-right' "undo restores the previous position"
out=$(montash -C "$proj" overlay remove "$overlay_id" --json)
assert_exit 0 "overlay remove exits 0"
out=$(montash -C "$proj" overlay list --json)
assert_json "$out" '.result.overlays' '[]' "no overlays left"
out=$(montash -C "$proj" undo --json)
assert_exit 0 "undo exits 0"
out=$(montash -C "$proj" overlay list --json)
assert_json "$out" '.result.overlays[0].id' "$overlay_id" "undo brings the overlay back"

finish
