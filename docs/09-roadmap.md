# 09. 開発ロードマップとトレーサビリティ

作業手順開発の原則に従い、**手順（W-xx）単位で縦に切って** 実装する。各マイルストーンは「その手順が bash スクリプトで通しで動く」ことを完了条件とする。

## 実装状況（2026-09-15 / M3 完了）

**完了: M0 / M1 / M2 / M3**（W-01〜W-10, W-13〜W-17）。**進行中: M4**（W-11 / W-12）。

- **M0**: CLI 骨格（yargs + `defineCommand`）、`--json`／エラー／終了コード、`doctor` / `schema` / `init` / `project show` / `validate`、履歴基盤（op / commit / object / HEAD）、`Bun.serve` 最小サーバ、CI。
- **M1**: `import` → `proxy build|status` → `assets list|show` → `clip add|list` → `timeline show` → `render` / `render verify|presets`、履歴コマンド群（`status` / `log` / `show` / `diff` / `commit` / `checkout` / `undo` / `redo` / `tag` / `history verify|prune|export|import` / `ids rebuild`）。30 / 29.97 / 59.94fps の厳密フレーム数・カット位置テストを常設。
- **M2**: `serve`（静的 + `/api/*` + WS + `POST /api/cli` 許可リスト）、`preview build|status`（映像セグメントキャッシュ + 音声 1 パス + mux、`--from/--to`・`--audio-only`・`--height`・`--force`）、`GET /preview/timeline.mp4`（Range・`ETag`=project_hash）、`clip move|trim|split|delete|set` と `track add|list|remove|mute|lock|move`、`timeline gaps`、Web のプレイヤー・トランスポート・編集タイムライン canvas・Inspector・History タイムライン（クリック / `[` `]`）。
- **M3**: フィルタグラフを `src/ffmpeg/graph/`（types / video / transitions / audio / overlay / text / builder / serialize）の純関数に切り出し、`render` と `preview build` が同じ `buildGraph()` を使う。`transition add|set|remove|list` と `fade`、`text add|set|remove|list|presets` と `fonts list`（ASS 生成 + libass、`drawtext` フォールバック）、`subtitle add|set|remove|list`（burn / soft）、`audio gain|fade|duck|normalize|analyze|show|offset`（amix / sidechaincompress / loudnorm 2 パス）、`overlay add|set|remove|list`、`proxy build --thumbs --waveform` と Web の波形・サムネイル表示、`assets set|new-text|set-text|remove|relink` と Web Assets タブの操作系（`POST /api/upload`）。速度変更（`setpts` + `atempo`）と音声オフセット（`offset_smp`）も対応。
- **ゴールデンテスト**: 30 / 29.97 / 59.94fps で `duration_f` 厳密一致、xfade 前後フレームの PSNR 照合、テロップ焼き込みを常設（`tests/unit/ffmpeg/transition-golden.test.ts`, `text-render.test.ts`, `audio-render.test.ts`）。
- **M4（進行中）**: `revert` / `blame` / `reset --hard` / `commit --amend`、`render --last|--from|--to|--hwaccel|--reframe`・全プリセット・`render batch`、W-11 / W-12 の E2E。
- **未実装**: `clip show`、`clip link|unlink`、`clip add --loop`、`render still|gif|audio`、`batch`、`explain`、`schema --format *-tools` 以外の AI 支援、`serve --allow|--deny|--max-upload` と `serve stop|status`、`log --since`、`project set fps|resolution`、LUT、キーフレームアニメーション、ぼかし／モザイク。コマンド単位の差分は 04 章 §1.9 を正とする。
- **CI**: 費用抑制のため一時的に Ubuntu のみ（macOS runner は停止中。13 章 D-6）。3 OS マトリクスは再開後の目標。

## 1. マイルストーン

### M0. 骨格（手順なし・基盤のみ）— 1 週目 ✅ 完了

