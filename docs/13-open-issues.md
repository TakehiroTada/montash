# 13. 未解決の懸念一覧（Open Issues）

実装着手前の時点で残っている懸念を、**A. 仕様として決めが必要**／**B. 技術リスク（spike で潰す）**／**C. 進め方・体制** に分けて管理する。解決したら「状態」を更新し、決定は 12 章（ADR）へ移す。

凡例 — 優先度: **高** = M0/M1 着手前に決める／潰す、**中** = 該当マイルストーン前、**低** = v1.0 まで。状態: `open` / `decided(ADR-xx)` / `spiked` / `wontfix`。

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
| B-1 | 中 | `Bun.spawn` での長時間 ffmpeg 制御 | `-progress pipe:1` のストリーム逐次読み取り、SIGTERM でのキャンセルと後片付け、stderr 末尾の捕捉、exit code、サーバ異常終了時の子プロセス残留 | 60 秒のレンダーで進捗が 1 秒間隔で届き、キャンセル後 1 秒以内にプロセスが消える | deferred（M1 `ffmpeg/run.ts` 実装時に検証） |
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
| C-2 | **高** | `cli-video-editor/` が git 管理外 | 実装前に `git init`。仕様の変更も履歴に乗せる | open |
| C-3 | **高** | 開発機に ffmpeg 未導入 | `bash scripts/install-deps.sh` を実行（brew） | open |
| C-4 | 中 | WSL2 実機テスターがいない | 早期に 1 名確保、または CI の `windows-latest` + WSL で代替 | open |
| C-5 | 中 | 仕様と実装の乖離: `montash schema` ↔ 04 章の CI 差分チェックが M5 予定 | M1 で `defineCommand` → 04 章の表を生成する簡易スクリプトを先に作る | open |
| C-6 | 中 | AI に渡すコンテキスト量: 仕様全体は大きすぎる | AI 運用は **10 章 + `montash schema` 出力** だけで完結する設計を維持。10 章を独立して読める状態に保つ | open |
| C-7 | 低 | `scripts/spikes/` の再実行を忘れる | Bun 更新 PR で `bun run all` を CI に含める | open |

## 決定ログ

- 2026-09-14: A-1〜A-4 を推奨案で決定（ADR-13〜16）。B-1〜B-4 は事前 spike を行わず、該当モジュールの実装時に検証する方針（deferred）。残る `open` は A-5, A-7, A-8, A-12（中・低）、B-5〜B-11、C 群。
