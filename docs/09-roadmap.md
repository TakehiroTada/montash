# 09. 開発ロードマップとトレーサビリティ

作業手順開発の原則に従い、**手順（W-xx）単位で縦に切って** 実装する。各マイルストーンは「その手順が bash スクリプトで通しで動く」ことを完了条件とする。

## 1. マイルストーン

### M0. 骨格（手順なし・基盤のみ）— 1 週目

- リポジトリ（Bun: `package.json` / `bun.lock` / `bunfig.toml` / `tsconfig.json` strict）、`scripts/install-deps.sh`（済）、`scripts/spikes/`（12 章の検証スクリプトを取り込み）
- CLI エントリ（yargs + `defineCommand`）、`--json`／エラー／終了コードの枠組み
- `Bun.serve` の最小サーバ（静的 + `/ws`）と Bun HTML import で React の空 App を表示（フロント基盤の疎通）
- CI: `oven-sh/setup-bun`、`install-deps.sh --yes`、`bun test`、`bunx tsc --noEmit`、3 OS マトリクス
- `core/schema.ts`（05 章）、`project.load/save`、`core/history/store`（op 追記・object 保存・HEAD）の基本
- `ffmpeg/locate`, `probe`, `run`（進捗パース）
- `tests/fixtures` 生成スクリプト
- 完了条件: `montash doctor --json`, `montash init`, `montash project show` が 3 OS で動く（= **W-01**）

### M1. 取り込みと粗編集 — 2〜3 週目

- **W-02**: `import`, `assets list|show`, `proxy build|status`（プロキシのみ。サムネ・波形は M3）
- `core/time.ts`（有理数 fps、整数フレーム／サンプル）と入力パーサ。**30 / 29.97 / 59.94 fps のゴールデンテスト基盤**（`ffprobe -count_frames` でフレーム数一致）を最初に用意
- **W-03**: `clip add`, `clip list`, `timeline show`, `validate`
- **W-09（最小）**: `render` を `youtube-1080p` / `web-preview` のみ、トランジション・テキスト無しの concat レンダー。`--dry-run`, `render verify`（フレーム数厳密一致）
- **W-10 / W-15**: `status`, `log`, `undo`, `redo`, `checkout`, `commit -m`, 任意コマンドの `-m`, `tag`（DAG・分岐保持を含む。`revert`/`blame`/`reset` は M4）
- 完了条件: `tests/workflows/W-02.sh, W-03.sh, W-09.sh, W-10.sh, W-15.sh` が通る。「複数素材をカットして繋げて mp4 に書き出し、作業をコミットとして記録する」が AI 経由で成立

### M2. Web プレビュー — 4〜5 週目

- **W-04**: `serve`（静的 + `/api/project` + WS）、`preview build`（まずセグメントキャッシュ無しの単発生成）、`clip move|trim|split|delete`（リップル含む）
- **W-16**: `POST /api/cli`（許可リスト: `checkout`/`undo`/`redo`/`tag` のみ）、`GET /api/history`、Web の **History タイムライン**（時系列表示、HEAD、pending、クリック→checkout、`[`/`]`）
- Web: プレイヤー、トランスポート、編集タイムライン canvas、Inspector（プロパティ + 由来 + CLI 例）、自動リロード、Assets タブ（**閲覧のみ**: 一覧・フィルタ・単体プレビュー・使用箇所）
- 完了条件: `W-04.sh`, `W-16.sh`（Playwright でノードクリック→`status` の HEAD 変化を検証）が通り、ブラウザで編集結果が 5 秒以内、History クリックで表示が 300ms 以内に反映される

### M3. 演出（トランジション・テキスト・音声）— 6〜8 週目

- **W-05**: `transition add|set|remove|list`, `fade`（xfade グラフビルダー、整数ハンドル計算、29.97fps での offset 検証）
- **W-06**: `text add|set|remove|list|presets`, `fonts list`（**ASS 生成 + libass**、`fontsdir` 構築、CJK フォールバック、`drawtext` フォールバック）
- **W-07**: `track add|list|remove|mute|move`, `audio gain|fade|duck|normalize|analyze|show`（amix、sidechaincompress、loudnorm 2 パス）
- `proxy build --thumbs --waveform`、Web に波形・サムネイル表示
- プレビューの映像セグメントキャッシュ + 音声 1 パス + mux（History スクラブ時の即時性の要。ADR-11）
- **W-17**: `assets set|new-text|set-text`、`text add --asset`、`POST /api/upload`、Web Assets タブの操作系（取り込み・削除・ラベル・再リンク・プロキシ再生成・テキスト素材）、許可リストに素材系コマンドを追加、confirm ダイアログ
- History タイムラインの hover 差分表示と編集タイムラインへのハイライト（`affects`）
- 完了条件: `W-05.sh, W-06.sh, W-07.sh, W-17.sh` が通る。README のクイックスタートがそのまま動く

