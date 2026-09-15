#!/usr/bin/env bash
# W-04: プレビューで確認して微調整する（docs/03 W-04）。
# ここは編集操作（clip list/trim/move/split/delete, timeline gaps, undo, validate）を検証する。
# プレビュー（preview build / serve / ブラウザ再生）の検証は別セクションで追加される。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

unquote() { printf '%s' "$1" | tr -d '"'; }

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --json >/dev/null || exit 1

section "W-04 rough cut to adjust (W-03 の続き)"
montash -C "$proj" clip add --asset a --in 0 --out 2 --at end --json >/dev/null || exit 1
montash -C "$proj" clip add --asset a --in 2 --out 3 --at end --json >/dev/null || exit 1
montash -C "$proj" clip add --asset a --in 3 --out 4 --at end --json >/dev/null || exit 1

# 3: 曖昧な指示（「2 番目」）を ID に解決する
out=$(montash -C "$proj" clip list --track V1 --json)
assert_exit 0 "clip list --track V1"
assert_json "$out" '.result.clips[0].id' 'c1' "first clip is c1"
assert_json "$out" '.result.clips[1].id' 'c3' "second clip is c3 (linked audio takes c2)"
assert_json "$out" '.result.clips[2].start_f' '90' "third clip starts at f:90"

section "W-04 step 4: trim the head with ripple"
# 4: 頭を 0.5 秒（30fps で 15 フレーム）トリムし、後続を全トラックで詰める
out=$(montash -C "$proj" clip trim c1 --in +0.5 --ripple --json)
assert_exit 0 "clip trim c1 --in +0.5 --ripple"
assert_json "$out" '.result.delta_f' '-15' "clip is 15 frames shorter"
assert_json "$out" '.result.clip.end_f' '45' "c1 now ends at f:45"
assert_json "$out" '.result.linked_clip.id' 'c2' "linked audio follows"
out=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$out" '.result.clips[1].start_f' '45' "c3 moved 15 frames earlier"
assert_json "$out" '.result.clips[2].start_f' '75' "c5 moved 15 frames earlier"
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '105' "timeline shrank by 15 frames"

section "W-04 step 5: reorder clips"
# 5: クリップの順序入れ替え（移動元を詰め、移動先を押し出す）
out=$(montash -C "$proj" clip move c5 --before c3 --ripple --json)
assert_exit 0 "clip move c5 --before c3 --ripple"
assert_json "$out" '.result.clip.start_f' '45' "c5 took c3's place"
out=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$out" '.result.clips[1].id' 'c5' "V1 order is c1, c5, c3"
assert_json "$out" '.result.clips[2].id' 'c3' "c3 moved after c5"
out=$(montash -C "$proj" clip list --track A1 --json)
assert_json "$out" '.result.clips[1].id' 'c6' "linked audio kept the same order"

section "W-04 step 6: split, then ripple delete the unwanted half"
# 6: 特定時刻で分割する。前半は c1 のまま、後半だけ新規採番（ADR-12）
out=$(montash -C "$proj" clip split c1 --at f:30 --json)
assert_exit 0 "clip split c1 --at f:30"
assert_json "$out" '.result.kept.id' 'c1' "the first half keeps its ID"
assert_json "$out" '.result.kept.end_f' '30' "the first half ends at the split point"
assert_json "$out" '.result.created.start_f' '30' "the second half starts at the split point"
assert_json "$out" '.result.created.end_f' '45' "the second half ends where c1 ended"
created=$(unquote "$(json_get "$out" '.result.created.id')")
if [ "$created" != "c1" ] && [ -n "$created" ]; then
  pass "created.id ($created) is a fresh ID"
else
  fail "created.id is a fresh ID" "got: $created"
fi
assert_json "$out" '.result.linked.kept' 'c2' "the linked audio keeps its ID too"
linked_created=$(unquote "$(json_get "$out" '.result.linked.created')")
if [ -n "$linked_created" ] && [ "$linked_created" != "c2" ] && [ "$linked_created" != "$created" ]; then
  pass "linked.created ($linked_created) is a fresh ID too"
else
  fail "linked.created is a fresh ID" "got: $linked_created"
fi

out=$(montash -C "$proj" clip delete "$created" --ripple --json)
assert_exit 0 "clip delete $created --ripple"
out=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$out" '.result.clips[0].end_f' '30' "c1 is the 30 frame head"
assert_json "$out" '.result.clips[1].start_f' '30' "the rest closed up"
out=$(montash -C "$proj" clip list --track A1 --json)
assert_json "$out" '.result.clips[0].id' 'c2' "the linked audio half was deleted with it"
assert_json "$out" '.result.clips[1].start_f' '30' "audio closed up as well"
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '90' "timeline is 15 frames shorter again"

section "W-04 step 7: no gaps, history and validation"
out=$(montash -C "$proj" timeline gaps --json)
assert_exit 0 "timeline gaps"
assert_json "$out" '.result.gaps' '[]' "no gaps after the ripple edits"
assert_json "$out" '.op' 'null' "listing gaps records no op"

montash -C "$proj" undo --json >/dev/null || exit 1
out=$(montash -C "$proj" timeline show --json)
assert_json "$out" '.result.duration_f' '105' "undo restores the deleted half"
out=$(montash -C "$proj" clip list --track V1 --json)
assert_json "$out" '.result.clips[1].id' "$created" "the second half is back"

out=$(montash -C "$proj" validate --json)
assert_exit 0 "validate after undo"
assert_json "$out" '.result.ok' 'true' "invariants hold"

section "W-04 failure handling"
out=$(montash -C "$proj" clip trim c1 --in +f:60 --json)
assert_exit 1 "trimming past the clip fails"
assert_json "$out" '.error.code' 'E_TRIM_EXCEEDS_CLIP' "E_TRIM_EXCEEDS_CLIP"
out=$(montash -C "$proj" clip split c1 --at f:0 --json)
assert_exit 1 "splitting at the edge fails"
assert_json "$out" '.error.code' 'E_SPLIT_AT_EDGE' "E_SPLIT_AT_EDGE"
out=$(montash -C "$proj" validate --json)
assert_json "$out" '.result.ok' 'true' "failed commands changed nothing"

finish
