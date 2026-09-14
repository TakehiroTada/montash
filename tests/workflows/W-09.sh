#!/usr/bin/env bash
# M1: dry-run → concat render → 厳密フレーム検証（3 種の fps）。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1
for fps in 30 29.97 59.94; do
  section "W-09 render at $fps fps"
  proj="$root/project-$fps"
  montash init "$proj" --fps "$fps" --resolution 640x360 --json >/dev/null || exit 1
  montash -C "$proj" import "$fixtures/a.mp4" "$fixtures/b60.mp4" --json >/dev/null || exit 1
  montash -C "$proj" clip add --asset a --in f:3 --duration f:17 --json >/dev/null || exit 1
  montash -C "$proj" clip add --asset b60 --in f:5 --duration f:30 --json >/dev/null || exit 1
  out=$(montash -C "$proj" render --preset web-preview --resolution 160x90 -o "$proj/out/cut.mp4" --dry-run --json)
  assert_exit 0 "dry-run exits 0"
  assert_json "$out" '.result.dry_run' 'true' "dry-run reports plan"
  out=$(montash -C "$proj" render --preset web-preview --resolution 160x90 --preset-speed ultrafast -o "$proj/out/cut.mp4" --progress none --json)
  assert_exit 0 "render exits 0"
  assert_json "$out" '.result.actual_frames' '47' "render is exactly 47 frames"
  assert_file_exists "$proj/out/cut.mp4"
  out=$(montash -C "$proj" render verify "$proj/out/cut.mp4" --json)
  assert_exit 0 "verify exits 0"
  assert_json "$out" '.result.valid' 'true' "streams and timing verified"
done
finish
