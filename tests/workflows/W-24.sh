#!/usr/bin/env bash
# W-24: 書き起こしの誤認識を直して字幕を焼き直す（docs/03 W-24、docs/04 §12）。
#
# 実地の穴はこうだった。whisper が「フロントエンド運用」を「フロント演動」と外す。`--vocabulary` でも拾わない。
# 直せるのは SRT だけで、SRT は**整形の結果**なので語を 1 つ直すと 2 行 × 20 字の折り返しが崩れる
# （実際 2 文字増えて行があふれた）。そこで整形前のトークン列で直せるようにした。
#
# W-22 / W-23 と同じく **疑似エンジン**（このスクリプトが作る sh）で一連の流れを検証する。
# 本物の whisper は呼ばない（E2E が環境とモデルに依存しないように）。
source "$(dirname "$0")/lib.sh"

# TMPDIR の末尾が / のことがあるので正規化する（result のパスと文字列で突き合わせるため）
root=$(cd "$(tmp_project_dir)" && pwd)
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --id a --json >/dev/null || exit 1
montash -C "$proj" clip add --asset a --in f:0 --duration f:60 --at 0 --json >/dev/null || exit 1

# --- 疑似エンジン: 実素材で出た誤認識をそのまま返す（語は 2 トークンに割れている） ---
engine="$root/fake-whisper"
cat > "$engine" <<'ENGINE'
#!/usr/bin/env bash
prefix=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-file) prefix="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat > "$prefix.json" <<'JSON'
{"transcription":[
 {"offsets":{"from":0,"to":4400},"text":"テーマは大規模プロジェクトを支えるフロント演動のリアルです。","tokens":[
  {"text":"[_BEG_]","offsets":{"from":0,"to":0}},
  {"text":"テーマ","offsets":{"from":0,"to":500}},
  {"text":"は","offsets":{"from":500,"to":700}},
  {"text":"大規模","offsets":{"from":700,"to":1200}},
  {"text":"プロジェクト","offsets":{"from":1200,"to":1900}},
  {"text":"を","offsets":{"from":1900,"to":2000}},
  {"text":"支える","offsets":{"from":2000,"to":2500}},
  {"text":"フロント","offsets":{"from":2500,"to":3000}},
  {"text":"演動","offsets":{"from":3000,"to":3300}},
  {"text":"の","offsets":{"from":3300,"to":3400}},
  {"text":"リアル","offsets":{"from":3400,"to":3900}},
  {"text":"です","offsets":{"from":3900,"to":4300}},
  {"text":"。","offsets":{"from":4300,"to":4400}}]},
 {"offsets":{"from":4800,"to":7200},"text":"山傘の話は来週します。","tokens":[
  {"text":"山傘","offsets":{"from":4800,"to":5400}},
  {"text":"の","offsets":{"from":5400,"to":5500}},
  {"text":"話","offsets":{"from":5500,"to":5900}},
  {"text":"は","offsets":{"from":5900,"to":6000}},
  {"text":"来週","offsets":{"from":6000,"to":6600}},
  {"text":"し","offsets":{"from":6600,"to":6800}},
  {"text":"ます","offsets":{"from":6800,"to":7100}},
  {"text":"。","offsets":{"from":7100,"to":7200}}]}
]}
JSON
ENGINE
chmod +x "$engine"
model="$root/ggml-fake.bin"
: > "$model"

transcript="$proj/subtitles/rec.json"
wrong="$root/wrong.srt"
fixed="$root/fixed.srt"

# 行の折り返しがすべて語境界か（breakScore() が負の位置で割れていないか）を数える
line_check() {
  MONTASH_SRT="$1" bun -e '
    const { breakScore } = await import(`${process.env.MONTASH_REPO}/src/core/subtitle-format.ts`);
    const blocks = (await Bun.file(process.env.MONTASH_SRT).text()).trim().split("\n\n");
    let maxLen = 0, maxLines = 0, bad = 0;
    for (const block of blocks) {
      const lines = block.split("\n").slice(2).filter((l) => l !== "");
      maxLines = Math.max(maxLines, lines.length);
      for (const l of lines) maxLen = Math.max(maxLen, [...l].length);
      const body = lines.join("");
      let pos = 0;
      for (const l of lines.slice(0, -1)) {
        pos += l.length;
        if (breakScore(body, pos) < 0) bad++;
      }
    }
    process.stdout.write(`${maxLen} ${maxLines} ${bad}`);
  '
}

section "W-24 step 1: 字幕を起こし、整形前のトークンも残す"
out=$(montash -C "$proj" subtitle generate --engine-path "$engine" --model "$model" --lang ja \
  --save-transcript "$transcript" --no-add -o "$wrong" --json)
