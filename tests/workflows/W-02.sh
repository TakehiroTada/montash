#!/usr/bin/env bash
# M1: 取り込み → プロキシ → 一覧・詳細（サムネイルと波形は M3）。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1
montash init "$proj" --resolution 640x360 --json >/dev/null || exit 1

section "W-02 import and inspect"
out=$(montash -C "$proj" import "$fixtures/a.mp4" "$fixtures/tone.wav" --copy --json)
assert_exit 0 "import exits 0"
assert_json "$out" '.result.imported[0].id' 'a' "filename slug"
assert_json "$out" '.result.imported[0].duration_f' '150' "project-frame duration"
assert_json "$out" '.result.imported[1].type' 'audio' "audio detected"
assert_json "$out" '.op' 'o_0002' "import is one history operation"
out=$(montash -C "$proj" proxy build --all --height 64 --json)
assert_exit 0 "proxy build exits 0"
out=$(montash -C "$proj" proxy status --json)
assert_json "$out" '.result.proxies[0].state' 'ready' "video proxy ready"
assert_json "$out" '.result.proxies[1].state' 'ready' "audio proxy ready"
out=$(montash -C "$proj" assets list --json)
assert_json "$out" '.result.assets[0].id' 'a' "assets listed"
out=$(montash -C "$proj" assets show a --probe --json)
assert_json "$out" '.result.asset.usage.clips' '[]' "unused source"
assert_json "$out" '.result.probe.streams[0].codec_type' 'video' "raw probe available"

section "W-02 partial failure"
out=$(montash -C "$proj" import "$root/missing.mp4" "$fixtures/logo.png" --json)
assert_exit 4 "partial failure exits 4"
assert_json "$out" '.result.imported[0].type' 'image' "good input retained"
assert_json "$out" '.result.failed[0].error.code' 'E_ASSET_MISSING' "missing input reported"
finish
