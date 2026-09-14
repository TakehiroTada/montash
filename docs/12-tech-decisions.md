# 12. 技術選定の決定記録（ADR）と検証結果

08 章の技術選定を、決定ごとに「決定・理由・検証・代替案・影響」の形で記録します。検証は実機で行い、環境と日付を残します（再検証の起点にするため）。

**検証環境**: macOS 26 (Darwin 25.6.0, arm64) / Bun 1.3.14 / 2026-09-14。検証スクリプトは `scripts/spikes/` に置く（M0 で本リポジトリに取り込む）。

## ADR-01. 言語はフル TypeScript

- **決定**: CLI・コア・ffmpeg 連携・Web サーバ・フロントエンドのすべてを TypeScript で書く。`strict: true`。JavaScript ファイルは置かない。
- **理由**: 1 言語で CLI と Web を貫通でき、`shared/types.ts` と zod スキーマを CLI・サーバ・フロントで共有できる。AI が読み書きするコードベースとして型情報が仕様の役割を果たす。
- **影響**: `bun run` は TS を直接実行するのでトランスパイル工程が無い。型検査は `bunx tsc --noEmit` を CI で回す（Bun 自体は型検査しない）。

## ADR-02. ランタイム／パッケージマネージャは Bun

- **決定**: Node.js ではなく **Bun（1.2 以上、開発は 1.3 系）** を唯一のランタイム・パッケージマネージャ・テストランナー・バンドラとする。`package.json` の `packageManager` を bun に固定し、`bun.lock` をコミット。
- **理由**:
  - TS をそのまま実行でき、起動が速い（`checkout` を Web から子プロセス実行する際の即時性に有利。06 章の「300ms 以内」要件）。
  - `Bun.serve`（HTTP/WebSocket）、`Bun.spawn`（ffmpeg）、`Bun.file`、`bun test`、`bun build --compile` が標準で揃い、依存が減る。
  - `bun build --compile` で単一バイナリ配布ができ、Web の静的アセットも埋め込める（Node SEA より簡単）。
- **検証**（Bun 1.3.14）:

| 項目 | 結果 |
|------|------|
| `bun add chokidar@4 yargs@17 react@19 ...` | 20〜26 パッケージを 0.4〜0.6 秒でインストール。ネイティブビルド無し |
| `bun build --compile` + `import x from "./embed.html" with { type: "file" }` | 単一バイナリ生成 OK、埋め込みファイルを実行時に読めた。サイズ約 63MB（Bun ランタイム込み） |
| `bun test` | 動作 OK（Jest 互換 API） |
| `Bun.serve` の HTTP Range | `new Response(Bun.file(path))` を返すだけで `Range: bytes=100-199` に **206 + `Content-Range: bytes 100-199/1000000` + `Accept-Ranges: bytes`** を自動応答。手動 `file.slice()` 実装も同結果 |
| `Bun.serve` の WebSocket | `server.upgrade(req)` + `websocket: { open, message }` で送受信 OK |
| HTML import 開発サーバ | `import index from "./web/index.html"; Bun.serve({ routes: { "/": index }, development: true })` で React/TSX がその場でバンドルされ配信された |
| `bun build ./web/index.html --outdir dist --minify` | `index.html` + ハッシュ付き JS（React 込み 0.43MB）を生成 |

- **代替案**: Node.js 20 LTS（当初案）。安定性・エコシステムは最大だが、TS 実行に tsx/ts-node が要り、Web サーバに fastify、テストに vitest、バンドラに Vite、単一バイナリに SEA と依存が増える。Deno も候補だが npm 互換の成熟度とツール（yargs/chokidar/React）の実績で Bun を優先。
- **リスク・影響**:
  - Bun の Node 互換は完全ではない。**ファイル監視（ADR-05）のように「Bun 標準 API が期待どおり動かない」ケースがある** ため、Node API に依存する箇所は spike で確認してから採用する。
  - `bun.lock` と `bunfig.toml` を管理。CI は `oven-sh/setup-bun`。
  - ffmpeg 子プロセスは `Bun.spawn`（`stdout: "pipe"` で `-progress pipe:1` を読む）。`node:child_process` も動くが Bun 標準を優先。

## ADR-03. Web サーバは `Bun.serve`（フレームワーク不採用）