- リポジトリ（Bun: `package.json` / `bun.lock` / `bunfig.toml` / `tsconfig.json` strict）、`scripts/install-deps.sh`（済）、`scripts/spikes/`（12 章の検証スクリプトを取り込み）
- CLI エントリ（yargs + `defineCommand`）、`--json`／エラー／終了コードの枠組み
- `Bun.serve` の最小サーバ（静的 + `/ws`）と Bun HTML import で React の空 App を表示（フロント基盤の疎通）
- CI: `oven-sh/setup-bun`、`install-deps.sh --yes`、`bun test`、`bunx tsc --noEmit`、3 OS マトリクス
- `core/schema.ts`（05 章）、`project.load/save`、`core/history/store`（op 追記・object 保存・HEAD）の基本
- `ffmpeg/locate`, `probe`, `run`（進捗パース）
- `tests/fixtures` 生成スクリプト
- 完了条件: `montash doctor --json`, `montash init`, `montash project show` が 3 OS で動く（= **W-01**）

### M1. 取り込みと粗編集 — 2〜3 週目 ✅ 完了

- **W-02**: `import`, `assets list|show`, `proxy build|status`（プロキシのみ。サムネ・波形は M3）
- `core/time.ts`（有理数 fps、整数フレーム／サンプル）と入力パーサ。**30 / 29.97 / 59.94 fps のゴールデンテスト基盤**（`ffprobe -count_frames` でフレーム数一致）を最初に用意
- **W-03**: `clip add`, `clip list`, `timeline show`, `validate`
- **W-09（最小）**: `render` を `youtube-1080p` / `web-preview` のみ、トランジション・テキスト無しの concat レンダー。`--dry-run`, `render verify`（フレーム数厳密一致）
- **W-10 / W-15**: `status`, `log`, `undo`, `redo`, `checkout`, `commit -m`, 任意コマンドの `-m`, `tag`（DAG・分岐保持を含む。`revert`/`blame`/`reset` は M4）
- 完了条件: `tests/workflows/W-02.sh, W-03.sh, W-09.sh, W-10.sh, W-15.sh` が通る。「複数素材をカットして繋げて mp4 に書き出し、作業をコミットとして記録する」が AI 経由で成立

### M2. Web プレビュー — 4〜5 週目 ✅ 完了

- **W-04**: `serve`（静的 + `/api/project` + WS）、`preview build`（まずセグメントキャッシュ無しの単発生成）、`clip move|trim|split|delete`（リップル含む）
- **W-16**: `POST /api/cli`（許可リスト: `checkout`/`undo`/`redo`/`tag` のみ）、`GET /api/history`、Web の **History タイムライン**（時系列表示、HEAD、pending、クリック→checkout、`[`/`]`）
- Web: プレイヤー、トランスポート、編集タイムライン canvas、Inspector（プロパティ + 由来 + CLI 例）、自動リロード、Assets タブ（**閲覧のみ**: 一覧・フィルタ・単体プレビュー・使用箇所）
- 完了条件: `W-04.sh`, `W-16.sh`（Playwright でノードクリック→`status` の HEAD 変化を検証）が通り、ブラウザで編集結果が 5 秒以内、History クリックで表示が 300ms 以内に反映される

### M3. 演出（トランジション・テキスト・音声）— 6〜8 週目 ✅ 完了

- **W-05**: `transition add|set|remove|list`, `fade`（xfade グラフビルダー、整数ハンドル計算、29.97fps での offset 検証）
- **W-06**: `text add|set|remove|list|presets`, `fonts list`（**ASS 生成 + libass**、`fontsdir` 構築、CJK フォールバック、`drawtext` フォールバック）
- **W-07**: `track add|list|remove|mute|move`, `audio gain|fade|duck|normalize|analyze|show`（amix、sidechaincompress、loudnorm 2 パス）
- `proxy build --thumbs --waveform`、Web に波形・サムネイル表示
- プレビューの映像セグメントキャッシュ + 音声 1 パス + mux（History スクラブ時の即時性の要。ADR-11）
- **W-17**: `assets set|new-text|set-text`、`text add --asset`、`POST /api/upload`、Web Assets タブの操作系（取り込み・削除・ラベル・再リンク・プロキシ再生成・テキスト素材）、許可リストに素材系コマンドを追加、confirm ダイアログ
- History タイムラインの hover 差分表示と編集タイムラインへのハイライト（`affects`）
- 完了条件: `W-05.sh, W-06.sh, W-07.sh, W-17.sh` が通る。README のクイックスタートがそのまま動く

