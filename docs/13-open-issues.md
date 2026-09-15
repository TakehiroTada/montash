# 13. 未解決の懸念一覧（Open Issues）

実装着手前の時点で残っている懸念を、**A. 仕様として決めが必要**／**B. 技術リスク（spike で潰す）**／**C. 進め方・体制** に分けて管理する。解決したら「状態」を更新し、決定は 12 章（ADR）へ移す。

凡例 — 優先度: **高** = M0/M1 着手前に決める／潰す、**中** = 該当マイルストーン前、**低** = v1.0 まで。状態: `open` / `decided(ADR-xx)` / `spiked` / `done` / `wontfix`。

## A. 仕様として決めが必要なもの（人間の判断）

| ID | 優先度 | 懸念 | 影響 | 推奨 | 状態 |
|----|--------|------|------|------|------|
| A-1 | **高** | **ID 採番と履歴分岐の衝突**: 連番カウンタを `project.json` に持つと `checkout` で巻き戻り、別系列に同じ ID が生まれる | 履歴のトレーサビリティが崩れる | 連番カウンタを `project.json` 外（`.montash/ids.json`、履歴対象外、単調増加）に置く。`ids rebuild` で復元可 | decided（ADR-13） |
| A-2 | **高** | **`probe` 生 JSON による履歴 object の肥大化** | ディスク、`checkout` 速度 | 生 JSON を `.montash/cache/<id>/probe.json` へ、`project.json` は要約のみ | decided（ADR-14） |
| A-3 | **高** | **ffmpeg 6.0 要件と Ubuntu 22.04（apt は 4.4.2）** | 主要ターゲットで導入に失敗 | 機能検出で判定（4.4 未満 outdated、6.0 未満 best effort）。Linux/WSL は `install-deps.sh` が static ビルドを `~/.local` に導入 | decided（ADR-15） |
| A-4 | **高** | **リップルの範囲が未定義** | テロップ／BGM のズレ | 既定は全トラックリップル、`--ripple=track` で限定、`locked` トラックは除外 | decided（ADR-16） |
| A-5 | 中 | Web アップロードの上限とメモリ: `req.formData()` はメモリに載る可能性。8GB は危険 | サーバ OOM | 上限を **2GB** に下げ、それ以上は「パス指定取り込み」を UI で案内。ストリーミング保存は B-3 の結果で判断 | open |
| A-6 | 中 | 履歴 DAG の v1 スコープ: `revert` / `reset --hard` / `W_DIRTY_WORKTREE`（手編集検出）/ `commit --amend` を v1 に含めるか | 実装・テスト負荷 | v1 は **線形 + 分岐は保持して閲覧のみ**（`checkout`/`undo`/`redo`/`tag`/`commit`/`log`/`show`/`diff`/`blame`）。`revert`/`reset`/`amend` は M4 以降。09 章の通り | decided（09 章） |
| A-7 | 中 | Web の `import <任意パス>` はローカル全ファイルを読める。`--host 0.0.0.0` 時のリスク | 情報漏えい（LAN 公開時） | 単一ユーザー・localhost 前提で許容。`--host` が loopback 以外なら **`--read-only` を強制**（明示 `--allow-remote-write` で解除）。06 章 §3.1 に追記 | open |
| A-8 | 中 | 素材パスの可搬性: 既定が絶対パス参照。プロジェクトを別マシン／外付けへ移すと全再リンク | 運用コスト | 既定は現状維持（大容量コピーを避ける）だが、`init --copy-assets` でプロジェクト単位の既定を切替可能に。`relink --search` で救済 | open |
| A-9 | 低 | `offset_smp`（音声サブフレーム補正）を v1 に含めるか | 機能範囲 | Should のまま（M3）。リンク解除 UI と併せて実装 | decided |
| A-10 | 低 | drop-frame タイムコード（`HH:MM:SS;FF`）表示 | 放送用途の利便性 | v1 は非対応（`HH:MM:SS.mmm` と `f:` のみ）。Could | decided |
| A-11 | 低 | `markup: ass` の既定化（AI が行内タグを直接書けるが、`{`/`}` を含む本文が壊れる） | 可読性 vs 表現力 | 既定は `plain`。AI ガイドで「装飾が要るときだけ `--markup ass`」 | decided |
| A-12 | 低 | 日本語ファイル名の Unicode 正規化（macOS は NFD、Linux は NFC）で `relink --match name` が外れる | 再リンク失敗 | 名前照合時に NFC 正規化して比較。`hash_head` 照合が最終手段 | open |

## B. 技術リスク（M0/M1 の spike で潰す）