- **決定**: fastify 等を使わず `Bun.serve` を直接使う。ルーティングは Bun 1.2+ の `routes`（パスパターン → ハンドラ／HTML import）と `fetch` フォールバック。静的配信は `Bun.file`、WebSocket は組み込み。
- **理由**: 06 章で必要なのは「静的配信 + Range 対応動画配信 + 十数本の GET API + `POST /api/cli` / `POST /api/upload` + WebSocket push」で、フレームワークの価値（プラグイン、バリデーション層）が薄い。Range と WebSocket が標準で動くことを検証済み（ADR-02）。
- **設計**:
  - `server/index.ts` が `Bun.serve({ hostname, port, routes, fetch, websocket, maxRequestBodySize })` を組み立てる。
  - 本番は `web/dist/` を `import ... with { type: "file" }` で埋め込み `Bun.file` で返す。開発は HTML import ルート（`development: true` で HMR）。
  - multipart アップロードは `await req.formData()`（Bun 標準）。`maxRequestBodySize` を `--max-upload` から設定。
  - `POST /api/cli` は `Bun.spawn([process.execPath, montashEntry, ...args], { env, stdout: "pipe" })`。コンパイル済みバイナリでは `process.execPath` が自分自身。
- **代替案**: Hono（Bun 上で軽量・型付きルーティング。`Bun.serve` の薄いラッパとして後から導入しても既存ハンドラを流用できる）。ルート数が 30 を超えたら再検討。
- **影響**: 06 章 §3 の API 仕様は変更なし（実装手段の決定のみ）。

## ADR-04. CLI パーサは yargs

- **決定**: `yargs@17`（ESM）を使う。コマンド定義は自作の `defineCommand()` ラッパを通し、yargs への登録・zod 検証・`montash schema` 出力・Web の CLI 例テンプレートを **1 定義から導出**する（08 章 §5）。
- **理由**: ネストしたサブコマンド（`clip trim <id>`）、`-m/--message` などのエイリアス、`strict()` による未知オプション検出、`--help` 自動生成が揃う。Bun で問題なく動くことを検証済み。
- **検証**: `yargs(hideBin(argv)).command("clip", ..., y => y.command("trim <id>", ...)).option("m", { alias: "message" }).strict().parse()` に `clip trim c2 --in +0.5 --ripple --json -m "00:12 カット"` を与え、`{ id: "c2", in: "+0.5", ripple: true, json: true, message: "00:12 カット" }` を得た（日本語引数も問題なし）。
- **注意**:
  - yargs の型はオプション定義から推論されるが、時間表記（`+0.5` / `00:00:12.500` / `f:375`）は `type: "string"` で受けて `cli/time.ts` で解釈する（yargs の数値変換に任せない。`-10` が負数として食われないよう `--in=-10` 形式も案内）。
  - `montash schema` は yargs の内部 API に依存せず、`defineCommand()` に渡した zod スキーマから JSON Schema / ツール定義を生成する。
- **代替案**: commander（軽量だが階層コマンドの型付けが弱い）、citty / cac（小さいが実績が薄い）。

## ADR-05. ファイル監視は chokidar v4（Bun 標準 `fs.watch` は不採用）

- **決定**: `chokidar@4` を使う。WSL の `/mnt/*` 配下では `usePolling: true`（`interval: 500`）にフォールバック。
- **検証**（Bun 1.3.14, macOS）:

| 方式 | テスト内容 | 結果 |
|------|------------|------|
| `chokidar@4.0.3` (`awaitWriteFinish` 有効) | `project.json` の上書き、`tmp → rename` の原子的保存、サブディレクトリ内 `ops.jsonl` の追加 | **すべて検知**（`change:project.json` ×2, `add:ops.jsonl`） |
| Bun 標準 `fs.watch(root, { recursive: true })` | 同上 | **取り逃がし**。`rename:.montash`（ディレクトリ作成）と `rename:p.tmp` のみで、`project.json` の書き込みとネストした `ops.jsonl` の追加を検知できなかった |

