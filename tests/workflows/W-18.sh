#!/usr/bin/env bash
# W-18: クリップに効果を掛ける（docs/03 W-18、docs/04 §effect、docs/07 §3a）。
# effect presets → add → --dry-run でフィルタ確認 → set で調整 → 並べ替え → remove → 失敗手順 → commit。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --id a --json >/dev/null || exit 1
montash -C "$proj" clip add --asset a --in f:0 --duration f:60 --json >/dev/null || exit 1

section "W-18-1 使える効果を調べる（effect presets）"
out=$(montash -C "$proj" effect presets --json)
assert_exit 0 "effect presets exits 0"
assert_json "$out" '.result | map(select(.name == "color")) | length' '1' "組み込みの color が載る"
assert_json "$out" '.result | map(select(.name == "color"))[0].source' 'builtin' "出自が builtin"
assert_json "$out" '.result | map(select(.name == "color"))[0].params.saturation.type' 'number' "パラメータの型が出る"

section "W-18-2 効果を掛ける（effect add）"
out=$(montash -C "$proj" effect add c1 color --saturation 1.2 --brightness 0.05 --json)
assert_exit 0 "effect add exits 0"
assert_json "$out" '.ok' 'true' "effect add ok"
assert_json "$out" '.result.effect' 'color' "効果名が返る"
assert_json "$out" '.result.index' '0' "追加位置が返る"
assert_json "$out" '.result.params.saturation' '1.2' "パラメータが数値として入る"
assert_json "$out" '.op | length > 0' 'true' "op として記録される"

section "W-18-3 実際に流れるフィルタを確認する（--dry-run）"
out=$(montash -C "$proj" render --dry-run -o "$root/out.mp4" --json)
assert_exit 0 "render --dry-run exits 0"
cmd=$(json_get "$out" '.result.command | join(" ")')
case "$cmd" in
  *"eq=brightness=0.05:saturation=1.2"*) pass "フィルタグラフに eq= が入る" ;;
  *) fail "フィルタグラフに eq= が入る" "command: $cmd" ;;
esac

section "W-18-4 パラメータだけ調整する（effect set）"
montash -C "$proj" effect set c1 color --saturation 1.05 --json >/dev/null
assert_exit 0 "effect set exits 0"
out=$(montash -C "$proj" effect list c1 --json)
assert_json "$out" '.result.effects[0].params.saturation' '1.05' "値が更新される"
assert_json "$out" '.result.effects[0].params.brightness' '0.05' "指定しなかった値は残る"

section "W-18-5 適用順を入れ替える"
montash -C "$proj" effect add c1 color --gamma 1.1 --json >/dev/null
assert_exit 0 "2 つ目を足す"
montash -C "$proj" effect set c1 1 --index 0 --json >/dev/null
assert_exit 0 "index で並べ替えられる"
out=$(montash -C "$proj" effect list c1 --json)
assert_json "$out" '.result.effects[0].params.gamma' '1.1' "先頭に移動している"
assert_json "$out" '.result.effects | length' '2' "2 つ掛かっている"

section "W-18-6 外す（effect remove）"
montash -C "$proj" effect remove c1 0 --json >/dev/null
assert_exit 0 "effect remove exits 0"
out=$(montash -C "$proj" effect list c1 --json)
assert_json "$out" '.result.effects | length' '1' "1 つ残る"
assert_json "$out" '.result.effects[0].params.saturation' '1.05' "残ったのは調整した方"

section "W-18 失敗: 登録されていない効果はプラグイン不足"
out=$(montash -C "$proj" effect add c1 glow --json)
assert_exit 1 "未登録の効果は exit 1"
assert_json "$out" '.error.code' 'E_PLUGIN_MISSING' "E_PLUGIN_MISSING が返る"

section "W-18 失敗: 引数が範囲外"
out=$(montash -C "$proj" effect add c1 color --saturation 99 --json)
assert_exit 2 "範囲外は exit 2（usage）"
assert_json "$out" '.error.code' 'E_USAGE' "E_USAGE が返る"

section "W-18 失敗: 掛かっていない効果を set / remove"
out=$(montash -C "$proj" effect set c1 nope --json)
assert_json "$out" '.error.code' 'E_EFFECT_NOT_FOUND' "E_EFFECT_NOT_FOUND が返る"

section "W-18 完了条件: 作業をコミットできる"
out=$(montash -C "$proj" commit -m "c1 の彩度を少し上げた" --json)
assert_exit 0 "commit exits 0"
assert_json "$out" '.ok' 'true' "commit ok"

finish