### M4. 仕上げと拡張 — 9〜10 週目

- **W-08**: `overlay add|set|remove|list`
- **W-11**: `render --last`, `diff`, `show`, `blame`, `revert`, `reset --hard`, `commit --amend`, `history prune|verify|export|import`、Web History の右クリック操作（タグ付け・revert・差分）、`log --graph`
- **W-12**: `render batch`, `--reframe`, 全プリセット、`--hwaccel`
- **W-13**: `assets relink`
- **W-14**: `subtitle add|set|remove|list`
- `batch --atomic`, `explain`, `schema --format *-tools`
- 完了条件: 全 W-xx.sh が 3 OS の CI で通る

### M5. v1.0 — 11〜12 週目

- ドキュメント（本仕様と実装の差分ゼロ確認、`schema` から 04 章の表を自動生成）
- パフォーマンス（N-3〜N-5）計測と改善
- npm 公開（`bunx montash`）、`bun build --compile` による OS 別単一バイナリ（linux-x64 / linux-arm64 / darwin-arm64 / darwin-x64。WSL は linux バイナリ）のリリース、`install-deps.sh` からのバイナリ取得オプション
- 10 章の AI 操作ガイドを実運用で検証（実際に LLM に指示して W-01〜W-14 を通す）

### 以降（Could）

- キーフレームアニメーション（F-FX-8）、ぼかし／モザイク（F-FX-7）、ネスト（F-TL-9）
- レンダーキャッシュ（F-RD-10）
- `suggest`（F-AI-6）
- MCP サーバとしての公開（CLI と同じコマンド定義から自動生成）

## 2. トレーサビリティ表（手順 ⇄ 要件 ⇄ コマンド ⇄ ffmpeg ⇄ 実装 ⇄ テスト）

| 手順 | 要件 | コマンド（04） | データ（05） | ffmpeg（07） | 実装モジュール（08） | テスト | MS |
|------|------|----------------|--------------|--------------|----------------------|--------|----|
| W-01 | F-PRJ-1,2 / N-2 | `doctor`, `init`, `project show` | `settings` | — | `cli/doctor,init,project`, `ffmpeg/locate` | `W-01.sh` | M0 |
| W-02 | F-AST-1〜4 / F-PV-7 | `import`, `assets *`, `proxy *` | `assets`, `derived` | §10 | `cli/import,assets,proxy`, `ffmpeg/probe,proxy` | `W-02.sh` | M1/M3 |
| W-03 | F-TL-1,4,5 / F-PRJ-4 | `clip add`, `timeline show`, `validate` | `tracks.clips` | §2,3,4.1 | `core/timeline,validate` | `W-03.sh`, unit | M1 |
| W-04 | F-TL-2,3 / F-PV-1〜6 | `preview *`, `serve`, `clip move/trim/split/delete` | `preview/*` | §11 | `ffmpeg/preview`, `server/*`, `web/*` | `W-04.sh` | M2 |
| W-05 | F-TL-7 / F-FX-5 | `transition *`, `fade` | `transitions` | §4.2,4.3, 8.2 | `core/transitions`, `graph/video,audio` | `W-05.sh`, snapshot | M3 |
| W-06 | F-FX-1 / N-11 | `text *`, `fonts list` | text clips, `text_presets` | §6 | `graph/text`, `ffmpeg/fonts` | `W-06.sh` | M3 |
| W-07 | F-AU-1〜3 / F-TL-4 | `track *`, `audio *` | `audio`, `clips.audio` | §8 | `graph/audio` | `W-07.sh` | M3 |
| W-08 | F-FX-2 | `overlay *`, `track move` | `clips.video.transform` | §5 | `graph/overlay` | `W-08.sh` | M4 |
| W-09 | F-RD-1〜7 | `render`, `render verify/presets` | `render/last.json` | §9 | `ffmpeg/render` | `W-09.sh` | M1/M4 |
| W-10 | F-PRJ-3,5 / F-HIS-3,4 | `status`, `log`, `undo`, `redo`, `checkout`, `tag`, `revert` | `.montash/history/*`（11 章） | — | `core/history/*` | `W-10.sh`, unit | M1/M4 |
| W-11 | F-RD-1 / F-HIS-5,6 | `render --last`, `diff`, `show`, `blame`, `revert` | `meta.last_render`, `commits.jsonl` | §9 | `cli/diff,blame,revert` | `W-11.sh` | M4 |
| W-12 | F-RD-2,8 | `render batch`, `--reframe` | `render_presets` | §9 | `ffmpeg/render` | `W-12.sh` | M4 |
| W-13 | F-AST-6 | `assets relink` | `assets.hash_head` | — | `cli/assets` | `W-13.sh` | M4 |
| W-14 | F-FX-6 / F-AST-5 | `subtitle *` | subtitle clips | §7 | `graph/subtitle` | `W-14.sh` | M4 |
| W-15 | F-HIS-1,2,7 / N-13 | `commit`, `-m`, `status`, `log`, `show`, `diff`, `tag` | `ops.jsonl`, `commits.jsonl`, `objects/` | — | `core/history/store,commit,summary` | `W-15.sh`, unit（性質テスト） | M1 |
| W-16 | F-PV-11〜13 / F-HIS-3,4 / F-PV-10,16 | `checkout`, `undo`, `redo`, `tag`（Web → `POST /api/cli`） | `HEAD`, `moves.jsonl` | §11（キャッシュ concat） | `server/cli-exec`, `web/history-timeline` | `W-16.sh`（Playwright） | M2/M4 |
| W-17 | F-PV-14,15 / F-AST-7,8 | `import`, `assets set\|new-text\|set-text\|remove\|relink`, `proxy build`, `text add --asset`（Web → `POST /api/cli`, `/api/upload`） | `assets.*.label/tags/owned`, `assets/text/`, text clip `asset` | §6, §10 | `core/assets`, `server/upload`, `web/assets-panel` | `W-17.sh`（Playwright） | M2（閲覧）/M3（操作） |
| 全般 | F-AI-1〜5 | `schema`, `batch`, `explain`, `--json`, `--dry-run` | — | §12 | `cli/output,errors,schema,batch` | unit | M0〜M4 |

