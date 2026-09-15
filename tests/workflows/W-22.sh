#!/usr/bin/env bash
# W-22: 音声から字幕を起こす（docs/03 W-22、docs/04 §12 `subtitle generate`）。
#
# 書き起こしエンジン（whisper.cpp）は montash に組み込まないので、環境に無いのが普通。
#   - 疑似エンジン（このスクリプトが作る sh）で一連の流れを常に検証する
#     （音声の書き出し〜整形〜SRT〜import〜subtitle add までは本物が走る）
#   - 本物のエンジン + モデルが入っているときだけ、実際の起動を確かめる（無ければ skip）
source "$(dirname "$0")/lib.sh"

root=$(tmp_project_dir)
proj="$root/project"
fixtures="$MONTASH_REPO/tests/fixtures"
bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null || exit 1

montash init "$proj" --fps 30 --resolution 640x360 --json >/dev/null || exit 1
montash -C "$proj" import "$fixtures/a.mp4" --id a --json >/dev/null || exit 1
montash -C "$proj" clip add --asset a --in f:0 --duration f:60 --at 0 --json >/dev/null || exit 1

# --- 疑似エンジン: --output-file の接頭辞に whisper.cpp 形式の JSON を書くだけ ---
engine="$root/fake-whisper"
cat > "$engine" <<'ENGINE'
#!/usr/bin/env bash
prefix=""
prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-file) prefix="$2"; shift 2 ;;
    --prompt) prompt="$2"; shift 2 ;;
    *) shift ;;
  esac
done
# 用語リストが渡されたかどうかで結果を変える（W-22 の「用語リストで直す」を再現）
if [ -n "$prompt" ]; then
  first='多面観察'
else
  first='ためんかんさつ'
fi
cat > "$prefix.json" <<JSON
{"transcription":[
 {"offsets":{"from":0,"to":2100},"text":"今日は事前ガイダンスの話です。","tokens":[
  {"text":"[_BEG_]","offsets":{"from":0,"to":0}},
  {"text":"今日","offsets":{"from":0,"to":300}},
  {"text":"は","offsets":{"from":300,"to":420}},
  {"text":"事前","offsets":{"from":420,"to":800}},
  {"text":"ガ","offsets":{"from":800,"to":900}},
  {"text":"イダンス","offsets":{"from":900,"to":1400}},
  {"text":"の","offsets":{"from":1400,"to":1500}},
  {"text":"話","offsets":{"from":1500,"to":1800}},
  {"text":"です","offsets":{"from":1800,"to":2000}},
  {"text":"。","offsets":{"from":2000,"to":2100}}]},
 {"offsets":{"from":2400,"to":4900},"text":"${first}は総括次長がまとめます。","tokens":[
  {"text":"${first}","offsets":{"from":2400,"to":3200}},
  {"text":"は","offsets":{"from":3200,"to":3300}},
  {"text":"総括","offsets":{"from":3300,"to":3700}},
  {"text":"次長","offsets":{"from":3700,"to":4100}},
  {"text":"が","offsets":{"from":4100,"to":4200}},
  {"text":"まとめ","offsets":{"from":4200,"to":4600}},
  {"text":"ます","offsets":{"from":4600,"to":4800}},
  {"text":"。","offsets":{"from":4800,"to":4900}}]}
]}
JSON
ENGINE
chmod +x "$engine"
model="$root/ggml-fake.bin"
: > "$model"

section "W-22 step 1: doctor がエンジンの有無を報告する"
out=$(montash doctor --json)
assert_exit 0 "doctor exits 0"
found=$(json_get "$out" '.result.transcriber.found')
case "$found" in
  true|false) pass "doctor が result.transcriber.found を返す（${found}）" ;;
  *) fail "doctor が result.transcriber.found を返す" "actual: $found" ;;
esac

section "W-22 失敗: エンジンが無い（E_TRANSCRIBER_NOT_FOUND）"
out=$(montash -C "$proj" subtitle generate --engine-path "$root/does-not-exist" --model "$model" --json)
assert_exit 3 "外部依存の不足なので exit 3"
assert_json "$out" '.error.code' 'E_TRANSCRIBER_NOT_FOUND' "E_TRANSCRIBER_NOT_FOUND が返る"
case "$(json_get "$out" '.error.hint')" in
  *whisper*) pass "hint に導入方法が入っている" ;;
  *) fail "hint に導入方法が入っている" ;;
esac
if [ -e "$proj/subtitles" ]; then fail "エンジンが無いときは何も書かない"; else pass "エンジンが無いときは何も書かない"; fi

section "W-22 失敗: モデルが無い（E_TRANSCRIBER_MODEL_NOT_FOUND）"
out=$(montash -C "$proj" subtitle generate --engine-path "$engine" --model "$root/no-model.bin" --json)
assert_exit 3 "exit 3"
assert_json "$out" '.error.code' 'E_TRANSCRIBER_MODEL_NOT_FOUND' "E_TRANSCRIBER_MODEL_NOT_FOUND が返る"