| ID | 優先度 | 懸念 | 検証内容 | 判定基準 | 状態 |
|----|--------|------|----------|----------|------|
| B-1 | 中 | `Bun.spawn` での長時間 ffmpeg 制御 | `-progress pipe:1` のストリーム逐次読み取り、SIGTERM でのキャンセルと後片付け、stderr 末尾の捕捉、exit code、サーバ異常終了時の子プロセス残留 | 60 秒のレンダーで進捗が 1 秒間隔で届き、キャンセル後 1 秒以内にプロセスが消える | spiked（`src/ffmpeg/run.ts`、macOS / Bun 1.3.14 / ffmpeg 9.0.1）。進捗は既定 `-stats_period` の **0.5 秒間隔**（実測 501〜505ms、`progressIntervalS` で変更可）で stdout から逐次届く。キャンセルは abort → SIGTERM → ffmpeg が exit 255 で自終了、**abort から 8〜15ms** で `E_FFMPEG_CANCELLED` が返り子プロセス残留なし（2 秒の猶予後 SIGKILL も実装）。stderr は末尾 30 行を保持し `detail.stderr_tail` に格納。残課題: サーバ異常終了時の子プロセス残留（M2 `serve` で検証） |
| B-2 | 中 | コンパイル済みバイナリの自己 spawn と埋め込み資産 | `process.execPath` で自分を起動して `checkout` が動くか、`web/dist` を埋め込んで `Bun.file` 配信できるか、`--target` クロスコンパイル | 3 OS のバイナリで `montash serve` → History クリックが動く | deferred（M2 `serve` / M5 配布時に検証） |
| B-3 | 中 | 大容量 multipart アップロード | `req.formData()` のメモリ挙動、ストリーム直書き | 2GB アップロードで RSS が +200MB 以内 | deferred（M3 `upload.ts` 実装時。上限 2GB は A-5 で決定） |
| B-4 | 中 | `xfade=offset`（秒指定）と 29.97fps のフレーム境界 | ゴールデンテスト（08 章 §6）で合成後フレーム数と各カット点を検証 | 30 / 29.97 / 59.94 で `duration_f` 厳密一致 | deferred（M1 のゴールデンテストで事実上検証） |
| B-5 | 中 | libass の `BorderStyle=4`、`fontsdir=`、`original_size` の挙動とバージョン差 | Ubuntu 22.04 / 24.04 / brew の libass で背景ボックス・CJK フォールバック・プロキシ解像度での縮尺を目視＋PSNR | 3 環境で同じ位置・折り返し | open |
| B-6 | 中 | chokidar 4 の Linux / WSL 挙動（検証は macOS のみ） | ext4 と `/mnt/c` で `tmp→rename` 保存と `ops.jsonl` 追記の検知、`usePolling` フォールバック | 500ms 以内に検知 | open |
| B-7 | 中 | 単一 `-filter_complex` の入力数・グラフ長の上限 | 50 クリップ + 20 テキスト + 3 トラックでコマンド長・ffmpeg のメモリ・起動時間 | 起動 2 秒以内。超えるなら `split` 方式／セグメント分割へ | open |
| B-8 | 中 | プレビューの cold cache 時間 | 10 分・10 クリップのタイムラインで初回 `preview build` の所要時間（N-4: 1 分以内） | 1 分以内。超えるなら並列度・プロキシ解像度を調整 | open |
| B-9 | 中 | HTML import 開発サーバと本番ビルドの差（HMR 時の zustand ストア保持、CSS 取り扱い） | `bun --hot` での状態保持、`bun build` 後の相対パス | 開発／本番で同じ表示 | open |
| B-10 | 低 | `history` object の gzip と `checkout` 速度 | 1000 op・object 200KB で `checkout` 所要時間 | 50ms 以内 | open |
| B-11 | 低 | yargs の負数引数（`--in -10`）と `-m` の他オプションとの衝突 | `--in=-10` 案内、`-m` を message 専用に固定（`--margin` は長形式のみ） | strict モードでエラーにならない | open |

## C. 進め方・体制