- **理由**: 上記のとおり Bun 標準 API 単体では 06 章の要件（`project.json` 変更 → 500ms 以内に反映、`.montash/history/**` の追記検知）を満たせない。chokidar v4 は依存が `readdirp` のみ（v3 にあった `fsevents` などのネイティブ optional 依存が無い）で、Bun 上でも純 JS として動く。ディレクトリごとの `fs.watch` + 自前走査 + ポーリングフォールバックを内蔵している。
- **代替案**:
  - `@parcel/watcher`（ネイティブ。高速だが N-2「ネイティブアドオン不使用」に反する）。
  - 自前ポーリング（`Bun.file(path).lastModified` を 200ms 間隔で比較）。監視対象が `project.json`、`ops.jsonl`、`moves.jsonl`、`preview/timeline.json`、`render/progress.json` の **数ファイルに限定できる** ため、chokidar が将来 Bun で問題を起こした場合の **第 2 案として `server/watcher.ts` にポーリング実装も用意**し、`--watch-mode chokidar|poll` で切替可能にする。
- **影響**: `watcher.ts` は監視バックエンドを抽象化（`interface Watcher { on(path, cb); close() }`）。Bun のバージョンアップ時に `scripts/spikes/watch.ts` を再実行して確認する。

## ADR-06. フロントエンドは React（仮想 DOM）+ canvas のハイブリッド

- **決定**:
  - **React 19**（TSX）でアプリ全体の構造・パネル類（Assets / History タブ / Inspector / Log / ダイアログ / トースト）を作る。状態は **zustand** の単一ストア（`project`, `history`, `assets`, `selection`, `playhead`, `previewState`）。WS の差分メッセージでストアを更新し、React は購読で再描画。
  - **時間軸に同期して高頻度に描く部分は canvas**: 編集タイムラインのクリップ本体・波形・トランジション・再生ヘッド、History タイムラインのノードと辺。React コンポーネントが `<canvas>` を保持し、`requestAnimationFrame` でストアの値（playhead 等）を直接読んで描く（React の再レンダーを経由しない）。
  - **タイムラインの「枠」は React**: トラック行のレイアウト、トラック名ヘッダー、ミュート表示、スクロールコンテナ、時間ルーラーの目盛りラベル。行の増減・並び替えは仮想 DOM の差分に任せる。
  - **ヒットテストは canvas 側で自前**（クリップ矩形・ノード円）。ヒット結果をストアに書き、ツールチップ／コンテキストメニュー／選択枠は React（`position: absolute` の DOM）で描く。
- **理由**（ご提案への回答）: 管理系 UI とタイムラインの構造に React を使う案に賛成。理由は次のとおり。
  - Assets / History / Inspector はリスト・フォーム・ダイアログ中心で、仮想 DOM の差分更新・アクセシビリティ・フォーカス管理が素直に効く。canvas で作るのは非効率。
  - 一方、再生ヘッドは 60fps で動き、クリップは数百〜数千個、波形はピクセル単位の描画になる。これを DOM 要素にすると再レンダーとレイアウトがボトルネックになる。canvas なら 1 フレーム 1 回の描画で済み、プレビュー `<video>` の `currentTime` と同期しやすい。
  - React と canvas の境界を「時間軸上の描画か否か」で切ると責務が明確になる。
- **検証**: Bun の HTML import 開発サーバで React 19 + TSX + `<canvas>` を使うコンポーネントがバンドル・配信されることを確認（ADR-02 の表）。
- **代替案**: Preact（軽量だが React 19 の機能・エコシステムを優先）、Solid（細粒度リアクティブで canvas 連携は良いが採用実績で React）、全 canvas（管理系 UI の開発コストが高い）、全 DOM（クリップ数・同期で不利）。
- **影響**: 06 章 §4 を更新。`web/` は Bun の HTML import で開発、`bun build web/index.html` で本番バンドル、成果物をバイナリに埋め込む。Vite は使わない。

## ADR-07. 非 npm 依存のインストールスクリプト

- **決定**: `scripts/install-deps.sh`（bash）で ffmpeg / ffprobe / Bun / 日本語フォント / WSL ツール（wslu, fontconfig）を検出・導入する。`--check`（確認のみ、終了コードで判定）、`--json`（`montash doctor` と AI が読む）、`--yes`、`--with-fonts` を持つ。
- **理由**: P-2（WSL / Linux / macOS）で ffmpeg の入れ方が異なり、AI が人間に案内する際の「正しい 1 コマンド」が必要。`montash doctor` の `hint` はこのスクリプトの実行を指す。
- **方針**: 各 OS のパッケージマネージャ（brew / apt / dnf / pacman / zypper / apk）の公式 ffmpeg を入れる（libx264 / libfreetype / libass 同梱が一般的）。Bun は公式インストーラ。sudo は必要時のみ、実行前にコマンド一覧を表示して確認。冪等。
- **検証**: macOS（ffmpeg 未導入、Bun 導入済）で `--check` を実行し、ffmpeg の欠落を検出して終了コード 1、`--json` で `needs_install: ["ffmpeg"]` を返すことを確認。`bash -n` で構文チェック済。
- **今後**: ffmpeg の機能（`drawtext` / `subtitles` / `xfade` / `loudnorm` / `sidechaincompress` / HW エンコーダ）の有無も判定し、欠けていれば警告する。Fedora は RPM Fusion の案内を出す。

