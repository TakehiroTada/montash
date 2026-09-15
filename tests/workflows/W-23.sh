#!/usr/bin/env bash
# W-23: 長い録画からハイライト候補を出す（docs/03 W-23、docs/04 §16 `suggest highlights`、docs/13 D-23）。
#
# このコマンドの肝は「候補を出すだけで、タイムラインには触れない」こと。そこを一番厚く見る。
# 書き起こしエンジン（whisper.cpp）は重い外部依存なので **本物は呼ばない**:
#   - 主の経路は `--no-transcribe`（ffmpeg の silencedetect だけ）で常に検証する
#   - 書き起こしを使う経路は W-22 と同じ疑似エンジン（このスクリプトが作る sh）で検証する
source "$(dirname "$0")/lib.sh"

root=$(tmp_project_dir)
proj="$root/project"

# 14 秒鳴って 6 秒無音、を 3 回。話のまとまりが機械的に見つかるはずの素材
src="$root/meeting.mp4"
ffmpeg_bin="${MONTASH_FFMPEG:-$(command -v ffmpeg || true)}"
if [ -z "$ffmpeg_bin" ] && [ -x "$HOME/.local/share/montash/ffmpeg/bin/ffmpeg" ]; then
  ffmpeg_bin="$HOME/.local/share/montash/ffmpeg/bin/ffmpeg"
fi
if [ -z "$ffmpeg_bin" ]; then
  skip "ffmpeg が無いので W-23 を飛ばす"
  finish
fi
"$ffmpeg_bin" -hide_banner -loglevel error -nostats -y \
  -f lavfi -i "testsrc2=s=320x180:r=30:d=60" \
  -f lavfi -i "aevalsrc=sin(2*PI*440*t)*between(mod(t\,20)\,0\,14):s=48000:d=60" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 96k -ac 2 -ar 48000 \
  -t 60 -movflags +faststart "$src" || { fail "テスト素材を作れなかった"; finish; }

montash init "$proj" --fps 30 --resolution 320x180 --json >/dev/null || exit 1
montash -C "$proj" import "$src" --id rec --json >/dev/null || exit 1

section "W-23 step 1: 候補を出す（書き起こしエンジン無しでも出せる）"
out=$(montash -C "$proj" suggest highlights --asset rec --no-transcribe --min-length 10 --json)
assert_exit 0 "suggest highlights が成功する"
assert_json "$out" '.ok' 'true' "ok: true"
count=$(json_get "$out" '.result.candidates | length')
if [ "${count:-0}" -ge 2 ]; then
  pass "無音区間から候補が 2 本以上出る（${count}）"
else
  fail "無音区間から候補が 2 本以上出る" "actual: $count"
fi
assert_json "$out" '.result.signals.transcript' 'false' "書き起こしは使っていない"
assert_json "$out" '.result.signals.silence' 'true' "無音区間は使っている"
assert_json "$out" '.result.transcript' 'null' "エンジンは呼ばれていない"

section "W-23: 候補には根拠と、そのまま打てる clip add が付く"
assert_json "$out" '.result.candidates[0].evidence.lead_silence_s | type' 'number' "直前の間の長さが載る"
assert_json "$out" '.result.candidates[0].evidence.trail_silence_s | type' 'number' "直後の間の長さが載る"
assert_json "$out" '.result.candidates[0].speech_ratio | type' 'number' "発話の割合が載る"
assert_json "$out" '.result.candidates[0].start_f | type' 'number' "フレームでも返す（§1.3a）"
case "$(json_get "$out" '.result.candidates[0].start_tc')" in
  *00:00:*) pass "タイムコードでも返す" ;;
  *) fail "タイムコードでも返す" "actual: $(json_get "$out" '.result.candidates[0].start_tc')" ;;
esac
cmd=$(json_get "$out" '.result.candidates[0].command' | tr -d '"')
case "$cmd" in
  "montash clip add --asset rec --in "*) pass "候補ごとに clip add が添えられる" ;;
  *) fail "候補ごとに clip add が添えられる" "actual: $cmd" ;;
esac

section "W-23 完了条件: タイムラインは変わっていない（決めるのは人）"
assert_json "$out" '.result.applied' 'false' "result.applied は false"
assert_json "$out" '.changes' 'null' "changes を返さない（読み取り系）"
assert_json "$out" '.op' 'null' "op を作らない"
clips=$(montash -C "$proj" clip list --json)
assert_json "$clips" '.result.clips | length' '0' "クリップは 1 本も増えていない"

section "W-23 step 2-3: 人が選んだ候補だけを置く"
in_tc=$(json_get "$out" '.result.candidates[0].start_tc' | tr -d '"')
out_tc=$(json_get "$out" '.result.candidates[0].end_tc' | tr -d '"')
placed=$(montash -C "$proj" clip add --asset rec --in "$in_tc" --out "$out_tc" --json)
assert_exit 0 "候補の時刻をそのまま clip add に渡せる"
clips=$(montash -C "$proj" clip list --json)
assert_json "$clips" '.result.clips | length' '2' "映像と音声が 1 本ずつ置かれる"