### M4. 仕上げと拡張 — 9〜10 週目 🚧 進行中

- ~~**W-08**: `overlay add|set|remove|list`~~ → M3 で前倒し実装済み（`W-08.sh`）
- **W-11**: `render --last`, `diff`, `show`, `blame`, `revert`, `reset --hard`, `commit --amend`, `history prune|verify|export|import`、Web History の右クリック操作（タグ付け・revert・差分）、`log --graph`
- **W-12**: `render batch`, `--reframe`, 全プリセット、`--hwaccel`
- ~~**W-13**: `assets relink`~~ → M3 で前倒し実装済み（`W-13.sh`）
- ~~**W-14**: `subtitle add|set|remove|list`~~ → M3 で前倒し実装済み（`W-14.sh`）
- `batch --atomic`, `explain`, `schema --format *-tools`
- 完了条件: 全 W-xx.sh が 3 OS の CI で通る（残りは `W-11.sh` / `W-12.sh`。CI は当面 Ubuntu のみ）

### M5. v1.0 — 11〜12 週目

- **Phase 0: カーネル整備 ✅ 完了**（PR #35〜#39。詳細は `docs/plans/2026-09-15-plugin-architecture.md`）
  - D-14 クリップ種別の開放（`type` 必須 + 未知種別は `OpaqueClip` として保持、判別を 1 実装に統合、`schema_version` 3）
  - D-15 エフェクトレジストリと挿入スロット（組み込みの色補正を builtin エフェクトへ載せ替え）
  - D-16 プリセット統合（`createRegistry<T>()`）／ D-17 ID プレフィックス開放／ D-18 コマンド・機能宣言の合成
  - D-13 マイグレーション機構は **deferred**。リリース前なので移行は提供せず、旧 `schema_version` は `E_SCHEMA_TOO_OLD` で拒否して作り直す
- ドキュメント（本仕様と実装の差分は `bun run check:spec` が検出する。C-5 で実装済み。04 章の表の自動生成までは行わない）
- **パフォーマンス（N-3〜N-5）実測済み**（2026-09-15）。いずれも基準内なので改善は不要
  - **N-3**（状態操作 200ms 以内）: `clip add` が 116〜122ms（うち bun の起動が 62ms）。project の load 6〜14ms / save 0.5〜0.9ms
  - **N-4**（プレビュー 1 分以内）: 10 分 / 10 クリップ・キャッシュヒット 0 で 42 秒（B-8）
  - **N-5**（レンダー速度）: 入力 100・filter_complex 28,485 文字で 5.2 秒、中間ファイル無し（B-7）
- **OS 別単一バイナリのビルドは実装済み**（`bun run release` = `scripts/release-build.ts`）。macOS arm64 のホストから **4 ターゲットすべてをクロスコンパイルできることを実測**（linux-x64 93MB / linux-arm64 92MB / darwin-x64 69MB / darwin-arm64 63MB、各 0.1〜0.2 秒）。WSL は linux バイナリを使う
- 残り: npm 公開（`bunx montash`）と `install-deps.sh` からのバイナリ取得オプション。**公開操作なので実行前に判断が要る**
- 10 章の AI 操作ガイドを実運用で検証（実際に LLM に指示して W-01〜W-14 を通す）

### M6. プラグイン — 13〜15 週目 ✅ 完了

