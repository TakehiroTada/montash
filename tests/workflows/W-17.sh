#!/usr/bin/env bash
# W-17: Web（Assets タブ）で素材を管理する（docs/03 W-17, docs/06 §2.6, §3.2, §3.3）。
#
# `montash serve` を立てて curl で叩き、ブラウザがやることをそのまま再現する:
#   GET /api/assets → POST /api/cli（assets set / new-text / remove）→ POST /api/upload
#   → /api/assets に反映 → 履歴に actor: web の op が積まれている（montash log --ops --json）
source "$(dirname "$0")/lib.sh"
root=$(tmp_project_dir)
proj="$root/project"
port=$((7800 + RANDOM % 900))
base="http://127.0.0.1:$port"
log="$root/serve.log"

montash init "$proj" --resolution 640x360 --json >/dev/null || exit 1

# 素材。テキスト・字幕は ffmpeg 不要。映像は fixtures（ffmpeg があるときだけ）
mkdir -p "$root/raw"
printf 'ナレーション原稿\n2 行目\n' > "$root/raw/narration.txt"
printf '1\n00:00:00,000 --> 00:00:02,000\nこんにちは\n\n' > "$root/raw/ja.srt"
montash -C "$proj" import "$root/raw/narration.txt" "$root/raw/ja.srt" --json >/dev/null || exit 1

# 使用中素材の削除（W-17 手順 5）には実メディアが要る。ffmpeg が無ければその節だけ飛ばす
fixtures="$MONTASH_REPO/tests/fixtures"
have_media=0
if bash "$MONTASH_REPO/scripts/make-fixtures.sh" "$fixtures" >/dev/null 2>&1 && [ -f "$fixtures/a.mp4" ]; then
  cp "$fixtures/a.mp4" "$root/raw/a.mp4"
  if montash -C "$proj" import "$root/raw/a.mp4" --json >/dev/null 2>&1 &&
    montash -C "$proj" clip add --asset a --in f:0 --out f:30 --json >/dev/null 2>&1; then
    have_media=1
  fi
fi

section "W-17 serve を起動する"
bun "$MONTASH_REPO/src/cli/index.ts" serve -C "$proj" --port "$port" --no-auto-preview > "$log" 2>&1 &
serve_pid=$!
cleanup() {
  kill "$serve_pid" 2>/dev/null
  wait "$serve_pid" 2>/dev/null
}
trap cleanup EXIT

ready=0
for _ in $(seq 1 100); do
  if curl -fsS "$base/api/status" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$serve_pid" 2>/dev/null; then break; fi
  sleep 0.2
done
if [ "$ready" != "1" ]; then
  fail "serve が起動しない" "$(cat "$log")"
  finish
fi
pass "serve が $base で応答する"

api_get() { curl -fsS "$base$1"; }
api_cli() {
  curl -sS -o "$root/resp.json" -w '%{http_code}' -X POST "$base/api/cli" \
    -H 'content-type: application/json' -d "$1"
}

section "W-17-1 素材一覧を見る（GET /api/assets）"
out=$(api_get /api/assets)
assert_json "$out" '.assets[0].id' 'narration' "テキスト素材が一覧に出る"
assert_json "$out" '.assets[1].id' 'ja' "字幕素材が一覧に出る"
assert_json "$out" '.assets[0].missing' 'false' "原本が存在する"
assert_json "$out" '.assets[0].usage.clips' '[]' "未使用（usage が空）"
out=$(api_get /api/assets/narration)
assert_json "$out" '.asset.type' 'text' "詳細 API が type を返す"
case "$out" in
  *"ナレーション原稿"*) pass "詳細 API がテキスト本文を返す" ;;
  *) fail "詳細 API がテキスト本文を返す" "$out" ;;
esac
code=$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/assets/narration/file")
if [ "$code" = "200" ]; then pass "原本を /file から配信できる"; else fail "原本を /file から配信できる" "HTTP $code"; fi
code=$(curl -sS -o /dev/null -w '%{http_code}' "$base/api/assets/narration/proxy.mp4")
if [ "$code" = "404" ]; then pass "プロキシが無ければ 404"; else fail "プロキシが無ければ 404" "HTTP $code"; fi

section "W-17-4 ラベル・タグを付けて整理する（assets set）"
code=$(api_cli '{"args":["assets","set","narration","--label","ナレーション","--tags","原稿,音声"]}')
if [ "$code" = "200" ]; then pass "POST /api/cli assets set が 200"; else fail "POST /api/cli assets set が 200" "HTTP $code"; fi
out=$(cat "$root/resp.json")
assert_json "$out" '.ok' 'true' "assets set が成功する"
assert_json "$out" '.exec.actor' 'web' "actor: web で実行された"
out=$(api_get /api/assets)
assert_json "$out" '.assets[0].label' 'ナレーション' "ラベルが /api/assets に反映される"
assert_json "$out" '.assets[0].tags[1]' '音声' "タグが /api/assets に反映される"

section "W-17-3 テキスト素材を作る（assets new-text）"
code=$(api_cli '{"args":["assets","new-text","title_main","--text","Summer Trip 2026","--label","見出し"]}')
if [ "$code" = "200" ]; then pass "POST /api/cli assets new-text が 200"; else fail "POST /api/cli assets new-text が 200" "HTTP $code"; fi
assert_json "$(cat "$root/resp.json")" '.ok' 'true' "assets new-text が成功する"
out=$(api_get /api/assets/title_main)
assert_json "$out" '.text' 'Summer Trip 2026' "作った本文が詳細 API から読める"
assert_file_exists "$proj/assets/text/title_main.txt" "assets/text/title_main.txt が作られた"

