#!/usr/bin/env bash
# W-21: 状態を説明させる（docs/04 §16 `explain`、docs/02 F-AI-4、docs/10 §4）。
# 素材を並べる → クリップ / テキスト / 字幕 / トランジション / トラック / アセット / ダッキングを説明 →
# タイムライン全体 → レンダー（ffmpeg コマンドとフィルタグラフ）→ プラグイン不足 → 失敗手順。
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
_TMP_DIRS="$root"
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --id clip_a --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/b60.mp4" --id clip_b --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/tone.wav" --id bgm --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/ja.srt" --id subs --json >/dev/null || exit 1
# c1/c2（clip_a）と c3/c4（clip_b）。c3 はハンドルを残すため in を 1s からにする
montash -C "$proj" clip add --asset clip_a --in 0 --out 2 --json >/dev/null || exit 1
montash -C "$proj" clip add --asset clip_b --in 1 --out 3 --json >/dev/null || exit 1
montash -C "$proj" transition add --track V1 --all-cuts --type crossfade --duration 0.5 --json >/dev/null || exit 1
montash -C "$proj" effect add c3 color --saturation 1.2 --brightness 0.05 --json >/dev/null || exit 1
montash -C "$proj" text add --text "Opening title" --at 0 --duration 2 --json >/dev/null || exit 1
montash -C "$proj" subtitle add --asset subs --at 0 --json >/dev/null || exit 1
montash -C "$proj" track add --kind audio --json >/dev/null || exit 1
montash -C "$proj" clip add --asset bgm --track A2 --at 0 --json >/dev/null || exit 1
montash -C "$proj" audio duck --target A2 --sidechain A1 --json >/dev/null || exit 1

section "W-21-1 クリップを説明させる（自然言語 + JSON）"
out=$(montash -C "$proj" explain c3 --json)
assert_exit 0 "explain <clip> exits 0"
assert_json "$out" '.ok' 'true' "explain ok"
assert_json "$out" '.result.kind' 'clip' "要素の分類が返る"
assert_json "$out" '.result.subtype' 'media' "クリップの種別が返る"
assert_json "$out" '.result.explanation | length > 1' 'true' "自然言語の文が複数返る"
assert_json "$out" '.result.facts.clip.duration_f' '60' "派生値（尺）が facts に入る"
assert_json "$out" '.result.facts.clip.start_f' '60' "タイムライン位置が facts に入る"
assert_json "$out" '.op' 'null' "読み取り専用なので op を作らない"
first=$(json_get "$out" '.result.explanation[0]')
case "$first" in
  *"f:30..f:90"*"clip_b"*"f:60..f:120"*"60 frames"*)
    pass "何を・どこから・どれだけ置いたかが 1 文に入る" ;;
  *) fail "何を・どこから・どれだけ置いたかが 1 文に入る" "sentence: $first" ;;
esac

section "W-21-2 掛かっている効果も説明に含まれる（effect list 相当）"
assert_json "$out" '.result.facts.effects | length' '1' "効果が facts に入る"
assert_json "$out" '.result.facts.effects[0].type' 'color' "効果名が返る"
prose=$(json_get "$out" '.result.explanation | join(" ")')
case "$prose" in
  *"color (brightness=0.05 saturation=1.2)"*) pass "効果とパラメータが文に入る" ;;
  *) fail "効果とパラメータが文に入る" "prose: $prose" ;;
esac
case "$prose" in
  *"t1"*) pass "前後のトランジションに触れる" ;;
  *) fail "前後のトランジションに触れる" "prose: $prose" ;;
esac
case "$prose" in
  *"c4"*) pass "リンクされた音声クリップに触れる" ;;
  *) fail "リンクされた音声クリップに触れる" "prose: $prose" ;;
esac

section "W-21-3 人間向け出力（--json なし）"
text=$(montash -C "$proj" explain c3)
assert_exit 0 "人間向けも exit 0"
case "$text" in
  *"c3 — media clip on track V1"*) pass "見出しが出る" ;;
  *) fail "見出しが出る" "text: $text" ;;
esac
case "$text" in
  *"See also"*"montash effect list c3 --json"*) pass "次に叩くコマンドが出る" ;;
  *) fail "次に叩くコマンドが出る" "text: $text" ;;
esac