| ID | 優先度 | 懸念 | 対応 | 状態 |
|----|--------|------|------|------|
| C-1 | **高** | スコープ規律: 仕様は約 80 コマンド・3,300 行。M0/M1 の縦一本（`doctor / init / import / clip add / timeline show / render(concat) / status / commit / undo / checkout`）から外れない | 09 章のマイルストーンを Issue 化し、S/C 項目は M3 以降のラベルで凍結 | open |
| C-2 | **高** | `cli-video-editor/` が git 管理外 | 実装前に `git init`。仕様の変更も履歴に乗せる | done（GitHub: TakehiroTada/montash。仕様も履歴に載っている） |
| C-3 | **高** | 開発機に ffmpeg 未導入 | `bash scripts/install-deps.sh` を実行（brew） | done（ffmpeg-full 9.0.1 = libass 入りを `~/.local/share/montash/ffmpeg` に導入。ADR-15） |
| C-4 | 中 | WSL2 実機テスターがいない | 早期に 1 名確保、または CI の `windows-latest` + WSL で代替 | open |
| C-5 | 中 | 仕様と実装の乖離: `montash schema` ↔ 04 章の CI 差分チェックが M5 予定 | M1 で `defineCommand` → 04 章の表を生成する簡易スクリプトを先に作る | open |
| C-6 | 中 | AI に渡すコンテキスト量: 仕様全体は大きすぎる | AI 運用は **10 章 + `montash schema` 出力** だけで完結する設計を維持。10 章を独立して読める状態に保つ | open |
| C-7 | 低 | `scripts/spikes/` の再実行を忘れる | Bun 更新 PR で `bun run all` を CI に含める | open |

## D. 実装の不具合・改善（実機確認で判明）

M1〜M3 の実装が動くようになってから、実際に触って見つかったもの。優先度: **高** = 体験を明確に損なう、**中** = 気づく人は気づく、**低** = 好みの範囲。

| ID | 優先度 | 症状 / 食い違い | あるべき姿 | 状態 |
|----|--------|------------------|------------|------|
| D-1 | 中 | **編集タイムラインでテキスト・字幕クリップが幅を持って描かれない**。`text add --duration 2.5`（75 フレーム）のクリップが T1 上で 2px の縦線にしかならない。原因はクリップの長さの持ち方が種別で違う（映像・音声は `in_f`/`out_f`/`speed`、テキストは `duration_f`、字幕はどちらも持たない）のに、Web が全クリップを `in_f`/`out_f` で計算していたこと | `GET /api/project` に `computed`（`start_f`/`end_f`/`duration_f`/`label`）を追加し、種別ごとの分岐をサーバ 1 箇所（`src/server/computed.ts`）へ集約。字幕は素材（SRT/VTT/ASS）の最初と最後の表示から区間を起こす | **done**（PR #26） |
| D-2 | 低 | **タイムラインの時間軸がプロジェクト尺より長い**。6 秒のプロジェクトで目盛りが 10s まで伸び、右 4 割が空白になる（既定スケールが `max(尺, 10 秒)` 固定だった） | 既定は **尺 + 1 秒の余白**。尺 0 のときだけ 10 秒へフォールバック。`timelineScaleFrames(zoom)` はユーザーが広げた状態を維持する（`web/src/lib/timeline.ts`） | **done**（PR #26） |
| D-3 | 低 | **`style.line_spacing` が ASS に反映されない**。ASS の Style に行間の項目が無く（`Spacing` は字間）、保存はされるが描画に効かない | `\fsp` ではなく行間を変える手段（複数 Dialogue に分割して `\pos` をずらす等）を実装するか、仕様から落として docs/05 §6.2 から削る。**現状は「保存されるが無視される」ことを docs に明記するのが最低ライン** | docs 明記済み（PR #28）。行間の実装自体は open |
| D-4 | 中 | **`audio duck --attack/--release` の単位が docs 内で食い違う**。docs/04 §11 は ms、docs/03 W-07 は秒。実装は `500` / `500ms` / `0.5s` を受け、単位なしで 10 未満なら秒と推測して `W_TIME_UNIT_GUESSED` を返す | **ms に統一**して docs/03 を直す。推測は互換のため残してよいが、docs には ms だけを書く | **done**（PR #28: docs/03 を ms に統一、docs/04 に単位の注記） |
| D-5 | 中 | **`clip add` のロジックが CLI ハンドラにインライン**で、`core/timeline.ts` に `addClip` が無い。`overlay add` は同じ処理を別実装で組み直しており（#23）、今後 `subtitle add` 等でも重複する | クリップ生成・配置・リンク音声・重なり解消を `core/` の関数に括り出し、`clip add` / `overlay add` / `text add` / `subtitle add` が共有する | 対応済み（`core/clip-create.ts` の `addClip()` / `assertSourceRange()`、`core/timeline.ts` の `counterpartTrackId()`、`core/clip-editing.ts` の `carveRange()`。`clip add` / `overlay add` が共有。`text add` / `subtitle add` はクリップの形が違う（`duration_f` 直接・`in_f`/`out_f` 無し）ので `requireTrack` / `assertPlacement` の共有に留める） |
| D-6 | 中 | **CI の matrix から macOS が外れている**（`macOS runners are temporarily paused to limit Actions spending.`）。3 OS 対応を掲げているのに検証は ubuntu のみ | コストと相談のうえ、少なくとも **main への push 時だけ macOS を走らせる**（PR は ubuntu のみ）などの折衷にする | open（要判断） |
| D-7 | 低 | **`render --dry-run` の `result.command` が文字列**。docs/04 §14 は配列（AI がパースしやすく、シェルのクォート事故がない） | 配列にする | PR #24 で対応中 |
| D-8 | 中 | **History ストリップのノードを誤クリックしやすい**。ブラウザを開いたまま放置していた間に意図しない `checkout` が走り、タイムラインが init 直後（空）に戻っていた（2026-09-15 に 2 回発生）。履歴は失われないので実害は小さいが、気づかないまま「編集が消えた」と見える | 誤操作を減らす（クリック判定をノード本体に限定する、detached 時の警告帯をより目立たせる、`checkout tip` への導線を常設する）。あわせて detached のまま `preview build` すると `E_EMPTY_TIMELINE` になる点も案内する | open |
| D-9 | 中 | **`clip add` に `--ripple` が無い**。docs/04 §6 は「`--on-overlap push` は §6a の規則で全トラック。`--ripple=track` を併用すると当該トラックのみ」と書くが、実装の `clip add` は `--ripple` を受け付けず、押し出しは常に全トラック（`clip move|trim|delete|set` には `--ripple` がある） | `clip add` にも `--ripple[=all\|track]` を足して `--on-overlap push` の範囲を選べるようにする（D-5 のクリップ生成の共通化と一緒にやるのが自然） | open |
| D-10 | 低 | **Web の履歴 API が docs/06 §3.2 より狭い**。`GET /api/history/:id`・`/api/history/diff`・`/api/blame/:elementId`・`/api/cli-examples`・`/api/fonts` が未実装（`GET /api/history` のみ）。許可リストには `revert` / `reset --hard` が入っているが CLI 側が未実装 | M4（W-11）で CLI の `show`/`diff`/`blame`/`revert` を仕上げるのに合わせて API も足す。docs/06 には未実装の印を付けた | open |
| D-11 | 低 | **`montash help <command>` が未実装**。docs/04 §2 に項目があるが登録コマンドに無く、yargs の `--help` と `schema` しかない | 仕様から落とす（`schema` で足りる）か、`schema` の人間向けラッパとして実装する | open（要判断） |
| D-12 | 低 | **`render --preset` の選択肢が 2 つだけ**。docs/04 §14 は 10 プリセット（`youtube-4k` / `instagram-reel` / `twitter` / `prores-422` / `archive-h265` / `audio-only-mp3` / `gif` / `thumbnail`）を挙げるが、実装は `youtube-1080p` / `web-preview` のみ | M4（W-12）で残りを追加。docs/04 §1.9 に現状を明記済み | open（M4） |