section "W-17-2 ファイルをアップロードして取り込む（POST /api/upload）"
printf 'アップロードされた原稿\n' > "$root/uploaded.txt"
code=$(curl -sS -o "$root/upload.json" -w '%{http_code}' -X POST "$base/api/upload" -F "file=@$root/uploaded.txt")
if [ "$code" = "200" ]; then pass "POST /api/upload が 200"; else fail "POST /api/upload が 200" "HTTP $code $(cat "$root/upload.json")"; fi
out=$(cat "$root/upload.json")
assert_json "$out" '.ok' 'true' "アップロード後の import が成功する"
assert_json "$out" '.result.imported[0].id' 'uploaded' "assets/incoming/ に保存したファイルが取り込まれた"
day=$(date +%Y%m%d)
assert_file_exists "$proj/assets/incoming/$day/uploaded.txt" "assets/incoming/<YYYYMMDD>/ に保存された"
out=$(api_get /api/assets)
case "$out" in
  *'"uploaded"'*) pass "一覧に素材が増えた" ;;
  *) fail "一覧に素材が増えた" "$out" ;;
esac

section "W-17-5 使用箇所と、使用中素材の削除確認（assets remove）"
if [ "$have_media" = "1" ]; then
  # 映像 + リンクした音声の 2 クリップ。usage は start_f → track 順（A1 が先）
  out=$(api_get /api/assets/a)
  assert_json "$out" '.asset.usage.clips[0].track' 'A1' "使用箇所（音声クリップ）が詳細に出る"
  assert_json "$out" '.asset.usage.clips[1].clip_id' 'c1' "使用箇所（clip_id）が詳細に出る"
  assert_json "$out" '.asset.usage.clips[1].track' 'V1' "使用箇所（track）が詳細に出る"
  code=$(api_cli '{"args":["assets","remove","a"]}')
  assert_json "$(cat "$root/resp.json")" '.error.code' 'E_ASSET_IN_USE' "使用中の削除は E_ASSET_IN_USE"
  code=$(api_cli '{"args":["assets","remove","a","--force"]}')
  if [ "$code" = "409" ]; then pass "使用中素材の --force は confirm 無しだと 409"; else fail "使用中素材の --force は confirm 無しだと 409" "HTTP $code"; fi
  code=$(api_cli '{"args":["assets","remove","a","--force"],"confirm":true}')
  assert_json "$(cat "$root/resp.json")" '.ok' 'true' "confirm: true なら参照クリップごと削除できる"
  assert_json "$(cat "$root/resp.json")" '.result.clips[0].id' 'c1' "参照クリップも削除された"
else
  skip "使用中素材の削除確認" "ffmpeg（tests/fixtures）が無いのでスキップ"
fi

code=$(api_cli '{"args":["assets","remove","title_main","--force"]}')
if [ "$code" = "409" ]; then pass "--force は confirm 無しだと 409"; else fail "--force は confirm 無しだと 409" "HTTP $code"; fi
assert_json "$(cat "$root/resp.json")" '.error.code' 'E_CONFIRM_REQUIRED' "E_CONFIRM_REQUIRED が返る"
code=$(api_cli '{"args":["assets","remove","title_main","--force"],"confirm":true}')
assert_json "$(cat "$root/resp.json")" '.ok' 'true' "confirm: true なら削除できる"
out=$(api_get /api/assets)
case "$out" in
  *'"title_main"'*) fail "削除した素材が一覧から消える" "$out" ;;
  *) pass "削除した素材が一覧から消える" ;;
esac

section "W-17 タイムライン編集コマンドは Web から実行できない（docs/06 §1.2）"
code=$(api_cli '{"args":["clip","add","--asset","narration"]}')
if [ "$code" = "403" ]; then pass "clip add は 403"; else fail "clip add は 403" "HTTP $code"; fi
assert_json "$(cat "$root/resp.json")" '.error.code' 'E_WEB_COMMAND_NOT_ALLOWED' "E_WEB_COMMAND_NOT_ALLOWED が返る"

section "W-17 完了条件: 履歴に actor: web の op が積まれている"
out=$(montash -C "$proj" log --ops --json)
assert_exit 0 "log --ops が成功する"
if MONTASH_LOG_JSON="$out" bun -e '
  const view = JSON.parse(process.env.MONTASH_LOG_JSON);
  // op は commits[].ops と pending[] のどちらにも現れうる（docs/11）
  const ops = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      if (typeof v.id === "string" && typeof v.actor === "string" && typeof v.summary === "string") ops.push(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(view.result);
  const web = ops.filter((o) => o.actor === "web").map((o) => o.summary);
  const want = ["set metadata", "text asset", "import", "remove asset"];
  const missing = want.filter((w) => !web.some((s) => s.includes(w)));
  if (web.length === 0) { console.error("no actor:web op in log --ops"); process.exit(1); }
  if (missing.length) { console.error("missing web ops for " + missing.join(", ") + "; got " + JSON.stringify(web)); process.exit(1); }
  console.log(web.length + " web ops");
' > "$root/webops.txt" 2>"$root/webops.err"; then
  pass "actor: web の op が履歴に積まれている（$(cat "$root/webops.txt")）"
else
  fail "actor: web の op が履歴に積まれている" "$(cat "$root/webops.err")"
fi

cleanup
trap - EXIT
finish