## ADR-08. テストは `bun test` + bash E2E + Playwright

- **決定**: 単体・スナップショットは `bun test`（Jest 互換）。E2E は 03 章の手順を bash 化した `tests/workflows/W-xx.sh`（`--json` 出力を `jq` で検証）。Web は Playwright（smoke: History ノードクリック → `montash status` の HEAD 変化、Assets 取り込み）。
- **理由**: vitest を外し、ランタイムと同じ Bun でテストを回す。E2E が「手順 = テスト」という作業手順開発の原則を担保。
- **CI**: GitHub Actions のマトリクス `ubuntu-latest` / `macos-latest` / `windows-latest`（WSL2 上で bash 実行）。ffmpeg は `scripts/install-deps.sh --yes` で導入し、スクリプト自体もテストする。

## ADR-09. 時間の内部表現は整数（フレーム／サンプル）、fps は有理数

- **決定**: プロジェクトは `init` 時に **解像度と fps** を設定し（後から `project set` で変更可、再計算を op として記録）、その fps を基準に **タイムライン上の時間・ソースの in/out をすべて整数フレーム（`_f`）** で保持する。音声のサブフレーム補正のみ **整数サンプル（`_smp`）**。fps は `{num, den}` の有理数（`29.97 = 30000/1001`）。秒への変換は表示と ffmpeg 境界のみ（05 章 §2）。
- **理由**: float 秒では `from.end == to.start` の等値比較、ギャップ／重なり検出、29.97fps のフレーム丸めが誤差で壊れる。整数なら不変条件（05 章 §14）を厳密に検証でき、undo/redo・履歴のハッシュも安定する。ffmpeg 側もフレーム／サンプル指定（`trim=end_frame`, `fade=s:n`, `enable=between(n,...)`, `atrim=end_sample`, `adelay=...S`, `afade=ss:ns`）を持つため、秒を経由せずに渡せる箇所が大半。
- **残る秒指定と誤差の扱い**: `-ss`、`xfade=offset/duration`、ASS の時刻は秒でしか渡せない。`-ss` はマイクロ秒精度（後段の `fps=` が量子化するので決定的）、ASS はセンチ秒（floor/ceil で隣接フレームに漏れない）、`xfade` は量子化済み pts に対するマイクロ秒丸めなのでフレーム取り違えは理論上起きないが、**M1 で 29.97fps のゴールデンテスト**（`ffprobe -count_frames` で合成後フレーム数 = 期待値）を必須にする。
- **入力の受理**: `12.5` / `00:00:12.500` → `round(t * num/den)`。丸めが生じたら `W_SNAPPED` で採用値を返す（AI が次の指示に使える）。`f:375` は直接。
- **代替案**: float 秒 + `snap_to_frame`（当初案。比較が壊れる）、`1/(fps*1000)` の tick（fps に依存し fps 変更で意味が変わる）、ナノ秒整数（fps 非依存だが 29.97 のフレーム境界が表せない）。
- **影響**: 05 章全面改稿（`schema_version: 2`）、04 章 §1.3（入力・出力）、07 章（フレーム／サンプル指定）、`core/time.ts`（有理数演算）、Web の再生ヘッド（`<video>.currentTime` → `floor(t*num/den + ε)`）。

## ADR-10. テキスト・字幕は libass（ASS 生成 → `subtitles` フィルタ）

