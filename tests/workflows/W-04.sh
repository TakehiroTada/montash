#!/usr/bin/env bash
# W-04: プレビューで確認して微調整する（docs/03 W-04）。
# 前半は編集操作（clip list/trim/move/split/delete, timeline gaps, undo, validate）、
# 後半はプレビュー生成（セグメントキャッシュ + 音声 1 パス + mux）と serve の配信・自動再生成を検証する。
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


# M2: プレビュー生成（映像セグメントキャッシュ + 音声 1 パス + mux）→ 状態確認 → 編集で stale → 再生成。
# クリップ編集コマンド（clip trim/move/split/delete）は並行実装中のため、無ければ skip する。
proot=$(tmp_project_dir)
pproj="$proot/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1
montash init "$pproj" --resolution 640x360 --json >/dev/null || exit 1
montash -C "$pproj" import "$fixtures/a.mp4" --json >/dev/null || exit 1
# 70 フレームずつ 3 カット = 210 フレーム。セグメント境界がカット点に載る
montash -C "$pproj" clip add --asset a --in f:0 --duration f:70 --json >/dev/null || exit 1
montash -C "$pproj" clip add --asset a --in f:20 --duration f:70 --json >/dev/null || exit 1
montash -C "$pproj" clip add --asset a --in f:40 --duration f:70 --json >/dev/null || exit 1

section "W-04 preview build"
out=$(montash -C "$pproj" preview status --json)
assert_exit 0 "preview status exits 0 without a preview"
assert_json "$out" '.result.state' 'missing' "no preview yet"

out=$(montash -C "$pproj" preview build --height 90 --dry-run --json)
assert_exit 0 "dry-run exits 0"
assert_json "$out" '.result.dry_run' 'true' "dry-run reports the plan"
assert_json "$out" '.result.segments[0].from_f' '0' "segments start at the timeline head"
assert_json "$out" '.result.segments[1].from_f' '70' "segment boundaries land on cut points"
assert_json "$out" '.result.segments[2].to_f' '210' "segments cover the whole timeline"
assert_json "$out" '.result.audio.path' 'audio.m4a' "audio is one file for the whole timeline"

out=$(montash -C "$pproj" preview build --height 90 --json)
assert_exit 0 "preview build exits 0"
assert_json "$out" '.result.state' 'ready' "preview is ready"
assert_json "$out" '.result.duration_f' '210' "verified frame count matches the timeline"
assert_json "$out" '.result.built_segments' '3' "all three segments encoded"
assert_file_exists "$pproj/.montash/preview/timeline.mp4" "muxed timeline.mp4"
assert_file_exists "$pproj/.montash/preview/video.mp4" "concatenated video.mp4"
assert_file_exists "$pproj/.montash/preview/audio.m4a" "single-pass audio.m4a"
assert_dir_exists "$pproj/.montash/preview/segments" "segment cache"

out=$(montash -C "$pproj" preview status --json)
assert_json "$out" '.result.state' 'ready' "status reports ready"
assert_json "$out" '.result.segments' '3' "status reports the cached segments"
out=$(montash -C "$pproj" preview build --height 90 --json)
assert_json "$out" '.result.reused' 'true' "an up-to-date preview is not rebuilt"

section "W-04 stale and cached rebuild"
montash -C "$pproj" project set name w04-preview --json >/dev/null || exit 1
out=$(montash -C "$pproj" preview status --json)
assert_json "$out" '.result.state' 'stale' "editing the project marks the preview stale"
assert_file_exists "$pproj/.montash/preview/timeline.mp4" "the old preview stays playable"
out=$(montash -C "$pproj" preview build --height 90 --json)
assert_exit 0 "rebuild exits 0"
assert_json "$out" '.result.state' 'ready' "preview is ready again"
assert_json "$out" '.result.built_segments' '0' "video segments come from the cache"
assert_json "$out" '.result.cached_segments' '3' "all segments reused"
assert_json "$out" '.result.audio_reused' 'true' "audio is reused when nothing audible changed"

section "W-04 partial and audio-only builds"
out=$(montash -C "$pproj" preview build --height 90 --from f:0 --to f:30 --json)
assert_exit 0 "--from/--to exits 0"
assert_json "$out" '.result.built_segments' '1' "only the overlapping segment is re-encoded"
assert_json "$out" '.result.cached_segments' '2' "the other segments stay cached"
out=$(montash -C "$pproj" preview build --height 90 --audio-only --force --json)
assert_exit 0 "--audio-only exits 0"
assert_json "$out" '.result.audio_only' 'true' "audio-only build reported"
assert_json "$out" '.result.built_segments' '0' "audio-only does not touch video"
out=$(montash -C "$pproj" preview build --to f:5 --from f:40 --json)
assert_exit 2 "--to before --from is a usage error"

section "W-04 fine tuning"
if has_command "clip trim"; then
  out=$(montash -C "$pproj" clip trim c1 --out -f:10 --ripple --json)
  assert_exit 0 "trim the first cut"
  out=$(montash -C "$pproj" preview status --json)
  assert_json "$out" '.result.state' 'stale' "trimming marks the preview stale"
  out=$(montash -C "$pproj" preview build --height 90 --json)
  assert_json "$out" '.result.state' 'ready' "preview regenerated after the trim"
  assert_json "$out" '.result.duration_f' '200' "rippled timeline is ten frames shorter"
else
  skip "clip trim/move/split/delete round trip" "clip editing commands are not registered yet (parallel milestone work)"
fi

section "W-04 serve: delivery and automatic rebuild"
# 実際に serve を起動して /api/status・/preview/* を確認する。
# chromium と web/dist があれば、同じスクリプトが実ブラウザの再生まで検証する。
if bun "$MONTASH_REPO/scripts/e2e-preview.ts"; then
  pass "serve delivers /preview/* with byte ranges and rebuilds after edits"
else
  fail "serve delivers /preview/* with byte ranges and rebuilds after edits"
fi

finish