## 3. リスクと対策

| リスク | 影響 | 対策 |
|--------|------|------|
| ffmpeg のビルド差（drawtext/libass/xfade 無し） | 環境で機能が使えない | `doctor` と `install-deps.sh --check` で早期検出、代替案 hint、CI で static ビルドの ffmpeg を固定 |
| Bun の Node 互換の穴（`fs.watch` の検知漏れを実機で確認済） | 監視・子プロセス・ストリーム周りの不具合 | Node API 依存箇所は `scripts/spikes/` で検証してから採用。監視はポーリング実装を第 2 案として同梱。Bun 更新時に spike を再実行（12 章） |
| `xfade`+`concat` 混在グラフの複雑化 | バグ・性能 | グラフビルダーの純関数化とスナップショットテスト。トラック内を区間分割する設計（07 章 §4.2） |
| `xfade=offset` / ASS 時刻など秒でしか渡せない箇所のフレームずれ | カット点が 1 フレームずれる | 全時間を整数フレームで保持し、`fps=` で pts を量子化してからマイクロ秒精度で変換（ADR-09）。29.97/59.94 のゴールデンテストを M1 から常設 |
| libass の `BorderStyle=4` 非対応ビルド | 背景ボックスの見え方が変わる | `doctor` で libass バージョン検出、`3` にフォールバック |
| WSL の `/mnt/c` I/O・inotify 非対応 | プレビュー遅延 | ポーリング、`import --copy` 推奨、`doctor` 警告 |
| 長尺タイムラインのプレビュー生成時間 | 確認ループが遅い | セグメントキャッシュ、プロキシ、`--from/--to` 部分ビルド |
| AI が曖昧な指示を誤解釈 | 意図しない編集 | `--dry-run`、`undo`、Web で ID／時刻を常時表示、10 章のガイド |
| 人間が Web で checkout した後、AI が古い認識で編集を続ける | 意図しない系列への変更 | AI は状態変更前に必ず `status` を確認（10 章 §3）。CLI は detached 時に `W_DETACHED_HEAD` を返す。Web 操作は `actor: web` の op/move として `log` に見える |
| Web からの CLI 発行が攻撃面になる | 任意コマンド実行 | 許可リスト制、配列 spawn（シェル不経由）、グローバルオプション固定、`127.0.0.1` 既定、`--read-only` |
| 履歴 object の肥大化 | ディスク消費 | 内容アドレスで重複排除、gzip、`history prune`。`project.json` は数十 KB 程度なので 1 万 op でも数百 MB 以内 |
| 日本語フォント問題 | テロップが豆腐 | CJK フォント自動選択、`fonts list --filter cjk`、`validate --deep` |

## 4. 完了の定義（Definition of Done）

各手順 W-xx について：

1. `03-workflows.md` の手順が最新の実装と一致している
2. `04-cli-spec.md` の該当コマンドが `montash schema` の出力と一致している（CI チェック）
3. `tests/workflows/W-xx.sh` が ubuntu / macos / WSL の CI で通る
4. `--json` 出力・エラー `hint` が 10 章のガイドの想定と整合している
5. Web プレビューで結果を目視確認できる（該当する場合）