- **決定**: テロップは `drawtext` ではなく、テキストトラックから **ASS ファイルを生成し、libass で焼く**（07 章 §6）。SRT 字幕も ASS の Events に統合して同じ経路で焼く。`drawtext` は libass 無しビルドのフォールバックに降格（`settings.text_engine`）。
- **理由**: `drawtext` は自動折り返し・行単位スタイル・CJK と絵文字の混在フォールバック・複数行の背景ボックスが弱い。ASS/libass は位置（`\an`/`\pos`）、フェード（`\fad`）、縁取り／影、折り返し（WrapStyle）、行内オーバーライド（`markup: ass` で AI が直接書ける）を一貫して扱え、字幕と実装を共有できる。
- **設計上の要点**: `PlayResX/Y` = プロジェクト解像度で px 座標を 1:1 に、`fontsdir=` に解決済みフォントファイルを集めて環境依存（fontconfig の有無）を排除、`original_size` でプレビュー（プロキシ解像度）と本番で同じ ASS を使う。1 テキストクリップ = 1 Style + 1 Dialogue。
- **リスク**: `BorderStyle=4`（行ブロック背景）は libass 拡張で古いビルドに無い → `3` にフォールバック。ASS 時刻がセンチ秒 → floor/ceil で対処。`doctor` で `subtitles` フィルタの有無を確認。
- **代替案**: `drawtext`（当初案）、テキストを PNG に事前描画して overlay（Bun には描画ライブラリが無くネイティブ依存になる）。

## ADR-11. プレビューは「映像セグメントキャッシュ + 音声 1 パス + mux」

- **決定**: `preview build` は映像だけをセグメント（フレーム境界）でキャッシュ・concat し、音声はタイムライン全体を毎回 1 パスで生成し、最後に `-c copy` で mux する（07 章 §11）。
- **理由**: AAC のエンコーダ遅延（priming）により、音声付きセグメントを `-c copy` で concat すると境界でクリック／ズレが出る。音声処理は映像デコードを伴わず数秒で終わるため、毎回生成しても即時性を損なわない。映像は高コストなのでキャッシュの恩恵が大きい。
- **代替案**: MPEG-TS でセグメント化（AAC の扱いが多少良いが完全ではない）、PCM で中間保存（サイズ大）、MediaSource でブラウザ側結合（実装が重い）。

## ADR-12. `clip split` は前半が元 ID を維持する

- **決定**: `clip split c2 --at t` は `c2` を前半として ID を維持し、後半だけ新規採番（`c7` など）で作る。リンク音声も同様。結果 JSON は `{ kept: "c2", created: "c7", linked: { kept: "c2a", created: "c7a" } }` を返す。
- **理由**: 旧案（`c2a/c2b` に改名し `c2` を無効化）は、AI が直前の ID を使い続けて `E_CLIP_NOT_FOUND` を踏みやすく、履歴の `affects.clips` も不安定になる。ID は「そのクリップの同一性」であり、分割で前半の同一性は保たれると考える。
- **影響**: 04 章 `clip split`、03 章 W-04、06 章 CLI 例、10 章の翻訳表。

## ADR-13. 要素 ID の採番カウンタは履歴の外（`.montash/ids.json`）に置く

- **決定**: クリップ・トランジション・テキスト等の ID（`c7`, `t3`, `x2`）は、**`project.json` に含めない単調増加カウンタ**（`.montash/ids.json`、プレフィックスごと）から採番する。`checkout` で `project.json` が過去に戻ってもカウンタは戻らない。
- **理由**: カウンタを `project.json` に持つと、過去へ戻って新要素を作ったときに別系列と同じ ID が生まれ、`blame` / `affects.clips` / Web の由来表示が壊れる（13 章 A-1）。ランダム ID は衝突しないが AI・人間に読みにくい。
- **運用**: `ids.json` が失われた場合（別マシンへ `history import`、手動削除）は `montash ids rebuild` が全 object と現在の `project.json` を走査して各プレフィックスの最大値 +1 に復元する。`--id` で明示指定された ID が過去のいずれかの object に存在する場合は `W_ID_REUSED`。アセット ID はファイル名 slug なので対象外（同じファイルなら同じ ID で良い）。
- **代替案**: ランダム 4 桁（読みにくい）、op ID を含める（長い）、`project.json` 内カウンタ（当初案・衝突）。

## ADR-14. ffprobe の生 JSON は `project.json` から外し、キャッシュに置く

