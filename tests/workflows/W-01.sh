#!/usr/bin/env bash
# W-01. 環境確認とプロジェクト作成（docs/03-workflows.md）
#   1. montash doctor --json            → ok
#   3. montash init <dir> --fps 29.97   → project.json / .montash/ids.json、fps は 30000/1001
#   4. montash project show --json      → 設定が返り duration_f == 0
#   失敗と対処: 再 init は E_PROJECT_EXISTS（exit 1）、--force で成功。validate は ok。
source "$(dirname "$0")/lib.sh"

section "W-01 step 1: doctor"
out=$(montash doctor --json)
assert_exit 0 "doctor exits 0"
assert_json "$out" '.ok' 'true' "doctor --json .ok == true"
assert_json "$out" '.result.ffmpeg.found' 'true' "ffmpeg found"

section "W-01 step 3: init"
root=$(tmp_project_dir)
proj="$root/tmp"
out=$(montash init "$proj" --fps 29.97 --resolution 1920x1080 --sample-rate 48000 --json)
assert_exit 0 "init exits 0"
assert_json "$out" '.ok' 'true' "init ok"
assert_json "$out" '.result.settings.fps' '{"num":30000,"den":1001}' "29.97 is stored as 30000/1001"
assert_json "$out" '.result.settings.fps_label' '29.97' "fps label"
assert_json "$out" '.result.settings.resolution' '{"width":1920,"height":1080}' "resolution"
assert_json "$out" '.result.settings.sample_rate' '48000' "sample rate"
assert_json "$out" '.result.settings.default_image_duration_f' '150' "default image duration = 5 s @ 29.97"
assert_json "$out" '.result.tracks' '[{"id":"V1","kind":"video"},{"id":"A1","kind":"audio"}]' "default tracks V1 / A1"
assert_file_exists "$proj/project.json"
assert_dir_exists "$proj/.montash"
assert_file_exists "$proj/.montash/ids.json"
assert_file_exists "$proj/.gitignore"
assert_dir_exists "$proj/assets"
assert_dir_exists "$proj/out"
assert_json "$(cat "$proj/project.json")" '.schema_version' '2' "project.json schema_version == 2"
assert_json "$(cat "$proj/.montash/ids.json")" '.counters.c' '1' "ids.json counters start at 1"

section "W-01 step 4: project show"
out=$(montash -C "$proj" project show --json)
assert_exit 0 "project show exits 0"
assert_json "$out" '.ok' 'true' "project show ok"
assert_json "$out" '.result.settings.fps' '{"num":30000,"den":1001}' "project show fps"
assert_json "$out" '.result.duration_f' '0' "empty timeline duration_f == 0"
assert_json "$out" '.result.track_count' '2' "track_count == 2"
assert_json "$out" '.result.asset_count' '0' "asset_count == 0"
assert_json "$out" '.timeline.duration_tc' '00:00:00.000' "timeline tc"

# カレントディレクトリからの上方向探索でも見つかる
out=$(cd "$proj" && montash project show --json)
assert_json "$out" '.result.name' 'tmp' "project show from inside the directory"

section "W-01 failure: init again"
out=$(montash init "$proj" --json)
assert_exit 1 "re-init exits 1"
assert_json "$out" '.ok' 'false' "re-init not ok"
assert_json "$out" '.error.code' 'E_PROJECT_EXISTS' "re-init → E_PROJECT_EXISTS"

section "W-01 failure: init --force"
out=$(montash init "$proj" --fps 30 --force --json)
assert_exit 0 "init --force exits 0"
assert_json "$out" '.result.settings.fps' '{"num":30,"den":1}' "forced init applies new fps"
assert_json "$out" '.result.forced' 'true' "forced flag"

section "validate"
out=$(montash -C "$proj" validate --json)
assert_exit 0 "validate exits 0"
assert_json "$out" '.result.ok' 'true' "validate ok"
assert_json "$out" '.result.errors' '[]' "no errors"

section "project set"
out=$(montash -C "$proj" project set name summer-trip --json)
assert_exit 0 "project set name exits 0"
assert_json "$out" '.result.after' 'summer-trip' "name changed"
out=$(montash -C "$proj" project set fps 30 --json)
assert_exit 1 "project set fps exits 1 (not implemented)"
assert_json "$out" '.error.code' 'E_NOT_IMPLEMENTED' "project set fps → E_NOT_IMPLEMENTED"

finish
