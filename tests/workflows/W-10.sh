#!/usr/bin/env bash
# W-10. やり直す・戻す（docs/03-workflows.md, docs/11 §4.3）
#   init → project set name a → set name b → status（pending 3）→ undo（name == a）→ redo（name == b）
#   → checkout o_0001（detached + W_DETACHED_HEAD）→ checkout tip → tag before-x → checkout before-x
#   → history verify ok → ids rebuild
source "$(dirname "$0")/lib.sh"

section "W-10 setup: init + 2 ops"
root=$(tmp_project_dir)
proj="$root/tmp"
out=$(montash init "$proj" --fps 30 --json)
assert_exit 0 "init exits 0"
assert_json "$out" '.op' 'o_0001' "init records o_0001"
out=$(montash -C "$proj" project set name a --json)
assert_exit 0 "project set name a exits 0"
assert_json "$out" '.op' 'o_0002' "set name a → o_0002"
assert_json "$out" '.commit' 'null' "no -m → not committed"
out=$(montash -C "$proj" project set name b --json)
assert_json "$out" '.op' 'o_0003' "set name b → o_0003"
assert_json "$out" '.head.pending' '3' "head.pending == 3 after 2 ops (init + 2)"

section "W-10 step 1: status"
out=$(montash -C "$proj" status --json)
assert_exit 0 "status exits 0"
assert_json "$out" '.result.head' 'o_0003' "HEAD is o_0003"
assert_json "$out" '.result.pending[2].id' 'o_0003' "pending has 3 ops (3rd is o_0003)"
assert_json "$out" '.result.pending[3]' 'null' "pending has no 4th op"
assert_json "$out" '.result.pending[2].summary' '"set name = \"b\""' "last pending summary"
assert_json "$out" '.result.detached' 'false' "not detached"
assert_json "$out" '.result.dirty' 'false' "project.json matches HEAD"
assert_json "$out" '.head' '{"op":"o_0003","pending":3,"detached":false}' "status carries head"
assert_json "$out" '.op' 'null' "status records no op"

section "W-10 step 2: log --ops"
out=$(montash -C "$proj" log --ops --json)
assert_exit 0 "log exits 0"
assert_json "$out" '.result.commits' '[]' "no commits yet"
assert_json "$out" '.result.pending[0].id' 'o_0003' "log lists pending ops newest first"
assert_json "$out" '.result.pending[2].id' 'o_0001' "log lists 3 pending ops"

section "W-10 step 3: undo"
out=$(montash -C "$proj" undo --json)
assert_exit 0 "undo exits 0"
assert_json "$out" '.result.target.id' 'o_0002' "undo moves HEAD to o_0002"
assert_json "$out" '.head.detached' 'true' "HEAD is detached after undo"
assert_json "$out" '.op' 'null' "undo creates no op"
out=$(montash -C "$proj" project show --json)
assert_json "$out" '.result.name' 'a' "project.json name == a after undo"

section "W-10 step 5: redo"
out=$(montash -C "$proj" redo --json)
assert_exit 0 "redo exits 0"
assert_json "$out" '.result.target.id' 'o_0003' "redo moves HEAD to o_0003"
assert_json "$out" '.head' '{"op":"o_0003","pending":3,"detached":false}' "back at tip"
out=$(montash -C "$proj" project show --json)
assert_json "$out" '.result.name' 'b' "project.json name == b after redo"

section "W-10 step 4: checkout o_0001 (detached)"
out=$(montash -C "$proj" checkout o_0001 --json)
assert_exit 0 "checkout exits 0"
assert_json "$out" '.result.head.detached' 'true' "detached: true"
assert_json "$out" '.warnings[0].code' 'W_LEAVING_PENDING' "W_LEAVING_PENDING warning"
assert_json "$out" '.warnings[1].code' 'W_DETACHED_HEAD' "W_DETACHED_HEAD warning"
out=$(montash -C "$proj" project show --json)
assert_json "$out" '.result.name' 'tmp' "project.json restored to the initial state"
out=$(montash -C "$proj" status --json)
assert_json "$out" '.result.detached' 'true' "status shows detached"
assert_json "$out" '.result.tip' 'o_0003' "status shows tip o_0003"
assert_json "$out" '.result.dirty' 'false' "checkout keeps project.json == HEAD (not dirty)"