section "W-21-4 テキスト・字幕・トランジション・トラック・アセット・ダッキング"
out=$(montash -C "$proj" explain x1 --json)
assert_json "$out" '.result.subtype' 'text' "テキストクリップを説明できる"
out=$(montash -C "$proj" explain s1 --json)
assert_json "$out" '.result.subtype' 'subtitle' "字幕クリップを説明できる"
assert_json "$out" '.result.facts.cue_span.start.f' '15' "字幕の区間は素材から算出する"
out=$(montash -C "$proj" explain t1 --json)
assert_json "$out" '.result.kind' 'transition' "トランジションを説明できる"
assert_json "$out" '.result.facts.handle.ext_from' '8' "ハンドルの伸ばし量が入る"
out=$(montash -C "$proj" explain V1 --json)
assert_json "$out" '.result.kind' 'track' "トラックを説明できる"
assert_json "$out" '.result.facts.clip_count' '2' "クリップ数が入る"
out=$(montash -C "$proj" explain clip_b --json)
assert_json "$out" '.result.kind' 'asset' "アセットを説明できる"
assert_json "$out" '.result.facts.usage.clips | length' '2' "使用箇所（usage）が入る"
out=$(montash -C "$proj" explain d1 --json)
assert_json "$out" '.result.kind' 'ducking' "ダッキングを説明できる"

section "W-21-5 タイムライン全体を説明させる"
out=$(montash -C "$proj" explain timeline --json)
assert_exit 0 "explain timeline exits 0"
assert_json "$out" '.result.kind' 'timeline' "timeline が返る"
assert_json "$out" '.result.facts.clip_count' '7' "クリップ数が合う"
assert_json "$out" '.result.facts.transition_count' '1' "トランジション数が合う"

section "W-21-6 レンダーを説明させる（ffmpeg コマンドとフィルタグラフ）"
out=$(montash -C "$proj" explain render --json)
assert_exit 0 "explain render exits 0"
assert_json "$out" '.result.kind' 'render' "render が返る"
assert_json "$out" '.result.facts.command[0] | length > 0' 'true' "ffmpeg のコマンドが返る"
assert_json "$out" '.result.facts.chains | length > 1' 'true' "フィルタグラフが連鎖ごとに割れている"
notes=$(json_get "$out" '.result.facts.chains | map(.filters[].note) | join(" ")')
case "$notes" in
  *"cut the source down to the clip's in/out range"*) pass "フィルタに注釈が付く" ;;
  *) fail "フィルタに注釈が付く" "notes: $notes" ;;
esac

section "W-21-7 プラグインが無くて解釈できないクリップ（F-EXT-4）"
bun -e '
  const path = process.argv[1];
  const project = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
  project.tracks[0].clips.push({ id: "c99", type: "confetti", start_f: 300, duration_f: 60, density: 7, effects: [] });
  require("node:fs").writeFileSync(path, JSON.stringify(project, null, 2));
' "$proj/project.json"
out=$(montash -C "$proj" explain c99 --json)
assert_exit 0 "opaque クリップでも exit 0（読み書きは通る）"
assert_json "$out" '.result.subtype' 'opaque' "opaque として説明される"
assert_json "$out" '.result.facts.interpretable' 'false' "解釈できないことが facts に出る"
notes=$(json_get "$out" '.result.notes | join(" ")')
case "$notes" in
  *E_PLUGIN_MISSING*) pass "レンダーできないことを注意に書く" ;;
  *) fail "レンダーできないことを注意に書く" "notes: $notes" ;;
esac
out=$(montash -C "$proj" explain timeline --json)
notes=$(json_get "$out" '.result.notes | join(" ")')
case "$notes" in
  *c99*) pass "timeline の説明でもプラグイン不足を挙げる" ;;
  *) fail "timeline の説明でもプラグイン不足を挙げる" "notes: $notes" ;;
esac

section "W-21 失敗: 存在しない ID は既存のエラーコードと候補"
out=$(montash -C "$proj" explain c50 --json)
assert_exit 1 "存在しないクリップは exit 1"
assert_json "$out" '.error.code' 'E_CLIP_NOT_FOUND' "E_CLIP_NOT_FOUND が返る"
hint=$(json_get "$out" '.error.hint')
case "$hint" in
  *"montash clip list --json"*) pass "hint に次の一手が入る" ;;
  *) fail "hint に次の一手が入る" "hint: $hint" ;;
esac
out=$(montash -C "$proj" explain t9 --json)
assert_json "$out" '.error.code' 'E_TRANSITION_NOT_FOUND' "ID の形から種別を当てる（transition）"
out=$(montash -C "$proj" explain V9 --json)
assert_json "$out" '.error.code' 'E_TRACK_NOT_FOUND' "ID の形から種別を当てる（track）"
out=$(montash -C "$proj" explain nosuch --json)
assert_json "$out" '.error.code' 'E_ASSET_NOT_FOUND' "それ以外はアセット扱い"

section "W-21 完了条件: schema / help から引ける（AI がツールとして使える）"
out=$(montash -C "$proj" schema explain --json)
assert_exit 0 "schema explain exits 0"
assert_json "$out" '.result[0].path' 'explain' "schema に載る"
assert_json "$out" '.result[0].mutates' 'false' "読み取り専用として宣言されている"

finish
