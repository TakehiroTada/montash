# 10. AI 操作ガイド

本ソフトの主たるオペレーターは AI（LLM）です。この章は「人間の自然言語指示 → `montash` コマンド列」への翻訳規範と、AI 側のシステムプロンプトに組み込むべき指針をまとめます。

## 1. AI の基本ループ

```
1. 指示を受ける
2. 状態を確認する          montash status --json（HEAD・pending・detached。人間が Web で checkout していないか）
                           montash timeline show --json / montash clip list --json
3. 曖昧さを解決する        「2 番目」→ ID、「最後の 10 秒」→ 秒数。判断できなければ人間に短く確認
4. 変更を組み立てる        必要なら --dry-run で確認
5. 実行する（--json --yes）
6. 結果を読む              ok / warnings / error.hint / op
7. 失敗なら hint に従って修正して再実行（最大 2 回）。それでも無理なら人間に報告
8. 作業単位が完了したらコミットする   montash commit -m "<範囲> <何をしたか>" --body "<人間の指示の引用と影響>"
9. 人間に報告する          何をしたか・コミット ID・タイムライン尺・確認してほしい時刻（Web の再生位置）
```

## 2. 翻訳規範（自然言語 → コマンド）

| 人間の言い方 | 解釈 | コマンド |
|--------------|------|----------|
| 「A の 2 秒から 10 秒を使って」 | in=2, out=10 | `clip add --asset A --in 2 --out 10 --at end` |
| 「A の最後 5 秒」 | in = duration−5 | `clip add --asset A --in -5 --at end` |
| 「A の頭 3 秒を切って」 | ソース in を +3、後続を詰める | `clip trim <A のクリップ> --in +3 --ripple` |
| 「A の尻を 3 秒切って」 | out を −3 | `clip trim <id> --out -3 --ripple` |
| 「A を 0.5 秒後ろに」 | start を +0.5（後続はそのまま／詰めるかは文脈） | `clip move <id> --by +0.5` |
| 「A と B を入れ替えて」 | 順序変更 | `clip move <B> --before <A> --ripple` |
| 「12 秒のところで切って、後ろを消して」 | split → 後半（新 ID）を delete | `clip split <id> --at 12 --json` → `created.id`（例 `c7`）→ `clip delete c7 --ripple`。前半は元 ID のまま |
| 「12 秒のところで切って、前を消して」 | split → 前半（元 ID）を delete | `clip split <id> --at 12` → `clip delete <id> --ripple` |
| 「繋ぎ目を全部クロスフェードに」 | 全カット点 | `transition add --track V1 --all-cuts --type crossfade --duration 0.5` |
| 「最初はフェードイン、最後はフェードアウト」 | タイムライン先頭／末尾 | `fade --track V1 --in 1 --out 1 --with-audio` |
| 「タイトルを入れて」（位置・尺未指定） | 既定: 先頭、3 秒、title-center | `text add --text "..." --at 0 --duration 3 --preset title-center` |
| 「BGM を敷いて、声のところは下げて」 | BGM 配置 + ダッキング | `track add --kind audio --name A2` → `clip add --asset bgm --track A2 --at 0 --duration timeline --loop` → `audio duck --target A2 --sidechain A1` |
| 「音量を YouTube 向けに」 | −14 LUFS | `audio normalize --loudness -14 --true-peak -1` |
| 「YouTube 用に書き出して」 | プリセット | `render --preset youtube-1080p -o out/<name>.mp4 --progress jsonl` |
| 「縦動画も」 | 9:16 | `render --preset instagram-reel --reframe center -o out/<name>_reel.mp4` |
| 「さっきのやめて」 | 直前の op を取り消し | `undo` |
| 「テロップ入れる前に戻して」 | 該当コミットの親へ | `log --grep テロップ --json` → `checkout <k_xxxx>~1` |
| 「さっきのバージョンも残しておいて」 | タグ | `tag <name>` |
| 「今のを記録して」「ここまでで一区切り」 | コミット | `commit -m "..."` |
| 「タイトル追加だけ無しにして、他はそのまま」 | 特定コミットの取り消し | `revert <k_xxxx> -m "タイトル追加を取り消し"` |
| 「この素材どこで使ってる？」 | 使用箇所 | `assets show <id> --json`（`usage`）または `explain <id> --json` |
| 「このクリップ何だっけ？」「これ何が掛かってる？」 | 要素の説明 | `explain <id> --json`（`result.explanation` をそのまま人間に渡せる。`result.facts` で次の操作を組む） |
| 「今どうなってる？」（全体） | タイムライン要約 | `explain timeline --json` |
| 「このテロップ誰がいつ変えた？」 | 由来 | `blame x1 --json` |
| 「定型文を素材として登録して」 | テキスト素材 | `assets new-text <id> --text "..."` → `text add --asset <id> ...` |

### 時間の扱い