section "W-10 step 5: checkout tip"
out=$(montash -C "$proj" checkout tip --json)
assert_exit 0 "checkout tip exits 0"
assert_json "$out" '.head' '{"op":"o_0003","pending":3,"detached":false}' "tip is o_0003"
assert_json "$out" '.warnings' '[]' "no warnings at tip"

section "W-10 step 6: tag / checkout <tag>"
out=$(montash -C "$proj" tag before-x -m "節目" --json)
assert_exit 0 "tag exits 0"
assert_json "$out" '.result.tag.name' 'before-x' "tag name"
assert_json "$out" '.result.tag.target' 'o_0003' "tag targets HEAD"
assert_json "$out" '.result.tag.message' '節目' "tag message from -m"
out=$(montash -C "$proj" tag before-x --json)
assert_exit 1 "duplicate tag exits 1"
assert_json "$out" '.error.code' 'E_TAG_EXISTS' "duplicate tag → E_TAG_EXISTS"
out=$(montash -C "$proj" tag list --json)
assert_exit 0 "tag list exits 0"
assert_json "$out" '.result.tags[0].name' 'before-x' "one tag"
assert_json "$out" '.result.tags[1]' 'null' "only one tag"
assert_json "$out" '.result.tags[0].op' 'o_0003' "tag resolves to o_0003"
out=$(montash -C "$proj" undo 2 --json)
assert_json "$out" '.result.target.id' 'o_0001' "undo 2 → o_0001"
out=$(montash -C "$proj" checkout before-x --json)
assert_exit 0 "checkout <tag> exits 0"
assert_json "$out" '.result.target.id' 'o_0003' "tag restores o_0003"
out=$(montash -C "$proj" project show --json)
assert_json "$out" '.result.name' 'b' "project.json name == b after checkout tag"

section "W-10 failure: history edge cases"
out=$(montash -C "$proj" redo --json)
assert_exit 1 "redo at tip exits 1"
assert_json "$out" '.error.code' 'E_NOTHING_TO_REDO' "redo at tip → E_NOTHING_TO_REDO"
out=$(montash -C "$proj" checkout o_9999 --json)
assert_exit 1 "unknown ref exits 1"
assert_json "$out" '.error.code' 'E_HISTORY_REF_NOT_FOUND' "unknown ref → E_HISTORY_REF_NOT_FOUND"

section "W-10 maintenance: history verify / ids rebuild"
out=$(montash -C "$proj" history verify --json)
assert_exit 0 "history verify exits 0"
assert_json "$out" '.result.ok' 'true' "history verify ok"
assert_json "$out" '.result.counts.ops' '3' "3 ops"
assert_json "$out" '.result.counts.tags' '1' "1 tag"
out=$(montash -C "$proj" ids rebuild --json)
assert_exit 0 "ids rebuild exits 0"
assert_json "$out" '.result.counters.c' '1' "no clips → counter c == 1"
assert_json "$out" '.op' 'null' "ids rebuild records no op"
assert_json "$(cat "$proj/.montash/ids.json")" '.counters.c' '1' "ids.json rewritten"
out=$(montash -C "$proj" history prune --dry-run --json)
assert_exit 0 "history prune --dry-run exits 0"
assert_json "$out" '.result.dry_run' 'true' "prune は --dry-run で対象を列挙するだけ"
assert_json "$out" '.result.ops' '[]' "HEAD 系列とタグの op は消さない"
out=$(montash -C "$proj" history export -o "$proj/history.jsonl" --json)
assert_exit 0 "history export exits 0"
assert_json "$out" '.result.counts.ops' '3' "3 op を書き出す"
assert_file_exists "$proj/history.jsonl" "JSONL が書かれる"
rm -rf "$proj/.montash/history"
out=$(montash -C "$proj" history import "$proj/history.jsonl" --json)
assert_exit 0 "history import exits 0"
assert_json "$out" '.result.added.ops' '3' "3 op を取り込む"
out=$(montash -C "$proj" history verify --json)
assert_json "$out" '.result.ok' 'true' "import した履歴も verify を通る"

finish