assert_exit 0 "subtitle generate --save-transcript が成功する"
assert_json "$out" '.result.saved_transcript' "$transcript" "保存先が result に出る"
assert_file_exists "$transcript" "整形前のトークンが保存されている"
assert_file_exists "$wrong" "SRT も書かれている"
if grep -q 'フロント演動' "$wrong"; then
  pass "誤認識がそのまま字幕になっている（直す前）"
else
  fail "誤認識がそのまま字幕になっている（直す前）" "$(cat "$wrong")"
fi

section "W-24 step 2: 保存した書き起こしは AI が読める形になっている"
saved=$(cat "$transcript")
assert_json "$saved" '.format' 'montash.transcript' "format が入っている"
assert_json "$saved" '.version' '1' "version が入っている"
assert_json "$saved" '.language' 'ja' "何語として起こしたかが残る"
case "$(json_get "$saved" '.text')" in
  *フロント演動*) pass "text にトークンを繋いだ本文が入る（誤認識を探す窓口）" ;;
  *) fail "text にトークンを繋いだ本文が入る" "$(json_get "$saved" '.text')" ;;
esac
case "$(json_get "$saved" '.text')" in
  *_BEG_*) fail "特殊トークンは落としてある" ;;
  *) pass "特殊トークンは落としてある" ;;
esac

section "W-24 step 4: トークンの段階で直し、整形からやり直す（エンジンは回さない）"
# エンジンもモデルも「無い」パスを渡す: 本当に呼んでいないことの証明
out=$(montash -C "$proj" subtitle generate --from-transcript "$transcript" \
  --engine-path "$root/does-not-exist" --model "$root/no-model.bin" \
  --replace "フロント演動=フロントエンド運用" --replace "山傘=山笠" \
  --no-add -o "$fixed" --json)
assert_exit 0 "エンジンもモデルも無くても通る（書き起こしを読み直すだけ）"
assert_json "$out" '.result.command' 'null' "エンジンを起動していない"
assert_json "$out" '.result.ffmpeg_command' 'null' "音声も書き出していない"
assert_json "$out" '.result.from_transcript' "$transcript" "どこから読んだかが result に出る"
assert_json "$out" '.result.replacements[0].count' '1' "置換が 1 回当たった"
assert_json "$out" '.result.replacements[1].count' '1' "2 つめの置換も当たった"
if grep -q 'フロントエンド運用' "$fixed" && grep -q '山笠' "$fixed"; then
  pass "誤認識が直っている"
else
  fail "誤認識が直っている" "$(cat "$fixed")"
fi
if grep -q 'フロント演動' "$fixed" || grep -q '山傘' "$fixed"; then
  fail "誤認識が残っていない" "$(cat "$fixed")"
else
  pass "誤認識が残っていない"
fi

section "W-24 完了条件: 語が伸びても折り返しが破綻していない"
read -r len lines bad <<EOF
$(line_check "$fixed")
EOF
if [ "${len:-99}" -le 21 ]; then pass "どの行も 20 字（+禁則の 1 字）に収まる"; else fail "どの行も 20 字に収まる" "longest: $len"; fi
if [ "${lines:-9}" -le 2 ]; then pass "1 字幕は最大 2 行"; else fail "1 字幕は最大 2 行" "max lines: $lines"; fi
if [ "${bad:-1}" -eq 0 ]; then
  pass "行の切れ目がすべて語境界（breakScore が負の位置で割れていない）"
else
  fail "行の切れ目がすべて語境界" "bad breaks: $bad" "$(cat "$fixed")"
fi

section "W-24: 字幕の出る時刻は置換で動かない（変わるのは折り返しだけ）"
before_times=$(grep -c -- '-->' "$wrong")
after_times=$(grep -c -- '-->' "$fixed")
if [ "$before_times" -eq "$after_times" ]; then
  pass "字幕の数が変わらない（$after_times 本）"
else
  fail "字幕の数が変わらない" "before: $before_times / after: $after_times"
fi
if [ "$(grep -m1 -- '-->' "$wrong")" = "$(grep -m1 -- '-->' "$fixed")" ]; then
  pass "先頭の字幕の時刻が一致する"
else
  fail "先頭の字幕の時刻が一致する" "before: $(grep -m1 -- '-->' "$wrong")" "after: $(grep -m1 -- '-->' "$fixed")"
fi

section "W-24 step 6: 規則をファイルに溜めて当て直せる"
rules="$root/terms.txt"
cat > "$rules" <<'RULES'
# 朝ミの用語（人が育てる。montash は何が誤りかを判断しない）
フロント演動=フロントエンド運用
山傘=山笠
RULES
out=$(montash -C "$proj" subtitle generate --from-transcript "$transcript" --replace-file "$rules" \
  --no-add -o "$root/from-file.srt" --json)