section "W-22 step 3: 書き起こして SRT を作り、字幕クリップとして置く"
out=$(montash -C "$proj" subtitle generate --engine-path "$engine" --model "$model" --lang ja --json)
assert_exit 0 "subtitle generate が成功する"
assert_json "$out" '.ok' 'true' "ok: true"
assert_json "$out" '.result.cues' '2' "文ごとに 2 つの字幕になる"
assert_json "$out" '.result.language' 'ja' "言語が記録される"
assert_json "$out" '.result.clip.mode' 'burn' "既定は焼き込み"
assert_json "$out" '.result.clip.track' 'T1' "テキストトラックに載る"
srt=$(json_get "$out" '.result.srt' | tr -d '"')
assert_file_exists "$srt" "SRT が書かれている"

section "W-22 整形: 語の途中で切らず、2 行 20 字に収まる"
if grep -q '^今日は事前ガイダンスの話です。$' "$srt"; then
  pass "文の単位で 1 字幕になっている"
else
  fail "文の単位で 1 字幕になっている" "$(cat "$srt")"
fi
if grep -q 'イダンス$' "$srt" || grep -q '^イダンス' "$srt"; then
  fail "カタカナ語の途中で切れていない（事前ガ / イダンス）" "$(cat "$srt")"
else
  pass "カタカナ語の途中で切れていない（事前ガ / イダンス）"
fi
# 文字数（バイト数ではない）で数える。1 字幕 = 最大 2 行 × 20 字（禁則のぶら下げで +1 まで）
long=$(MONTASH_SRT="$srt" bun -e '
  const lines = (await Bun.file(process.env.MONTASH_SRT).text()).split("\n");
  const body = lines.filter((l) => l !== "" && !/^\d+$/.test(l) && !l.includes("-->"));
  process.stdout.write(String(Math.max(0, ...body.map((l) => [...l].length))));
')
if [ "${long:-0}" -le 21 ]; then pass "どの行も 20 字（+禁則の 1 字）に収まる"; else fail "どの行も 20 字に収まる" "longest: $long"; fi
lines=$(MONTASH_SRT="$srt" bun -e '
  const blocks = (await Bun.file(process.env.MONTASH_SRT).text()).trim().split("\n\n");
  process.stdout.write(String(Math.max(0, ...blocks.map((b) => b.split("\n").length - 2))));
')
if [ "${lines:-0}" -le 2 ]; then pass "1 字幕は最大 2 行"; else fail "1 字幕は最大 2 行" "max lines: $lines"; fi

section "W-22 完了条件: 素材と字幕クリップが登録されている"
out=$(montash -C "$proj" subtitle list --json)
assert_json "$out" '.result.clips | length' '1' "字幕クリップが 1 本"
assert_json "$out" '.result.clips[0].format' 'srt' "SRT として登録されている"
assert_json "$out" '.result.clips[0].lang' 'ja' "言語が付いている"

section "W-22 失敗: 同じ出力先は E_OUTPUT_EXISTS"
out=$(montash -C "$proj" subtitle generate --engine-path "$engine" --model "$model" --lang ja --json)
assert_exit 4 "上書き防止で exit 4"
assert_json "$out" '.error.code' 'E_OUTPUT_EXISTS' "E_OUTPUT_EXISTS が返る"

section "W-22 step 4: 認識精度が低いときは用語リストで直す"
out=$(montash -C "$proj" subtitle generate --engine-path "$engine" --model "$model" --lang ja \
  --vocabulary "多面観察,総括次長" --overwrite --no-add -o "$root/fixed.srt" --json)
assert_exit 0 "用語リスト付きで再実行できる"
assert_json "$out" '.result.vocabulary' '["多面観察","総括次長"]' "用語リストが記録される"
assert_json "$out" '.result.asset' 'null' "--no-add なので素材は増えない"
if grep -q '多面観察' "$root/fixed.srt"; then
  pass "用語リストで固有名詞が直る"
else
  fail "用語リストで固有名詞が直る" "$(cat "$root/fixed.srt")"
fi
out=$(montash -C "$proj" subtitle list --json)
assert_json "$out" '.result.clips | length' '1' "--no-add はタイムラインを変えない"

section "W-22 step 7: 焼き込んで書き出せる"
out=$(montash -C "$proj" render -o "$root/out.mp4" --preset web-preview --progress none --json)
assert_exit 0 "生成した字幕を焼き込んでレンダーできる"
assert_file_exists "$root/out.mp4" "出力ができている"

section "W-22 本物のエンジン（あれば）"
real_engine=$(command -v whisper-cli || command -v whisper-cpp || true)
real_model=$(ls "$HOME/.local/share/montash/whisper/"*.bin 2>/dev/null | head -1 || true)
if [ -z "$real_engine" ] || [ -z "$real_model" ]; then
  skip "本物の書き起こしエンジンが無いので飛ばす" \
    "engine: ${real_engine:-not found} / model: ${real_model:-not found}" \
    "導入: brew install whisper-cpp + ggml モデルを ~/.local/share/montash/whisper/ へ"
else
  out=$(montash -C "$proj" subtitle generate --lang ja --dry-run --json)
  assert_exit 0 "本物のエンジンで --dry-run が通る"
  assert_json "$out" '.result.dry_run' 'true' "計画だけを返す"
  case "$(json_get "$out" '.result.engine.path')" in
    *whisper*) pass "検出したエンジンを使う" ;;
    *) fail "検出したエンジンを使う" ;;
  esac
fi

finish