拡張点をレジストリ化し、外部から機能を足せるようにする（F-EXT-1〜4）。計画: `docs/plans/2026-09-15-plugin-architecture.md`。

- **Phase 1（宣言プラグイン）**: **W-18** を先に書き、`effect add|set|remove|list|presets` → `project.effects`（テンプレート宣言。コード実行なし）→ 組み込みエフェクト拡充（**F-FX-4 の LUT / F-FX-7 のぼかし・モザイク / F-FX-3 の回転・反転**を前倒し）→ generator / transition の開放
- **Phase 2（外部プラグイン）**: **W-19**、`src/plugins/` ホスト（マニフェスト・探索順・`apiVersion`・host API）、`plugin list|install|remove|doctor`、`project.plugins.requires[]`、単一バイナリとの両立検証（B-2 と統合）、Level C（解析・プロセス）の `capabilities`
- 完了条件: `W-18.sh` / `W-19.sh` が通る。プラグインを外した環境で同じ project.json が開け、レンダー時にだけ `E_PLUGIN_MISSING` が出る
- **結果**（PR #41〜#47）: 手順 W-18 / W-19 を先に確定 → `effect` コマンド群（パラメータ定義から CLI オプション・`schema`・`help` を導出）→ 組み込みエフェクト 6 種 → generator / transition のレジストリ化 → プラグインホスト（`register(host)` で API を渡す。**プラグインは montash を import しない**）→ `plugin` コマンド群 → Level C の `analyze`。
  単一バイナリからの外部プラグイン読み込みも実機確認（B-2 / P2-3 解決）

### M7. 拡張の I/O と Web — 16〜17 週目 ✅ 完了

- importer / exporter レジストリ（`import` の probe 分岐と `render` プリセット解決をレジストリ経由に）
- Web の **spec 駆動フォーム**（`GET /api/specs`。Inspector の固定 `<dl>` を置き換え、opaque クリップに「プラグイン不足」バッジ）
- `serve --allow/--deny` の配線、プラグインの `webAllow` 宣言との合成
- 汎用 commands プラグイン

- **結果**（PR #49〜#52）:
  - **P3-1** 入出力レジストリ。`import` の分岐を組み込み importer 3 種（text / subtitle / media）へ移し、I/O はホストが渡す `ctx.read()` / `ctx.probe()` に限定。exporter はプラグインからの登録口を追加
  - **P3-2** Web の spec 駆動フォーム。`GET /api/specs`（`schema` と同じコマンド定義 + エフェクトのパラメータ）を新設し、Inspector の固定フィールドと固定 CLI 例を置き換え。opaque クリップとプラグイン不足の効果に「プラグイン不足」バッジ
  - **P3-3** `serve --allow/--deny` の配線とプラグインの `webAllow` 合成。優先順位は `--read-only` > `--deny` > `--allow` ≒ `webAllow` > 既定
  - **P3-4** commands プラグイン。**プラグイン ID の末尾セグメントを名前空間として強制**し、組み込みの乗っ取りを原理的に防ぐ。状態変更は `runMutation()` でラップし、プロジェクトディレクトリも保存関数も渡さない


### 以降（Could）

- キーフレームアニメーション（F-FX-8）、ネスト（F-TL-9）
- レンダーキャッシュ（F-RD-10）
- `suggest`（F-AI-6）
- MCP サーバとしての公開（CLI と同じコマンド定義から自動生成）

## 2. トレーサビリティ表（手順 ⇄ 要件 ⇄ コマンド ⇄ ffmpeg ⇄ 実装 ⇄ テスト）