## 決定ログ

- 2026-09-14: A-1〜A-4 を推奨案で決定（ADR-13〜16）。B-1〜B-4 は事前 spike を行わず、該当モジュールの実装時に検証する方針（deferred）。残る `open` は A-5, A-7, A-8, A-12（中・低）、B-5〜B-11、C 群。
- 2026-09-14: B-1 を `ffmpeg/run.ts` 実装時に検証（spiked）。進捗 0.5 秒間隔・キャンセル 15ms 以内で判定基準を満たす。サーバ異常終了時の子プロセス残留のみ M2 へ持ち越し。
- 2026-09-15: M1〜M3 が動く状態になったので、実機で触って見つかった課題を **D 群**として追加（UI のテキストクリップ描画・タイムラインの尺、docs の単位食い違い、clip 生成の重複実装、CI の macOS）。C-2 / C-3 は解決済みに更新。
- 2026-09-15: D-1 / D-2 を修正（done）。クリップ区間の算出を `GET /api/project` の `computed` に一本化し、Web の派生値（純関数）を `web/src/lib/timeline.ts` へ切り出した。テキスト・字幕は区間の矩形＋本文先頭 20 文字で描画、既定スケールは尺 + 1 秒。
- 2026-09-15: D-5 を解消。クリップ生成・配置・リンク音声・重なり検査を `core/clip-create.ts` に括り出し、`clip add` / `overlay add` を載せ替えた。`--on-overlap` の `push` / `overwrite` は `clip add` では依然未実装（docs/09 の通り M1 の範囲外）。`overwrite` の実体である `carveRange()` は `core/clip-editing.ts` へ移したので、実装時はそのまま使える。
- 2026-09-15: D-4 を解消し D-3 を docs に明記（PR #28）。あわせて `montash schema` の出力と docs/04 を突き合わせ、未実装コマンド・未実装オプション・docs 未記載の実装を docs/04 §1.9 に一覧化。docs/09 のロードマップと docs/12 の ADR 検証欄を実測値で更新。突き合わせで見つかった 4 件を D-9〜D-12 として追加。
