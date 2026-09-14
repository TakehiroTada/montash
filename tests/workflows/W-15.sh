#!/usr/bin/env bash
# W-15. 作業をコミットとして記録する（docs/03-workflows.md, docs/11 §4.2, §5）
#   init → project set name x -m "00:00.0〜00:00.0 名前を x に"（即コミット k_0001, pending 0）
#   → project set name y → status pending 1 → commit -m "名前を y に"（W_COMMIT_MESSAGE_STYLE）
#   → log にコミット 2 件 → show k_0002 --patch に /name → diff 空 → commit 再実行で E_NOTHING_TO_COMMIT
source "$(dirname "$0")/lib.sh"

section "W-15 step 3: -m on a state-changing command commits immediately"
root=$(tmp_project_dir)
proj="$root/tmp"
out=$(montash init "$proj" --fps 30 --json)
assert_exit 0 "init exits 0"
out=$(montash -C "$proj" project set name x -m "00:00.0〜00:00.0 名前を x に" --json)
assert_exit 0 "project set -m exits 0"
assert_json "$out" '.op' 'o_0002' "op o_0002 recorded"
assert_json "$out" '.commit' 'k_0001' "committed immediately as k_0001"
assert_json "$out" '.head.pending' '0' "pending 0 after -m"
assert_json "$out" '.result.after' 'x' "name is x"

section "W-15 step 1: pending op + status / diff"
out=$(montash -C "$proj" project set name y --json)
assert_json "$out" '.op' 'o_0003' "op o_0003"
assert_json "$out" '.commit' 'null' "not committed"
out=$(montash -C "$proj" status --json)
assert_exit 0 "status exits 0"
assert_json "$out" '.head.pending' '1' "status pending == 1"
assert_json "$out" '.result.pending[0].id' 'o_0003' "pending op is o_0003"
assert_json "$out" '.result.last_commit.id' 'k_0001' "last commit is k_0001"
assert_json "$out" '.result.commit' 'null' "HEAD itself is not committed"
out=$(montash -C "$proj" diff --json)
assert_exit 0 "diff exits 0"
assert_json "$out" '.result.from.op' 'o_0002' "diff from the last committed state"
assert_json "$out" '.result.to.op' 'o_0003' "diff to HEAD"
assert_json "$out" '.result.changes[0].path' '/name' "pending diff touches /name"
assert_json "$out" '.result.changes[0].value' 'y' "pending diff new value"

section "W-15 step 2: commit -m (message without a timeline range warns)"
out=$(montash -C "$proj" commit -m "名前を y に" --body "指示: 「y にして」" --json)
assert_exit 0 "commit exits 0 (warning is not an error)"
assert_json "$out" '.commit' 'k_0002' "commit k_0002"
assert_json "$out" '.result.commit.ops' '["o_0003"]' "k_0002 contains o_0003 only"
assert_json "$out" '.result.commit.body' '指示: 「y にして」' "body stored"
assert_json "$out" '.result.commit.parent' 'k_0001' "parent commit is k_0001"
assert_json "$out" '.warnings[0].code' 'W_COMMIT_MESSAGE_STYLE' "W_COMMIT_MESSAGE_STYLE warning"
assert_json "$out" '.head.pending' '0' "pending 0 after commit"

section "W-15 step 5: log / show"
out=$(montash -C "$proj" log --json)
assert_exit 0 "log exits 0"
assert_json "$out" '.result.commits[0].id' 'k_0002' "log newest first: k_0002"
assert_json "$out" '.result.commits[1].id' 'k_0001' "log: k_0001"
assert_json "$out" '.result.commits[2]' 'null' "log has 2 commits"
assert_json "$out" '.result.pending' '[]' "no pending ops in log"
out=$(montash -C "$proj" log --grep "x に" --json)
assert_json "$out" '.result.commits[0].id' 'k_0001' "log --grep finds k_0001"
assert_json "$out" '.result.commits[1]' 'null' "log --grep filters k_0002 out"
out=$(montash -C "$proj" show k_0002 --patch --json)
assert_exit 0 "show exits 0"
assert_json "$out" '.result.kind' 'commit' "show k_0002 is a commit"
assert_json "$out" '.result.commit.message' '名前を y に' "show message"
assert_json "$out" '.result.changed_paths[0]' '/name' "show --patch lists /name"
assert_json "$out" '.result.changes[0]' '{"op":"replace","path":"/name","from":"x","value":"y"}' "show --patch change for /name"
out=$(montash -C "$proj" show k_0002 --json)
assert_json "$out" '.result.changes' 'null' "without --patch changes are omitted"

section "W-15 completion: diff is empty, nothing to commit"
out=$(montash -C "$proj" diff --json)
assert_exit 0 "diff exits 0"
assert_json "$out" '.result.changes' '[]' "diff is empty after commit"
out=$(montash -C "$proj" commit -m "00:00.0 again" --json)
assert_exit 1 "commit with nothing pending exits 1"
assert_json "$out" '.ok' 'false' "commit not ok"
assert_json "$out" '.error.code' 'E_NOTHING_TO_COMMIT' "→ E_NOTHING_TO_COMMIT"
out=$(montash -C "$proj" commit --json)
assert_exit 1 "bare commit with nothing pending exits 1"
assert_json "$out" '.error.code' 'E_NOTHING_TO_COMMIT' "bare commit → E_NOTHING_TO_COMMIT"

section "W-15 step 4: tag a milestone / --auto-message / --allow-empty"
out=$(montash -C "$proj" tag rough-cut -m "粗編集完了" --json)
assert_exit 0 "tag exits 0"
assert_json "$out" '.result.tag.target' 'o_0003' "tag targets HEAD op"
out=$(montash -C "$proj" project set name z --json)
out=$(montash -C "$proj" commit --auto-message --json)
assert_exit 0 "commit --auto-message exits 0"
assert_json "$out" '.result.auto_message' 'true' "auto message flag"
assert_json "$out" '.result.commit.message' '"set name = \"z\""' "auto message from op summary"
out=$(montash -C "$proj" commit --allow-empty -m "00:00.0 milestone" --tag milestone --json)
assert_exit 0 "commit --allow-empty exits 0"
assert_json "$out" '.result.commit.ops' '[]' "empty commit"
assert_json "$out" '.result.commit.tags' '["milestone"]' "commit --tag"
out=$(montash -C "$proj" history verify --json)
assert_json "$out" '.result.ok' 'true' "history verify ok"
assert_json "$out" '.result.counts.commits' '4' "4 commits"

finish
