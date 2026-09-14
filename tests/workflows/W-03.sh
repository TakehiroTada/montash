#!/usr/bin/env bash
# M1: カット範囲指定 → リンク配置 → タイムライン → 検証・履歴移動。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1
montash init "$proj" --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" "$fixtures/b60.mp4" --json >/dev/null || exit 1

section "W-03 trim and append"
out=$(montash -C "$proj" clip add --asset a --in 1 --out 3 --at end --json)
assert_exit 0 "first clip added"
assert_json "$out" '.result.clip.id' 'c1' "primary clip ID"
assert_json "$out" '.result.linked_clip.id' 'c2' "linked audio ID"
assert_json "$out" '.result.clip.in_f' '30' "in is project frames"
out=$(montash -C "$proj" clip add --asset b60 --in=-1 --at end --json)
assert_exit 0 "tail of second source added"
assert_json "$out" '.result.clip.start_f' '60' "append to track end"
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '90' "three seconds total"
out=$(montash -C "$proj" validate --json)
assert_exit 0 "timeline valid"
out=$(montash -C "$proj" commit -m "two cuts" --json)
assert_exit 0 "commit edits"
montash -C "$proj" undo --json >/dev/null || exit 1
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '60' "undo restores prior timeline"
montash -C "$proj" redo --json >/dev/null || exit 1
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '90' "redo restores second cut"
finish