- 内部は整数フレーム。秒で指定すると最寄りフレームに丸められ `W_SNAPPED` が返る。**一度 CLI から返った値は `f:<n>` で再利用**する（再丸めを防ぐ）。人間には秒／タイムコードで報告する。
- Web の再生ヘッドは `f:` 表記でコピーできるので、人間が「ここ」と言った位置は `f:` で受け取るのが最も正確。
- 29.97fps では「1 秒」= 30 フレーム = 1.001 秒。「30 秒ちょうど」のような指示は `f:` に変換して人間に確認する（`f:900 = 30.03s`）。
- 負値は `--in=-10` の `=` 形式で渡す。

### 曖昧さの既定解釈

- 「N 番目」= 指定が無ければ `V1` の時間順 N 番目。V2 以上に候補があれば確認する。
- 「切る」= リップル（後続を**全トラック**で詰める。BGM・テロップも一緒に動く）。「この映像だけ詰めて、BGM はそのまま」のような指示のときだけ `--ripple=track`。「空けて」「ずらして」と言われた時だけ非リップル。
- トランジションの長さ未指定 = 0.5 秒。フェード = 1 秒。テキスト = 3 秒。
- 位置未指定のテロップ = プリセット `title-center`（冒頭）または `caption-bottom`（途中）。
- 出力先未指定 = `out/<project名>.mp4`。既存なら `_v2` を付けて上書きしない。

## 3. 必ず守ること

1. **元素材を書き換える操作は存在しない**。存在しないことを人間にも保証する。
2. `render` の前に必ず `validate --json`。error があれば render しない。
3. `--overwrite` は人間が明示的に「上書きしていい」と言った時のみ。
4. 破壊的に見える操作（`assets remove --force`, `track remove --force`, `snapshot restore`, `init --force`）は実行前に一言確認する。
5. 数値は必ず秒またはタイムコードで明示する。「少し」は 0.5 秒として提案し、確認を取る。
6. 結果報告には **クリップ ID と時刻** を含める（人間が Web で確認できるように）。
7. 同じエラーで 2 回失敗したら手を止めて人間に状況を説明する。
8. **状態変更の前に `status` を確認する**。人間が Web の History で checkout している（`detached: true`）場合は、「過去の状態 k_xxxx を表示中です。ここから編集を続けますか、最新（tip）に戻しますか」と確認する。黙って tip に戻さない。
9. **作業単位ごとにコミットする**。人間の 1 指示が完了した時点、または人間が「OK」と言った時点で `commit -m`。試行錯誤の途中はコミットしない（op は自動で残る）。1 セッションの終わりに pending を残さない。
10. Web（`actor: web`）で行われた操作は `log --ops` で把握し、人間が Web で取り込んだ素材や付けたラベルを前提に会話する。
11. **人間に「これは何か」を説明するときは `explain <id> --json` の `result.explanation` を使う**。自分で project.json から文章を組み立てない（尺・速度・字幕の扱いを取り違える）。`result.notes` に書かれた注意（プラグイン不足・素材欠落・トラックのロック）は必ず人間に伝える。

## 4. 状態確認の推奨コマンド

| 目的 | コマンド |
|------|----------|
| 履歴位置・未コミット・Web 操作の有無 | `montash status --json` / `montash log --ops --limit 10 --json` |
| 全体把握 | `montash project show --json && montash timeline show --json` |
| クリップ ID の特定 | `montash clip list --track V1 --json` |
| ある時刻に何があるか | `montash timeline show --from 11.5 --to 13 --json` |
| 特定要素の詳細 | `montash explain <id> --json`（クリップ・トランジション・トラック・アセット・ダッキング。`clip show` は未実装。04 章 §1.9） |
| 全体を 1 度で把握 | `montash explain timeline --json` |
| 何がどう書き出されるか | `montash explain render --json`（ffmpeg コマンドとフィルタグラフの注釈付き） |
| 素材の尺 | `montash assets show clip_a --json | jq .duration` |
| 実行前チェック | `montash validate --json` |
| 何が変わるか | `<command> --dry-run --json` |

## 5. エラー対応表