section "W-23: --max は枠を決めるだけで、枠外の候補も消えない"
out=$(montash -C "$proj" suggest highlights --asset rec --no-transcribe --min-length 10 --max 20 --json)
assert_exit 0 "--max 付きで成功する"
total=$(json_get "$out" '.result.selected_duration_s')
selected=$(json_get "$out" '.result.selected_count')
listed=$(json_get "$out" '.result.candidates | length')
if [ "$(printf '%.0f' "${total:-999}")" -le 20 ]; then
  pass "選ばれた合計が枠に収まる（${total}s）"
else
  fail "選ばれた合計が枠に収まる" "actual: $total"
fi
if [ "${listed:-0}" -gt "${selected:-0}" ]; then
  pass "枠に入らなかった候補もリストに残る（${selected}/${listed}）"
else
  fail "枠に入らなかった候補もリストに残る" "selected=$selected listed=$listed"
fi

section "W-23: --count は本数を絞る"
out=$(montash -C "$proj" suggest highlights --asset rec --no-transcribe --min-length 10 --count 1 --json)
assert_json "$out" '.result.selected_count' '1' "1 本だけ選ばれる"

section "W-23 失敗: 知らない素材"
out=$(montash -C "$proj" suggest highlights --asset nope --no-transcribe --json)
assert_exit 1 "存在しない素材は exit 1（E_ASSET_NOT_FOUND の既定）"
assert_json "$out" '.error.code' 'E_ASSET_NOT_FOUND' "E_ASSET_NOT_FOUND が返る"

section "W-23 失敗: 書き起こしを使うのにエンジンが無い（E_TRANSCRIBER_NOT_FOUND）"
out=$(montash -C "$proj" suggest highlights --asset rec --engine-path "$root/does-not-exist" --json)
assert_exit 3 "外部依存の不足なので exit 3"
assert_json "$out" '.error.code' 'E_TRANSCRIBER_NOT_FOUND' "E_TRANSCRIBER_NOT_FOUND が返る"

section "W-23 step 1（書き起こしあり）: 疑似エンジンで lead / keywords まで出す"
# 本物の whisper は重い外部依存なので E2E では呼ばない。W-22 と同じく --output-file に JSON を書くだけの sh を使う
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
 {"offsets":{"from":0,"to":13000},"text":"山笠","tokens":[
  {"text":"[_BEG_]","offsets":{"from":0,"to":0}},
  {"text":"今日は山笠の話をします。山笠は毎日走ります。山笠の準備があります。","offsets":{"from":0,"to":13000}}]},
 {"offsets":{"from":20000,"to":33000},"text":"決算","tokens":[
  {"text":"では決算の話に移ります。決算の資料を確認しました。決算の締めは来月です。","offsets":{"from":20000,"to":33000}}]},
 {"offsets":{"from":40000,"to":53000},"text":"採用","tokens":[
  {"text":"続いて採用のお知らせです。採用の面接が来週あります。採用の広報も進めます。","offsets":{"from":40000,"to":53000}}]}
]}
JSON
ENGINE
chmod +x "$engine"
model="$root/ggml-fake.bin"
: > "$model"

out=$(montash -C "$proj" suggest highlights --asset rec --engine-path "$engine" --model "$model" \
  --min-length 10 --lang ja --json)
assert_exit 0 "疑似エンジンで成功する"
assert_json "$out" '.result.signals.transcript' 'true' "書き起こしを使った"
assert_json "$out" '.result.candidates | length' '3' "話題ごとに 3 本に割れる"
assert_json "$out" '.result.candidates[0].lead' '"今日は山笠の話をします。"' "lead は先頭の文そのもの（要約しない）"
case "$(json_get "$out" '.result.candidates[0].keywords | join(",")')" in
  *山笠*) pass "keywords にその区間の語が出る" ;;
  *) fail "keywords にその区間の語が出る" "actual: $(json_get "$out" '.result.candidates[0].keywords')" ;;
esac
assert_json "$out" '.result.candidates[1].evidence.cue' '"では"' "切り出しの語が根拠に載る"
assert_json "$out" '.result.candidates[2].evidence.cue' '"続いて"' "切り出しの語が根拠に載る（2 つめ）"
if [ "$(printf '%.1f' "$(json_get "$out" '.result.candidates[1].evidence.lexical_shift')")" != "0.0" ]; then
  pass "語彙の移り変わりが根拠に載る"
else
  fail "語彙の移り変わりが根拠に載る"
fi

section "W-23: --dry-run は何も走らせない"
out=$(montash -C "$proj" suggest highlights --asset rec --engine-path "$engine" --model "$model" --dry-run --json)
assert_exit 0 "--dry-run が通る"
assert_json "$out" '.result.dry_run' 'true' "計画だけを返す"

finish