assert_exit 0 "--replace-file で当てられる"
if diff -q "$fixed" "$root/from-file.srt" >/dev/null; then
  pass "--replace と同じ結果になる"
else
  fail "--replace と同じ結果になる" "$(diff "$fixed" "$root/from-file.srt")"
fi

section "W-24: 直したトークンを保存し直して続きから直せる"
out=$(montash -C "$proj" subtitle generate --from-transcript "$transcript" --replace "山傘=山笠" \
  --save-transcript "$root/step2.json" --no-add -o "$root/step2.srt" --json)
assert_exit 0 "置換したトークンを保存できる"
assert_json "$(cat "$root/step2.json")" '.replacements[0].count' '1' "当てた規則が記録される"
out=$(montash -C "$proj" subtitle generate --from-transcript "$root/step2.json" \
  --replace "フロント演動=フロントエンド運用" --no-add -o "$root/step3.srt" --json)
assert_exit 0 "保存し直した書き起こしから続けられる"
if diff -q "$fixed" "$root/step3.srt" >/dev/null; then
  pass "2 回に分けて直しても同じ結果になる"
else
  fail "2 回に分けて直しても同じ結果になる" "$(diff "$fixed" "$root/step3.srt")"
fi

section "W-24 失敗: 当たらなかった規則は W_REPLACE_UNUSED で知らせる（黙って捨てない）"
out=$(montash -C "$proj" subtitle generate --from-transcript "$transcript" --replace "存在しない語=なにか" \
  --no-add -o "$root/unused.srt" --json)
assert_exit 0 "規則が当たらなくても失敗ではない"
assert_json "$out" '.warnings[0].code' 'W_REPLACE_UNUSED' "W_REPLACE_UNUSED が出る"

section "W-24 失敗: 書き起こしが無い / 読めない / 規則が壊れている"
out=$(montash -C "$proj" subtitle generate --from-transcript "$root/nope.json" --no-add -o "$root/x.srt" --json)
assert_exit 4 "無いファイルは I/O エラー（exit 4）"
assert_json "$out" '.error.code' 'E_TRANSCRIPT_NOT_FOUND' "E_TRANSCRIPT_NOT_FOUND が返る"

printf '{"transcription":[]}' > "$root/bogus.json"
out=$(montash -C "$proj" subtitle generate --from-transcript "$root/bogus.json" --no-add -o "$root/x.srt" --json)
assert_json "$out" '.error.code' 'E_TRANSCRIPT_INVALID' "montash の書き起こしでなければ E_TRANSCRIPT_INVALID"

out=$(montash -C "$proj" subtitle generate --from-transcript "$transcript" --replace "イコールが無い" \
  --no-add -o "$root/x.srt" --json)
assert_exit 2 "壊れた規則は使用法エラー（exit 2）"
assert_json "$out" '.error.code' 'E_USAGE' "E_USAGE が返る"

out=$(montash -C "$proj" subtitle generate --from-transcript "$transcript" --asset a --no-add -o "$root/x.srt" --json)
assert_exit 2 "--from-transcript と --asset は併用できない"
assert_json "$out" '.error.code' 'E_USAGE' "E_USAGE が返る"

section "W-24 step 7: 直した字幕をタイムラインに置いて焼き出せる"
out=$(montash -C "$proj" subtitle generate --from-transcript "$transcript" --replace-file "$rules" \
  -o "$proj/subtitles/rec.ja.srt" --json)
assert_exit 0 "--from-transcript でもタイムラインに置ける"
assert_json "$out" '.result.clip.track' 'T1' "テキストトラックに載る"
out=$(montash -C "$proj" subtitle list --json)
assert_json "$out" '.result.clips | length' '1' "字幕クリップが 1 本"
out=$(montash -C "$proj" render -o "$root/out.mp4" --preset web-preview --progress none --json)
assert_exit 0 "直した字幕を焼き込んでレンダーできる"
assert_file_exists "$root/out.mp4" "出力ができている"

section "W-24: suggest highlights も同じ書き起こしを使い回せる"
out=$(montash -C "$proj" suggest highlights --asset a --from-transcript "$transcript" \
  --replace "山傘=山笠" --min-length 1 --json)
if [ "$(last_exit)" -eq 0 ]; then
  assert_json "$out" '.result.transcript.from_transcript' "$transcript" "エンジンを回さずに候補を出せる"
  assert_json "$out" '.result.transcript.command' 'null' "エンジンを起動していない"
else
  # 素材が短いと候補が作れない（E_NO_HIGHLIGHTS）。書き起こしの使い回し自体は上で検証済み
  assert_json "$out" '.error.code' 'E_NO_HIGHLIGHTS' "候補が出ない場合でもエンジンは要求しない"
fi

finish
