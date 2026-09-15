#!/usr/bin/env bash
# W-11. 既存プロジェクトを一部修正して再書き出し（docs/03-workflows.md W-11, docs/04 §14 --last, §15 blame/revert）
#   init + import + clip → commit → render（last.json を作る）
#   → project show / validate → text list → text set で文言修正
#   → diff で差分が意図箇所のみ → render --last -o out/v2.mp4 → blame / revert
source "$(dirname "$0")/lib.sh"

fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1
root=$(tmp_project_dir)
proj="$root/summer_trip"

section "W-11 setup: 完成済みプロジェクトと 1 回目の書き出し"
montash init "$proj" --fps 30 --resolution 320x180 --json >/dev/null
assert_exit 0 "init exits 0"
montash -C "$proj" import "$fixtures/a.mp4" --json >/dev/null
montash -C "$proj" clip add --asset a --in f:0 --duration f:30 --json >/dev/null
out=$(montash -C "$proj" commit -m "00:00.0〜00:01.0 の素材を配置" --json)
assert_exit 0 "commit exits 0"
assert_json "$out" '.result.commit.id' 'k_0001' "初回コミット k_0001"
out=$(montash -C "$proj" render --preset web-preview --resolution 160x90 --preset-speed ultrafast -o "$proj/out/summer_trip.mp4" --progress none --json)
assert_exit 0 "1 回目の render exits 0"
assert_json "$out" '.result.valid' 'true' "1 回目の出力を検証"
assert_file_exists "$proj/.montash/render/last.json" "render オプションが last.json に残る"

section "W-11 step 1: プロジェクトを開いて状態を把握"
out=$(montash -C "$proj" project show --json)
assert_exit 0 "project show exits 0"
assert_json "$out" '.result.name' 'summer_trip' "プロジェクト名"
out=$(montash -C "$proj" validate --json)
assert_exit 0 "validate exits 0"
assert_json "$out" '.result.ok' 'true' "validate ok"

section "W-11 step 2: 対象テキストを検索して修正"
if has_command "text add" && has_command "text set" && has_command "text list"; then
  montash -C "$proj" text add --text "Summer Trip 2025" --at f:0 --duration f:20 --json >/dev/null
  assert_exit 0 "text add exits 0"
  out=$(montash -C "$proj" commit -m "00:00.0〜00:00.7 にタイトルを追加" --json)
  assert_json "$out" '.result.commit.id' 'k_0002' "タイトル追加をコミット"
  out=$(montash -C "$proj" text list --json)
  assert_json "$out" '.result.clips[0].text' 'Summer Trip 2025' "誤字のあるタイトル"
  out=$(montash -C "$proj" text set x1 --text "Summer Trip 2026" --json)
  assert_exit 0 "text set exits 0"
  out=$(montash -C "$proj" text list --json)
  assert_json "$out" '.result.clips[0].text' 'Summer Trip 2026' "文言が直っている"

  section "W-11 step 4: diff で差分が意図箇所のみか確認"
  out=$(montash -C "$proj" diff --json)
  assert_exit 0 "diff exits 0"
  assert_json "$out" '.result.changes[2]' 'null' "差分は text（と updated_at）だけ"
  changed=$(json_get "$out" '.result.changes[0].path')
  case "$changed" in
    *'/text'*) pass "変更されたのはテキストのパスだけ ($changed)" ;;
    *) fail "変更されたパスが想定外" "actual: $changed" ;;
  esac

  section "W-11 blame / revert（W-11 の派生コマンド）"
  out=$(montash -C "$proj" blame x1 --json)
  assert_exit 0 "blame exits 0"
  assert_json "$out" '.result.element' 'x1' "blame は要素 ID を返す"
  assert_json "$out" '.result.actor' 'ai' "最後に触った actor"
  out=$(montash -C "$proj" log --grep タイトル --json)
  assert_json "$out" '.result.commits[0].id' 'k_0002' "log --grep でコミットを特定できる"

  # revert で文言修正を取り消し、もう一度 revert して戻す（往復しても履歴は壊れない）
  out=$(montash -C "$proj" revert HEAD --json)
  assert_exit 0 "revert HEAD exits 0"
  undone=$(montash -C "$proj" text list --json)
  assert_json "$undone" '.result.clips[0].text' 'Summer Trip 2025' "revert で文言が戻る"
  montash -C "$proj" revert HEAD --json >/dev/null
  redone=$(montash -C "$proj" text list --json)
  assert_json "$redone" '.result.clips[0].text' 'Summer Trip 2026' "revert の revert で修正が戻る"

  # テロップの焼き込みは実装済みなので、ミュートせずにそのまま再書き出しする（docs/07 §6）。
  # 実際の書き出しは step 3 で行うので、ここでは計画だけを見てテロップが映像チェーンに入るか確かめる
  out=$(montash -C "$proj" render --last -o "$proj/out/summer_trip_v2.mp4" --progress none --dry-run --json)
  assert_exit 0 "テロップを含んだままレンダー計画を作れる"
  fc=$(json_get "$out" '.result.filter_complex')
  case "$fc" in
    *subtitles=*|*drawtext=*) pass "テロップが映像チェーンに焼き込まれる" ;;
    *) fail "テロップの焼き込みがフィルタグラフに現れない" "filter_complex: $fc" ;;
  esac
else
  skip "text add/set/list が未登録なのでテキスト修正の手順を飛ばす"
fi

section "W-11 step 3: 前回のレンダー設定を再利用して再書き出し"
out=$(montash -C "$proj" render --last -o "$proj/out/summer_trip_v2.mp4" --progress none --json)
assert_exit 0 "render --last exits 0"
assert_json "$out" '.result.preset' 'web-preview' "プリセットが復元される"
assert_json "$out" '.result.resolution.width' '160' "解像度が復元される"
assert_json "$out" '.result.resolution.height' '90' "解像度が復元される"
assert_json "$out" '.result.valid' 'true' "テロップを焼いた新しい出力も厳密検証を通る"
assert_file_exists "$proj/out/summer_trip_v2.mp4" "v2 が出力される"
assert_file_exists "$proj/out/summer_trip.mp4" "v1 は残っている"

section "W-11 完了条件: 履歴が壊れていない"
out=$(montash -C "$proj" history verify --json)
assert_exit 0 "history verify exits 0"
assert_json "$out" '.result.ok' 'true' "history verify ok"

finish