- **決定**: `assets.*.probe`（ffprobe の `-show_streams -show_format` 生 JSON）を `project.json` から削除し、`.montash/cache/<asset_id>/probe.json` に置く。`project.json` には要約（codec、解像度、fps、pix_fmt、duration_s/f、sample_rate、channels、rotation、has_alpha）のみ残す。
- **理由**: 履歴は `project.json` 全体を op ごとにスナップショットする（内容アドレスで重複排除するが、op ごとに内容は変わる）。生 JSON を含めると 50 素材 × 1000 op で数百 MB〜GB になる（13 章 A-2）。生 JSON は原本から再生成できる派生物であり、編集判断には要約で十分。
- **影響**: `assets show` は `probe.json` を読み、無ければ ffprobe を再実行して再生成。`import` は両方を書く。`hash_head` は `project.json` に残す（relink 用）。

## ADR-15. ffmpeg は「バージョン」でなく「機能検出」で要件判定し、Linux/WSL は static ビルドを既定経路にする

- **決定**:
  - `doctor` と `install-deps.sh` は ffmpeg の可否を **必須機能の有無**で判定する。必須: `libx264`, `aac`, `xfade`, `concat`, `overlay`, `loudnorm`, `sidechaincompress`。推奨: `subtitles`（libass）、`drawtext`。バージョンは 4.4 未満を `outdated`、6.0 未満を「best effort（警告）」とする。
  - Linux / WSL では、ディストリの ffmpeg が無い・古い・機能不足の場合、**BtbN の GPL static ビルド**（代替: johnvansickle）を `~/.local/share/montash/ffmpeg/bin` に展開し `~/.local/bin` にリンクする（sudo 不要）。`montash` のバイナリ探索順は `MONTASH_FFMPEG` / `--ffmpeg-path` → `PATH` → `~/.local/share/montash/ffmpeg/bin`。macOS は brew（フル機能）。
- **理由**: Ubuntu 22.04 の apt は 4.4.2、Debian 12 は 5.1 で、WSL 利用者の多くがここに該当する（13 章 A-3）。「6.0 以上」を要件にすると主要ターゲットで導入できない。一方、必要な機能は 4.4 でも揃っており、真に必要なのは「libx264 / libass 入りのビルドか」である。static ビルドは sudo 不要でユーザー領域に閉じ、CI でも同じものを使える。
- **リスク**: BtbN のアセット名の変更（`ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz` 形式）→ 取得失敗時は johnvansickle にフォールバックし、それも失敗すれば手動導入を案内。チェックサム検証は未実装（HTTPS + `ffmpeg -version` の実行確認のみ。要改善）。
- **影響**: 02 章 N-2、04 章 `doctor`、08 章 `ffmpeg/locate.ts`、`scripts/install-deps.sh`（`--static`, `--dry-run` 追加）。

## ADR-16. リップルは既定で全トラックに及ぶ（`--ripple=track` で限定）

- **決定**: `--ripple` を伴う操作（`clip trim/delete/move/split` 後の詰め、`clip add --on-overlap push` の押し出し）は、既定で **全トラックの要素**（クリップ・テキスト・オーバーレイ・トランジション）に及ぶ。`--ripple=track` で当該トラックのみ。`locked: true` のトラックは常に除外。
- **理由**: 映像の一部を削ると BGM・テロップ・ロゴも一緒に詰まるのが編集者の期待（多くの NLE の既定）。トラック限定が既定だとテロップが映像から外れる事故が起きやすい（13 章 A-4）。
- **規則**（04 章 §6a に詳述）: 編集点 `p_f` と変化量 `delta_f`（削除は負、挿入は正）に対し、`start_f >= p_f` の要素は `delta_f` だけ移動。`start_f < p_f < end_f` で区間を跨ぐ要素は、削除なら `duration_f` を `|delta_f|` 縮め、挿入ならアセットに余白（または `loop`）があれば伸ばし、無ければ伸ばさず `W_RIPPLE_SPAN_NOT_EXTENDED`。編集点を跨ぐトランジションは削除して `W_TRANSITION_REMOVED`。
- **代替案**: 当該トラックのみを既定（当初の暗黙仕様。事故が起きやすい）、リップル無し既定（AI が毎回 `--ripple` を付ける負担）。

## ADR-17. アプリ名・CLI コマンド名は `montash`

