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

# docs/13 D-9: `clip add` の `--on-overlap push` と `--ripple` の範囲（docs/04 §6a）
section "W-03 clip add --on-overlap push --ripple"
montash -C "$proj" import "$fixtures/tone.wav" --json >/dev/null || exit 1
montash -C "$proj" track add --kind audio --name A2 --json >/dev/null || exit 1
montash -C "$proj" clip add --asset tone --track A2 --at 0 --duration f:30 --json >/dev/null || exit 1
out=$(montash -C "$proj" clip add --asset a --in f:0 --duration f:15 --at 0 --on-overlap push --ripple=track --json)
assert_exit 0 "clip add --on-overlap push --ripple=track"
assert_json "$out" '.result.clip.start_f' '0' "inserted at the head"
out=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$out" '.result.clips[1].start_f' '15' "the destination track is pushed"
out=$(montash -C "$proj" clip list --track A2 --json)
assert_json "$out" '.result.clips[0].start_f' '0' "--ripple=track leaves the BGM track alone"
out=$(montash -C "$proj" clip add --asset a --in f:0 --duration f:15 --at 0 --on-overlap push --json)
assert_exit 0 "clip add --on-overlap push (default ripple = all tracks)"
out=$(montash -C "$proj" clip list --track A2 --json)
assert_json "$out" '.result.clips[0].start_f' '15' "the default ripple pushes every track"
out=$(montash -C "$proj" validate --json)
assert_json "$out" '.result.ok' 'true' "project valid after the ripple insert"

# docs/13 B-11: `--in -f:30` は yargs が短縮フラグとして読む。`=` 形式を案内する
section "W-03 negative time needs the = form"
out=$(montash -C "$proj" clip add --asset a --in -f:30 --at end --json)
assert_exit 2 "bare --in -f:30 is a usage error"
assert_json "$out" '.error.code' 'E_USAGE' "usage error code"
hint=$(json_get "$out" '.error.hint')
case "$hint" in
  *'--in=-f:30'*) pass "the hint suggests --in=-f:30" ;;
  *) fail "the hint suggests --in=-f:30" "hint: $hint" ;;
esac
out=$(montash -C "$proj" clip add --asset a --in=-f:30 --at end --json)
assert_exit 0 "--in=-f:30 is accepted"
assert_json "$out" '.result.clip.in_f' '120' "negative in is measured from the asset end"
finish
