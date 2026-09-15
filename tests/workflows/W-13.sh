#!/usr/bin/env bash
# W-13: 素材の場所が変わったので再リンクする（docs/03 W-13）。
# import → 素材を別ディレクトリへ移動 → validate --deep で欠落検出 → assets relink → validate --deep が ok。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1
mkdir -p "$root/raw"
cp "$fixtures/a.mp4" "$root/raw/a.mp4"
cp "$fixtures/tone.wav" "$root/raw/tone.wav"
montash init "$proj" --resolution 640x360 --json >/dev/null || exit 1

section "W-13 import, edit, then move the source folder"
out=$(montash -C "$proj" import "$root/raw/a.mp4" "$root/raw/tone.wav" --json)
assert_exit 0 "import exits 0"
assert_json "$out" '.result.imported[0].id' 'a' "video imported"
montash -C "$proj" clip add --asset a --in f:0 --out f:30 --json >/dev/null
mkdir -p "$root/ext"
mv "$root/raw/a.mp4" "$root/ext/a.mp4"
# 移動ついでに改名された素材（名前では当たらない）
mv "$root/raw/tone.wav" "$root/ext/tone-renamed.wav"
out=$(montash -C "$proj" validate --deep --json)
assert_exit 5 "validate --deep fails while sources are missing"
assert_json "$out" '.error.detail.errors[0].code' 'E_ASSET_MISSING' "missing source reported"

section "W-13 relink by directory search"
out=$(montash -C "$proj" assets relink --search "$root/ext" --json)
assert_exit 0 "relink exits 0"
assert_json "$out" '.result.relinked[0].id' 'a' "video relinked"
assert_json "$out" '.result.relinked[0].matched_by' 'name' "matched by file name"
assert_json "$out" '.result.relinked[1].id' 'tone' "renamed audio relinked"
assert_json "$out" '.result.relinked[1].matched_by' 'size' "matched by size"
assert_json "$out" '.result.unresolved' '[]' "nothing left unresolved"
out=$(montash -C "$proj" validate --deep --json)
assert_exit 0 "validate --deep is ok again"
assert_json "$out" '.result.ok' 'true' "project valid after relink"
out=$(montash -C "$proj" assets list --missing --json)
assert_json "$out" '.result.assets' '[]' "no missing assets left"

section "W-13 relink a single asset by path"
mkdir -p "$root/ext2"
mv "$root/ext/a.mp4" "$root/ext2/a.mp4"
out=$(montash -C "$proj" assets relink a --path "$root/ext2/a.mp4" --json)
assert_exit 0 "relink --path exits 0"
assert_json "$out" '.result.relinked[0].matched_by' 'path' "explicit path used"
assert_json "$out" '.result.relinked[0].id' 'a' "the named asset was relinked"
out=$(montash -C "$proj" validate --deep --json)
assert_exit 0 "validate --deep is ok after --path relink"
out=$(montash -C "$proj" assets relink a --path "$root/ext2/missing.mp4" --json)
assert_exit 4 "relinking to a nonexistent path fails"
assert_json "$out" '.error.code' 'E_ASSET_MISSING' "E_ASSET_MISSING reported"
finish