| `error.code` | AI の行動 |
|--------------|-----------|
| `E_RANGE_OUT_OF_ASSET` | `detail.asset_duration_f` に合わせて `f:` で再実行 |
| `W_SNAPPED` | 採用された `frame` を控え、以降は `f:<frame>` を使う。人間への報告は秒で |
| `E_SPLIT_AT_EDGE` | 分割位置がクリップ端。trim か delete の意図か確認 |
| `E_CLIP_OVERLAP` | 意図が「挿入」なら `--on-overlap push`、「置き換え」なら `overwrite`。不明なら確認 |
| `E_INSUFFICIENT_HANDLE` | `detail.max_duration` で再実行、または `--mode overlap` を提案 |
| `E_FONT_NOT_FOUND` | `hint` の候補フォントで再実行し、人間に「○○フォントを使いました」と報告 |
| `E_OUTPUT_EXISTS` | 別名（`_v2`）で保存するか上書きするか確認 |
| `E_FFMPEG_FAILED` | `detail.stderr_tail` を読む。`validate --deep` を実行。解決できなければ stderr を人間に見せる |
| `E_ASSET_MISSING` | `assets relink --search <推定ディレクトリ>` を提案 |
| `E_PLUGIN_MISSING` | `explain <id> --json` の `notes` で何が足りないかを確認し、`plugin doctor --json` を実行して人間に報告 |
| `E_CLIP_NOT_FOUND` ほか `*_NOT_FOUND`（`explain`） | `hint` の候補 ID で再実行。候補が無ければ `explain timeline --json` で全体を取り直す |
| `E_TRIM_EXCEEDS_CLIP` | クリップ削除の意図か確認 |
| `E_NOTHING_TO_UNDO` | 「これ以上戻せない」と報告 |
| `W_DETACHED_HEAD` | 過去状態にいる。人間に「ここから分岐して編集するか、tip に戻るか」を確認 |
| `W_MULTIPLE_CHILDREN`（redo） | 候補の `summary` を提示して人間に選ばせる |
| `E_NOTHING_TO_COMMIT` | 「記録すべき変更はありません」と報告 |
| `E_REVERT_CONFLICT` | 対象が既に無い。`checkout` で該当時点を見せるか、手動で相当操作を提案 |
| `W_DIRTY_WORKTREE` | `project.json` が手編集された。人間に確認して `commit --from-worktree -m "手編集"` か `checkout HEAD` |

## 6. 報告テンプレート

```
✅ 実行内容
- c2（clip_b）の頭を 0.5 秒トリム（リップル）→ タイムライン尺 44.5s → 44.0s
- c3 を c2 の前に移動
- コミット k_0008「00:12.0〜 c2 の頭を 0.5s 詰め、c3 を c2 の前へ」として記録（History に表示されます。クリックで前の状態と見比べられます）

📍 確認してほしい箇所
- 12.0s 付近（c3→c2 の繋ぎ）
- ブラウザ（http://localhost:7788）は自動更新済み。プレビュー再生成中（約 5 秒）

⚠️ 注意
- c2 と c3 の間にあったクロスフェード t2 は移動に伴い削除されました。必要なら再追加します。
```

## 7. システムプロンプト断片（例）

```
あなたは動画編集オペレーターです。編集ソフト `montash` を bash から操作します。
- 全コマンドに --json --yes を付け、出力の ok/error.hint を読んで判断します。
- 状態を変える前に必要なら --dry-run で確認します。
- 曖昧な指示（「2番目」「少し」）は clip list 等で候補を確かめ、判断できなければ短く質問します。
- 元素材は決して変更されません。誤操作は `montash undo` / `montash checkout` で戻せます。
- 状態を変える前に `montash status --json` を実行し、人間が Web で過去の状態に移動していないか（detached）を確認します。
- 人間の 1 指示が完了したら `montash commit -m "<MM:SS〜MM:SS> <何をしたか>" --body "<指示の引用と影響>"` で記録します。
- 作業後は、変更したクリップ ID・時刻・タイムライン尺・コミット ID を人間に報告し、ブラウザでの確認位置を伝えます。
- コマンド定義は `montash schema --format anthropic-tools` で取得できます。
```

## 9. コミットの粒度とメッセージ（11 章 §5 の運用）

| 状況 | 行動 |
|------|------|
| 人間の 1 指示 = 1 コマンドで完了 | そのコマンドに `-m` を付けて即コミット |
| 1 指示に複数コマンド（分割→削除→トランジション再追加 等） | op を積み、完了後に `commit -m` で 1 つにまとめる |
| 人間が Web で見て「OK」と言った | まだ pending があれば、その時点でコミット（「OK」の文言を body に引用） |
| 試行錯誤して結局元に戻した | `undo` で戻り、コミットしない（op は履歴に残るので追跡可能） |
| 節目（粗編集完了、テロップ完了、書き出し直前） | `tag rough-cut` / `tag before-render` を付ける |
| メッセージ | `MM:SS.s〜MM:SS.s <何を>` を 1 行目に。body に「指示: 「…」」と「影響: クリップ ID、全長の変化」 |

例:

```bash
montash clip split c2 --at 12.0 --json      # → kept: c2（前半）, created: c7（後半）
montash clip delete c7 --ripple
montash transition add --between c2 c3 --type crossfade --duration 0.5
montash commit -m "00:12.0〜00:15.0 の言い間違いをカットし、c2→c3 に 0.5s クロスフェード" \
  --body $'指示: 「12秒あたりの噛んだところ消して、繋ぎは自然に」\n影響: c2 を f:360 で分割、後半 c7 を削除（ripple）、t3 追加。全長 f:1335→f:1245（44.5→41.5s）'
```

## 8. `montash schema` をツール定義として使う

```bash
montash schema --format anthropic-tools > tools.json
```

各コマンドが 1 ツール（`montash_clip_add` 等）として出力される。AI 実行環境がツール呼び出しに対応していれば、bash 文字列を組み立てずに構造化引数で呼べる（実行側でそのまま `montash` を spawn）。将来は同じ定義から MCP サーバを生成する。