| 手順 | 要件 | コマンド（04） | データ（05） | ffmpeg（07） | 実装モジュール（08） | テスト | 状態 |
|------|------|----------------|--------------|--------------|----------------------|--------|------|
| W-01 | F-PRJ-1,2 / N-2 | `doctor`, `init`, `project show` | `settings` | — | `cli/commands/{doctor,init,project}.ts`, `ffmpeg/locate.ts`, `core/project.ts` | `tests/workflows/W-01.sh`, `unit/core/project.test.ts`, `unit/ffmpeg/locate.test.ts` | M0 ✅ |
| W-02 | F-AST-1〜4 / F-PV-7 | `import`, `assets *`, `proxy *` | `assets`, `derived` | §10 | `cli/commands/{import,assets,proxy}.ts`, `core/assets.ts`, `ffmpeg/{probe,proxy}.ts` | `tests/workflows/W-02.sh`, `unit/ffmpeg/{probe,proxy-derived}.test.ts`, `unit/cli/assets-manage.test.ts` | M1/M3 ✅ |
| W-03 | F-TL-1,4,5 / F-PRJ-4 | `clip add`, `timeline show`, `validate` | `tracks.clips` | §2,3,4.1 | `cli/commands/{clip,timeline,validate}.ts`, `core/{timeline,validate,time}.ts` | `tests/workflows/W-03.sh`, `unit/core/{timeline,validate,time}.test.ts`, `unit/cli/editing.test.ts` | M1 ✅ |
| W-04 | F-TL-2,3 / F-PV-1〜6 | `preview *`, `serve`, `clip move/trim/split/delete` | `preview/*` | §11 | `cli/commands/{preview,serve,clip-edit}.ts`, `core/{clip-editing,ripple}.ts`, `ffmpeg/preview.ts`, `server/*`, `web/src/*` | `tests/workflows/W-04.sh`, `unit/ffmpeg/preview.test.ts`, `unit/core/{clip-editing,ripple}.test.ts`, `unit/cli/clip-edit.test.ts`, `unit/server/preview-*.test.ts` | M2 ✅ |
| W-05 | F-TL-7 / F-FX-5 | `transition *`, `fade` | `transitions` | §4.2,4.3, 8.2 | `cli/commands/{transition,fade}.ts`, `ffmpeg/graph/{transitions,video,audio}.ts` | `tests/workflows/W-05.sh`, `unit/ffmpeg/{graph-build,graph-audio,transition-golden}.test.ts` | M3 ✅ |
| W-06 | F-FX-1 / N-11 | `text *`, `fonts list` | text clips, `text_presets` | §6 | `cli/commands/{text,fonts}.ts`, `core/text-presets.ts`, `ffmpeg/{ass,text-prepare,fonts}.ts`, `ffmpeg/graph/text.ts` | `tests/workflows/W-06.sh`, `unit/ffmpeg/{ass,graph-text,text-render,fonts}.test.ts`, `unit/cli/text.test.ts` | M3 ✅ |
| W-07 | F-AU-1〜3 / F-TL-4 | `track *`, `audio *` | `audio`, `clips.audio` | §8 | `cli/commands/{track,audio}.ts`, `ffmpeg/graph/audio.ts`, `ffmpeg/{loudnorm,audio-analysis}.ts` | `tests/workflows/W-07.sh`, `unit/ffmpeg/{graph-audio,audio-render}.test.ts`, `unit/cli/audio.test.ts` | M3 ✅ |
| W-08 | F-FX-2 | `overlay *`, `track move` | `clips.video.transform` | §5 | `cli/commands/overlay.ts`, `ffmpeg/graph/overlay.ts` | `tests/workflows/W-08.sh`, `unit/ffmpeg/graph-overlay.test.ts`, `unit/cli/overlay.test.ts` | M3 ✅（M4 から前倒し） |
| W-09 | F-RD-1〜7 | `render`, `render verify/presets` | `render/last.json` | §9 | `cli/commands/render.ts`, `ffmpeg/render.ts`, `ffmpeg/graph/builder.ts` | `tests/workflows/W-09.sh`, `unit/ffmpeg/graph-build.test.ts` | M1 ✅（コーデック個別指定・部分レンダーは M4） |
| W-10 | F-PRJ-3,5 / F-HIS-3,4 | `status`, `log`, `undo`, `redo`, `checkout`, `tag` | `.montash/history/*`（11 章） | — | `cli/commands/{status,log,undo,redo,checkout,tag,show,diff,history}.ts`, `core/history/*` | `tests/workflows/W-10.sh`, `unit/core/history/*.test.ts`, `unit/cli/history-commands.test.ts` | M1 ✅（`revert` は M4） |
| W-11 | F-RD-1 / F-HIS-5,6 | `render --last`, `diff`, `show`, `blame`, `revert` | `meta.last_render`, `commits.jsonl` | §9 | `cli/commands/{diff,show}.ts`（`blame`/`revert` は未実装） | `tests/workflows/W-11.sh`（未作成） | M4 🚧 |
| W-12 | F-RD-2,8 | `render batch`, `--reframe` | `render_presets` | §9 | `ffmpeg/render.ts`（未実装） | `tests/workflows/W-12.sh`（未作成） | M4 🚧 |
| W-13 | F-AST-6 | `assets relink` | `assets.hash_head` | — | `cli/commands/assets.ts`, `core/assets.ts` | `tests/workflows/W-13.sh`, `unit/cli/assets-manage.test.ts` | M3 ✅（M4 から前倒し） |
| W-14 | F-FX-6 / F-AST-5 | `subtitle *` | subtitle clips | §7 | `cli/commands/subtitle.ts`, `ffmpeg/{ass,text-prepare}.ts`, `ffmpeg/graph/text.ts` | `tests/workflows/W-14.sh`, `unit/ffmpeg/ass-burn.test.ts`, `unit/cli/subtitle.test.ts` | M3 ✅（M4 から前倒し） |
| W-15 | F-HIS-1,2,7 / N-13 | `commit`, `-m`, `status`, `log`, `show`, `diff`, `tag` | `ops.jsonl`, `commits.jsonl`, `objects/` | — | `cli/commands/commit.ts`, `cli/mutate.ts`, `core/history/{store,history,diff,hash,dag}.ts` | `tests/workflows/W-15.sh`, `unit/core/history/{store,history,property}.test.ts`, `unit/cli/mutate.test.ts` | M1 ✅ |
| W-16 | F-PV-11〜13 / F-HIS-3,4 / F-PV-10,16 | `checkout`, `undo`, `redo`, `tag`（Web → `POST /api/cli`） | `HEAD`, `moves.jsonl` | §11（キャッシュ concat） | `server/{cli-exec,history}.ts`, `web/src/components/History/HistoryStrip.tsx` | `tests/workflows/W-16.sh` + `scripts/e2e-history.ts`（Playwright）, `unit/server/{cli-exec,history}.test.ts` | M2 ✅ |
| W-17 | F-PV-14,15 / F-AST-7,8 | `import`, `assets set\|new-text\|set-text\|remove\|relink`, `proxy build`, `text add --asset` | `assets.*.label/tags/owned`, `assets/text/`, text clip `asset` | §6, §10 | `core/assets.ts`, `server/assets.ts`, `web/src/components/Assets/*` | `tests/workflows/W-17.sh`（`serve` + curl で Web と同じ API 経路を検証）, `unit/server/{assets-api,assets-derived,upload}.test.ts` | M3 ✅ |
| 全般 | F-AI-1〜5 | `schema`, `--json`, `--dry-run`（`batch` / `explain` は未実装） | — | §12 | `cli/{output,errors,define-command,context}.ts`, `cli/commands/schema.ts` | `unit/cli/{output,define-command,time-input}.test.ts` | M0〜M3 ✅ |

`tests/unit/**` はリポジトリ直下 `tests/` からの相対、実装モジュールは `src/` からの相対。プレビューの実ブラウザ検証は `scripts/e2e-preview.ts`（`W-04.sh` から呼ぶ。chromium があるときのみ）。

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