- **決定**: アプリ名・CLI コマンド名・npm パッケージ名を **`montash`** とする（暫定名 `vedit` を全面置換）。派生: プロジェクト内ディレクトリ `.montash/`、環境変数 `MONTASH_*`、static ffmpeg 置き場 `~/.local/share/montash/ffmpeg`、ログ `montash-YYYYMMDD.log`、エラークラス `MontashError`。
- **由来**: **montage**（モンタージュ = 素材を繋いで意味を作る、編集の本質）+ **`sh`**（bash / zsh の系譜、シェルから操作する CLI）。「動画編集」と「CLI」の両方を 1 語で表す。
- **選定過程**（2026-09-14）: ①編集用語系（`komadori` / `kirihari` / `hasami`）→ CLI 概念が無い、②CLI 概念系（`komash` / `cutsh` / `promptcut`）→ 編集の意味が弱い、③両方を含む系（`montash` / `hensh` / `reelsh` / `cinesh`）から `montash` を採用。
- **衝突確認**: npm レジストリ（404 = 未使用）、ローカル PATH、Homebrew formula のいずれも未使用（2026-09-14 時点）。公開時に `montash` を npm で確保する。
- **影響**: 仕様全体・`scripts/install-deps.sh`・`scripts/spikes/` の表記を置換済み。GitHub リポジトリも `TakehiroTada/montash`（仕様策定時の作業ディレクトリ名は `cli-video-editor`）。

## 保留（実装時に問題化したら検討）

13 章 B-1〜B-4（`Bun.spawn` での ffmpeg 制御、コンパイル済みバイナリの自己 spawn と資産埋め込み、大容量アップロードのメモリ、`xfade=offset` の 29.97fps 境界）は、**事前 spike を行わず実装中に検証**する方針とした（2026-09-14）。ただし B-4 はゴールデンテスト（08 章 §6）として M1 のテストスイートに含めるため、事実上そこで検証される。

## 決定一覧（サマリ）

| # | 領域 | 決定 | 検証 |
|---|------|------|------|
| ADR-01 | 言語 | フル TypeScript（strict） | — |
| ADR-02 | ランタイム | Bun 1.2+（PM / test / build / compile 含む） | ✅ 実機 |
| ADR-03 | Web サーバ | `Bun.serve`（Range・WS 標準） | ✅ 実機 |
| ADR-04 | CLI | yargs 17 + `defineCommand` + zod | ✅ 実機 |
| ADR-05 | 監視 | chokidar 4（`fs.watch` は不採用、ポーリングを第 2 案） | ✅ 実機（比較） |
| ADR-06 | フロント | React 19 + zustand + canvas（時間軸描画） | ✅ 実機（バンドル） |
| ADR-07 | 依存導入 | `scripts/install-deps.sh` | ✅ `--check` |
| ADR-08 | テスト | `bun test` + bash E2E + Playwright | — |
| ADR-09 | 時間表現 | 整数フレーム（`_f`）／整数サンプル（`_smp`）、fps は有理数 | M1 ゴールデンテストで検証 |
| ADR-10 | テキスト | ASS 生成 → libass（`drawtext` はフォールバック） | M3 |
| ADR-11 | プレビュー | 映像セグメントキャッシュ + 音声 1 パス + mux | M2/M3 |
| ADR-12 | ID | `clip split` は前半が元 ID を維持 | — |
| ADR-13 | ID | 採番カウンタは `.montash/ids.json`（履歴の外） | — |
| ADR-14 | データ | ffprobe 生 JSON は `.montash/cache/<id>/probe.json` へ | — |
| ADR-15 | 依存 | ffmpeg は機能検出で判定、Linux/WSL は static ビルド既定 | `install-deps.sh --dry-run` |
| ADR-16 | 編集 | リップルは既定で全トラック、`--ripple=track` で限定 | — |
| ADR-17 | 名称 | アプリ名・CLI 名は `montash`（montage + sh） | npm / PATH / brew 衝突なし |

## 再検証の手順

Bun のメジャー／マイナー更新時に `scripts/spikes/` を再実行する:

```bash
bun run scripts/spikes/watch.ts     # chokidar と fs.watch の検知比較（期待: chokidar OK）
bun run scripts/spikes/serve.ts     # Range 206 / WebSocket echo
bun run scripts/spikes/yargs.ts     # ネストコマンドのパース
bun run scripts/spikes/frontend.ts  # HTML import で React がバンドル配信される
bun build --compile scripts/spikes/compile.ts --outfile /tmp/montash-spike && /tmp/montash-spike
```
