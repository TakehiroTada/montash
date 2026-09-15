#!/usr/bin/env bash
# W-19: プラグインを導入して使う（docs/03 W-19、docs/04 §plugin、docs/14）。
# plugin list → effect add → requires の記録 → プラグイン無しで開ける → レンダー時だけ失敗。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

# テスト用プラグインを「導入済み」の場所として使う（install 自体は人間の操作なので別途検証）
plugins="$fixtures/plugins"
with_plugin() { MONTASH_PLUGIN_PATH="$plugins" montash "$@"; }
without_plugin() { MONTASH_PLUGIN_PATH="$root/none" montash "$@"; }

with_plugin init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
with_plugin -C "$proj" import "$fixtures/a.mp4" --id a --json >/dev/null || exit 1
with_plugin -C "$proj" clip add --asset a --in f:0 --duration f:60 --json >/dev/null || exit 1

section "W-19-2 何が入ったかを確認する（plugin list）"
out=$(with_plugin plugin list --json)
assert_exit 0 "plugin list exits 0"
assert_json "$out" '.result.plugins | length' '1' "プラグインが 1 つ読み込まれる"
assert_json "$out" '.result.plugins[0].id' 'com.example.spike' "id が読める"
assert_json "$out" '.result.plugins[0].registered.effects[0]' 'video:spike' "登録した効果が分かる"

section "W-19-2 追加された効果が組み込みと同じに見える"
out=$(with_plugin effect presets --json)
assert_json "$out" '.result | map(select(.name == "spike"))[0].source' 'plugin' "出自が plugin"
assert_json "$out" '.result | map(select(.name == "spike"))[0].params.sigma.default' '3' "パラメータの既定値が出る"

section "W-19-3 組み込みと同じように使う"
out=$(with_plugin -C "$proj" effect add c1 spike --sigma 6 --json)
assert_exit 0 "プラグインの効果を掛けられる"
assert_json "$out" '.result.params.sigma' '6' "パラメータが通る"

out=$(with_plugin -C "$proj" render --dry-run -o "$root/out.mp4" --json)
cmd=$(json_get "$out" '.result.command | join(" ")')
case "$cmd" in
  *"gblur=sigma=6"*) pass "フィルタグラフに届く" ;;
  *) fail "フィルタグラフに届く" "command: $cmd" ;;
esac

section "W-19-4 依存が project.json に記録される"
out=$(cat "$proj/project.json")
assert_json "$out" '.plugins.requires[0].id' 'com.example.spike' "requires に記録される"
assert_json "$out" '.plugins.requires[0].version' '0.1.0' "バージョンも記録される"

section "W-19-5 プラグインの無い環境でも開ける（F-EXT-4）"
out=$(without_plugin -C "$proj" clip list --json)
assert_exit 0 "プロジェクトが開ける"
assert_json "$out" '.result.clips | length > 0' 'true' "クリップが読める"

out=$(without_plugin -C "$proj" effect list c1 --json)
assert_exit 0 "effect list も動く"
assert_json "$out" '.result.effects[0].type' 'spike' "効果は保持されている"
assert_json "$out" '.result.effects[0].missing' 'true' "プラグイン不足の印が付く"

section "W-19-6 レンダー時にだけ失敗し、何が足りないかを報告する"
out=$(without_plugin -C "$proj" render --dry-run -o "$root/out.mp4" --json)
assert_exit 1 "レンダーは失敗する"
assert_json "$out" '.error.code' 'E_PLUGIN_MISSING' "E_PLUGIN_MISSING が返る"

out=$(without_plugin -C "$proj" plugin doctor --json)
assert_exit 1 "plugin doctor が不足を報告する"
assert_json "$out" '.result.ok' 'false' "ok: false"
assert_json "$out" '.result.missing_plugins[0].id' 'com.example.spike' "不足プラグインが名指しされる"
assert_json "$out" '.result.unknown_effects[0]' 'spike' "解釈できない効果も分かる"

section "W-19 失敗: AI は勝手に導入できない（非対話では確認必須）"
out=$(montash plugin install "$plugins/com.example.spike" --json)
assert_exit 1 "確認なしの install は失敗する"
assert_json "$out" '.error.code' 'E_CONFIRM_REQUIRED' "E_CONFIRM_REQUIRED が返る"

section "W-19 失敗: API バージョンが合わない"
bad="$root/bad-plugin/com.example.future"
mkdir -p "$bad"
printf '{"id":"com.example.future","apiVersion":99}\n' > "$bad/montash-plugin.json"
printf 'export default { register() {} };\n' > "$bad/index.js"
out=$(MONTASH_PLUGIN_PATH="$root/bad-plugin" montash plugin list --json 2>"$root/stderr.txt")
assert_exit 0 "壊れたプラグインがあっても montash は動く"
if grep -q "E_PLUGIN_INCOMPATIBLE" "$root/stderr.txt"; then
  pass "非互換は警告として報告される"
else
  fail "非互換は警告として報告される" "stderr: $(cat "$root/stderr.txt")"
fi

finish
