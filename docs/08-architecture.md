# 08. アーキテクチャ

## 1. 技術選定

決定の経緯と実機検証の結果は **12 章（ADR）** を正とする。ここでは結論のみ。

| 領域 | 選定 | 理由（要約） | ADR |
|------|------|--------------|-----|
| 言語 | **TypeScript（strict）のみ** | CLI・サーバ・フロントで型と zod スキーマを共有 | 01 |
| ランタイム／PM／テスト／ビルド | **Bun 1.2+**（`bun run` / `bun add` / `bun test` / `bun build --compile`） | TS 直接実行・高速起動・単一バイナリ・標準 API が揃う。実機検証済 | 02 |
| CLI パーサ | **yargs 17** + 自作 `defineCommand()` | ネストコマンド・エイリアス・strict。Bun で動作確認済 | 04 |
| スキーマ検証 | `zod` | `project.json`・コマンド引数の検証と `montash schema` の JSON Schema 生成を 1 定義から | 04 |
| Web サーバ | **`Bun.serve`**（フレームワーク無し） | Range 対応静的配信・WebSocket・multipart が標準。実機検証済 | 03 |
| ファイル監視 | **chokidar 4**（`usePolling` フォールバック） | Bun 標準 `fs.watch` は検知漏れを実機で確認。chokidar 4 はネイティブ依存無しで動作確認済。ポーリング実装を第 2 案として同梱 | 05 |
| ffmpeg 呼び出し | `Bun.spawn`（配列引数、`-progress pipe:1` を stdout から読む） | シェル不経由、進捗ストリーム | 02 |
| フロントエンド | **React 19 + zustand + canvas**。開発は Bun の HTML import（HMR）、本番は `bun build web/index.html` | 管理系・パネル・タイムラインの枠は仮想 DOM、時間軸描画（クリップ・波形・再生ヘッド・History ノード）は canvas | 06 |
| テスト | `bun test`（単体・スナップショット）、bash E2E（`tests/workflows/W-xx.sh`）、Playwright（Web smoke） | 手順そのものをテストにする | 08 |
| 配布 | `bun build --compile` で OS 別単一バイナリ（Web 資産埋め込み）+ npm（`bunx montash`） | インストール障壁を下げる。63MB 程度 | 02 |
| 非 npm 依存 | `scripts/install-deps.sh`（ffmpeg / Bun / フォント / WSL ツール） | OS 差を吸収し、`doctor` の `hint` から辿れる | 07 |
| 依存制約 | ネイティブアドオン不使用 | N-2。Bun での互換性リスクも下がる | — |

**代替案と不採用理由（要約）**: Node.js 20（当初案）は tsx / fastify / vitest / Vite / SEA と依存が増える。Python は WSL/macOS の環境差で摩擦が大きい。Go/Rust は Web UI 同梱と開発速度で TS を優先。Bun 標準 `fs.watch` は検知漏れ（12 章 ADR-05）。

## 2. モジュール構成

```
cli-video-editor/
├── package.json                # "packageManager": "bun@1.x", scripts: dev / build / compile / test / doctor
├── bun.lock  bunfig.toml  tsconfig.json
├── scripts/
│   ├── install-deps.sh         # 非 npm 依存（ffmpeg / Bun / フォント / WSL ツール）の導入・確認（12 章 ADR-07）
│   ├── make-fixtures.sh        # テスト素材生成（ffmpeg testsrc2 / sine）
│   ├── build.ts                # bun build web/index.html → web/dist
│   ├── release-build.ts        # OS 別の単一バイナリ（bun run release）。4 ターゲットをクロスコンパイル
│   ├── check-spec-drift.ts     # docs/04 §1.9 ⇄ montash schema の差分検出（bun run check:spec、C-5）
│   ├── check-bun-spikes.ts     # spikes を検証した Bun バージョンとの差を知らせる（C-7）
│   └── spikes/                 # Bun 互換性の再検証スクリプト（watch / serve / yargs / frontend / compile）
├── src/
│   ├── cli/                    # コマンド定義（04 章と 1:1）
│   │   ├── index.ts            # エントリ（yargs 構築、グローバルオプション、出力整形）。buildCli() は async（registry/commands.ts の getCommands() を await する）
│   │   ├── define-command.ts   # defineCommand(): yargs 登録・zod 検証・schema 出力・CLI 例テンプレートを 1 定義から
│   │   ├── commands/
│   │   │   ├── doctor.ts  init.ts  project.ts  validate.ts  diff.ts
│   │   │   ├── import.ts  assets.ts  proxy.ts  fonts.ts
│   │   │   ├── track.ts  clip.ts  timeline.ts
│   │   │   ├── transition.ts  fade.ts  text.ts  overlay.ts  audio.ts  subtitle.ts
│   │   │   ├── serve.ts  preview.ts
│   │   │   ├── render.ts
│   │   │   ├── status.ts  log.ts  show.ts  diff.ts  blame.ts  commit.ts  checkout.ts  undo.ts  redo.ts  revert.ts  reset.ts  tag.ts  history.ts
│   │   │   ├── registry.ts     # 組み込みコマンドの一覧（この配列を直接読むのは registry/commands.ts だけ）
│   │   │   └── batch.ts  explain.ts  schema.ts
│   │   ├── output.ts           # 人間向け／JSON 出力（時間は _f / 秒 / tc を併記）、終了コード
│   │   ├── errors.ts           # MontashError(code, message, hint, detail)
│   │   └── time-input.ts       # 入力表記（12.5 / 00:00:12.500 / f:375 / +f:15 / s:-960 / end-3）→ フレーム or サンプル。W_SNAPPED 判定
│   ├── core/                   # ドメインロジック（ffmpeg も I/O も知らない純関数中心）
│   │   ├── time.ts             # 有理数 fps {num,den}、frames→seconds/ms/µs/tc、frames→samples、fps 変更の再スナップ。float 比較を一切しない
│   │   ├── schema.ts           # zod: Project, Asset, Track, Clip, Transition...（_f / _smp は z.number().int().nonnegative()）
│   │   ├── project.ts          # load/save、マイグレーション、ハッシュ
│   │   ├── timeline.ts         # 追加・移動・トリム・分割・リップル・重なり解消
│   │   ├── transitions.ts      # ハンドル計算、xfade offset 計算
│   │   ├── validate.ts         # 不変条件チェック（05 章 §13）
│   │   ├── history/            # git ライク履歴（11 章）
│   │   │   ├── store.ts        # ops.jsonl / commits.jsonl / objects の追記・読込（append-only、内容アドレス）
│   │   │   ├── dag.ts          # parent/child 解決、HEAD~n、tip、系列判定、redo 候補
│   │   │   ├── commit.ts       # pending 集約、auto-message、amend、stats
│   │   │   ├── checkout.ts     # object 展開、moves 記録、dirty 検出
│   │   │   ├── diff.ts         # JSON Patch 生成、affects 算出、revert 逆差分
│   │   │   └── summary.ts      # op の summary（人間向け 1 行）生成
│   │   ├── assets.ts           # usage 算出、text asset の読み書き、owned 判定、probe 要約の抽出（生 JSON はキャッシュへ）
│   │   ├── ripple.ts           # 全トラック／単一トラックのリップル規則（04 章 §6a）。純関数
│   │   ├── ids.ts              # ID 生成（.montash/ids.json のカウンタ。履歴対象外）・rebuild・セレクタ解決
│   │   └── presets.ts          # text/render 組み込みプリセット
│   ├── registry/               # 拡張点レジストリ（組み込みも同じ経路を通す。14 章）
│   │   ├── commands.ts         # getCommands(): 組み込みコマンド + 実行時登録の合成。cli / schema / help の 3 者が通る唯一の経路
│   │   └── requirements.ts     # 拡張が宣言する ffmpeg 機能要求（filters / encoders）を組み込みの必須集合に合成。doctor が検査
│   ├── ffmpeg/                 # ffmpeg 連携（07 章と 1:1）
│   │   ├── locate.ts           # バイナリ探索（--ffmpeg-path / MONTASH_FFMPEG → PATH → ~/.local/share/montash/ffmpeg/bin）、機能検出（必須/推奨。ADR-15）
│   │   ├── probe.ts            # ffprobe ラッパ
│   │   ├── graph/              # フィルタグラフビルダー
│   │   │   ├── builder.ts      # Project → FilterGraph（入力、ラベル、フィルタ列）。時間はフレーム／サンプルで渡し、秒が必要な箇所だけ time.sec() を使う
│   │   │   ├── video.ts  audio.ts  overlay.ts
│   │   │   ├── ass.ts          # テキスト／字幕クリップ → ASS 文書（Style/Dialogue、\an/\pos/\fad、色変換、エスケープ、センチ秒丸め、fontsdir 構築）
│   │   │   ├── drawtext.ts     # libass 無し環境のフォールバック
│   │   │   └── serialize.ts    # FilterGraph → 引数配列、エスケープ
│   │   ├── run.ts              # Bun.spawn、進捗パース（-progress pipe:1）、キャンセル（SIGTERM）、ログ
│   │   ├── proxy.ts            # プロキシ・サムネイル・波形
│   │   ├── preview.ts          # 映像セグメント分割（フレーム境界）・キャッシュ・concat、音声 1 パス、mux
│   │   ├── render.ts           # プリセット適用、2 パス、hwaccel、verify
│   │   └── fonts.ts            # fc-list / ディレクトリ走査
│   ├── server/                 # Web プレビュー（06 章）
│   │   ├── index.ts            # Bun.serve({ hostname, port, routes, fetch, websocket, maxRequestBodySize })。本番は埋め込み web/dist を Bun.file で配信（Range 自動）、開発は HTML import ルート
│   │   ├── routes.ts           # GET /api/*（project, history, assets, blame, diff, cli-examples, fonts）
│   │   ├── cli-exec.ts         # POST /api/cli: 許可リスト照合、confirm 判定、MONTASH_ACTOR=web で Bun.spawn(process.execPath, ...)、直列キュー、非同期ジョブ
│   │   ├── upload.ts           # POST /api/upload: req.formData()、assets/incoming/ 保存、サニタイズ、import 連携
│   │   ├── ws.ts               # WebSocket push（server.publish によるトピック配信: project/history/assets/job/render）
│   │   ├── watcher.ts          # Watcher 抽象（chokidar 4 バックエンド / ポーリングバックエンド）、デバウンス、auto preview、history 差分検知
│   │   └── cli-examples.ts     # 選択要素 → コマンド例（cli/define-command の定義を参照）
│   └── shared/                 # CLI・サーバ・フロントで共有する型
│       └── types.ts
├── web/                        # フロントエンド（React 19 + zustand + canvas。Bun HTML import で開発、bun build で本番）
│   ├── index.html              # <script type="module" src="./src/main.tsx">
│   ├── dist/                   # bun build の成果物（バイナリに埋め込み。git 管理外）
│   └── src/
│       ├── main.tsx  App.tsx
│       ├── store.ts            # zustand: project / history / assets / selection / playhead / previewState
│       ├── ws.ts  api.ts  cli-client.ts（POST /api/cli ラッパ、confirm ダイアログ連携）
│       ├── canvas/             # 時間軸描画（React の再レンダーを経由しない rAF 描画 + ヒットテスト）
│       │   ├── timeline-renderer.ts   # クリップ・波形・トランジション・テキスト・ギャップ・再生ヘッド
│       │   ├── history-renderer.ts    # DAG レイアウト、コミット/op ノード、HEAD、pending、分岐
│       │   └── hit-test.ts
│       ├── components/         # React（仮想 DOM）
│       │   ├── Player.tsx  Transport.tsx  Header.tsx  LogPane.tsx
│       │   ├── Timeline/       # TimelineView.tsx（枠・トラック行・ルーラー・スクロール）, TrackRow.tsx, TimelineCanvas.tsx（<canvas> を保持）, ClipTooltip.tsx
│       │   ├── History/        # HistoryStrip.tsx（下部常設、canvas 保持）, HistoryPanel.tsx（タブ: 詳細・差分・タグ・revert）, NodeContextMenu.tsx
│       │   ├── Assets/         # AssetsPanel.tsx（一覧/グリッド・フィルタ・検索）, AssetDetail.tsx（単体プレビュー・usage）, ImportDialog.tsx（パス/ドロップ）, TextAssetForm.tsx
│       │   ├── Inspector.tsx
│       │   └── ui/             # ConfirmDialog.tsx, Toast.tsx, Tabs.tsx
│       └── styles.css
├── tests/
│   ├── unit/                   # bun test: core/、ffmpeg/graph の純関数・スナップショット
│   ├── fixtures/               # 生成スクリプトで作る短いテスト素材（ffmpeg の testsrc2/sine）
│   ├── workflows/              # W-01.sh ... W-17.sh（bash E2E、--json を jq で検証）
│   └── web/                    # Playwright smoke（History クリック→HEAD 変化、Assets 取り込み）
└── docs/                       # 本仕様
```

### 依存方向

```
web/ ──(HTTP/WS)──▶ server/ ──▶ registry/, core/, ffmpeg/, cli/(define-command の toSchema のみ)
cli/ ──▶ registry/, core/, ffmpeg/, server/(serve のみ)
ffmpeg/ ──▶ registry/, core/(型のみ)
registry/ ──▶ core/(型のみ)。組み込み定義は遅延 import で読む（循環回避）
core/ ──▶ registry/(種別の検査フックのみ。validate.ts → registry/generators.ts)。ほかは外部依存なし（zod のみ）
```

`registry/commands.ts` は `cli/commands/registry.ts`（組み込みコマンドの静的配列）を**静的に import しない**。
組み込み配列は `schema` / `help` のコマンド定義を含むため、静的に結ぶと
`registry.ts → help.ts → registry/commands.ts → registry.ts` の循環になる。組み込みの読み込みだけを
`await import()` に閉じ込め、`getCommands()` を async にしている（`buildCli()` が async なのはこのため）。
`registry/requirements.ts` は `ffmpeg/locate.ts` から読まれるので、何も import しない。

`server/specs.ts`（`GET /api/specs`）だけが `server/ → cli/` を向く。`montash schema --json` と 1 文字でも
食い違うと Web のフォームが CLI と別物になるため、`toSchema()` を複製せずそのまま使う。`define-command.ts` は
コマンド定義と変換だけを持つ葉モジュールなので、`cli/commands/serve.ts → server/index.ts → cli/define-command.ts`
は循環しない（組み込みコマンド配列の読み込みは `getCommands()` の遅延 import のまま）。

`core/validate.ts` → `registry/generators.ts` は**唯一の core → registry**。ジェネレータ種別ごとの意味検査
（`hold` の `params.from_clip` など）を仕様の隣（`defineGenerator().validate()`）に置くためで、
`registry/` 側は `core/schema.ts` を**型としてしか**読まないので実行時の循環にはならない。

`core/` は ffmpeg もファイルシステムも知らない純関数群にし、単体テストを厚くする。`ffmpeg/graph/builder.ts` も入力 `Project` → 出力 `string[]`（引数配列）の純関数として、スナップショットテストで守る。

## 3. 主要な処理フロー

### 3.1 状態変更コマンド（例: `clip trim`）

```
cli/commands/clip.ts
  ├─ parse args（zod）→ time.ts で秒に変換
  ├─ project.load()                    ← project.json 読み込み＋検証
  ├─ history.checkout.assertClean()     ← HEAD.after と一致しなければ W_DIRTY_WORKTREE（--force-dirty で op 化）
  ├─ before = history.store.putObject(project)
  ├─ timeline.trim(project, ...)        ← 純関数。新 Project と changes[] を返す
  ├─ validate.quick(newProject)         ← 不変条件（error なら何も書かずに失敗）
  ├─ after = history.store.putObject(newProject)
  ├─ project.save(newProject)           ← 原子的書き込み（tmp → rename）
  ├─ op = history.store.appendOp({ parent: HEAD, actor, command: argv, before, after, changes, affects, summary })
  ├─ history.store.setHead(op.id)
  ├─ if -m: history.commit.create({ ops: [op.id], message })
  └─ output.success({ result, changes, warnings, op, commit, head, timeline })
```

- `--dry-run` は `putObject`/`save`/`appendOp` を飛ばし、`changes` を表示。
- `project.save` は `updated_at` を更新。`serve` の watcher が `project.json` と `ops.jsonl` を検知し WS で配信。

### 3.1a `checkout`（Web からも同じ経路）

```
cli/commands/checkout.ts
  ├─ ref 解決（dag.resolve: op/commit/tag/tip/HEAD~n）
  ├─ obj = store.getObject(target.after)
  ├─ project.save(obj)                  ← 展開（数十 ms）
  ├─ store.setHead(target.id); store.appendMove({from, to, actor})
  └─ output.success({ head, detached, pending_left_behind })
```

### 3.1b Web からのコマンド発行

```
web: cli-client.exec(["checkout","k_0006"])
  └─ POST /api/cli
server/cli-exec.ts
  ├─ allowlist.check(args)              ← 不許可 → 403
  ├─ needsConfirm(args) && !confirm     ← 破壊的 → 409
  ├─ queue.enqueue(() => spawn(montashBin, [...args, "--json", "--yes"], { env: { MONTASH_ACTOR: "web", MONTASH_ACTOR_DETAIL } }))
  ├─ 長時間コマンド（import/proxy build）は job として即 202 + job_id、進捗を WS job.progress
  └─ CLI の JSON をそのまま返却（+ exec メタ）
watcher: project.json / ops.jsonl / moves.jsonl 変更 → WS project.changed / history.appended / history.moved
```

`montash` を **同じバイナリで子プロセス実行** するのは、コマンド定義・検証・履歴記録を CLI と完全に共有し、「全処理は CLI」を実装レベルで保証するため。`Bun.spawn([process.execPath, ...])` を使い、開発時は `bun src/cli/index.ts`、コンパイル済みバイナリでは自分自身を起動する。Bun の起動コスト（数十 ms）は checkout の即時性要件（300ms 以内に表示更新）に十分収まる。将来 in-process 呼び出しに切り替える場合も同じ `defineCommand` 定義を経由する。

### 3.2 `preview build`

```
ffmpeg/preview.ts
  ├─ project.load()
  ├─ segments = splitSegments(project)        ← 境界計算（07 章 §11）
  ├─ for seg in segments (parallel N):
  │     hash = hashSegment(project, seg)
  │     if cache miss: graph = builder.build(project, {from, to, proxy: true}); run(ffmpeg, graph → seg.mp4)
  ├─ concat(segments) → timeline.mp4          ← -c copy
  ├─ write timeline.json
  └─ notify（serve 経由なら WS、単体実行なら stdout）
```

### 3.3 `render`

```
ffmpeg/render.ts
  ├─ validate.full()（error → exit 5）
  ├─ preset 解決 + オプション上書き
  ├─ if normalize: measure = run(audio-only graph, loudnorm print_format=json)
  ├─ graph = builder.build(project, {from, to, proxy: false, loudnorm: measure})
  ├─ args = serialize(graph) + outputArgs(preset)
  ├─ --dry-run → 表示して終了
  ├─ run(ffmpeg, args, onProgress → stdout jsonl / progress.json)
  ├─ verify(output)
  └─ save last.json, output.success
```

### 3.4 `serve`

```
server/index.ts
  ├─ Bun.serve({
  │     hostname, port, maxRequestBodySize,
  │     routes: { "/": indexHtml（開発: HTML import / 本番: 埋め込み dist）, "/api/project": ..., "/api/cli": { POST }, "/api/upload": { POST }, "/preview/:file": Range 自動 },
  │     fetch: 静的アセット・404、"/ws" は server.upgrade(),
  │     websocket: { open: subscribe("events"), message: noop }
  │  })
  ├─ watcher（chokidar 4 / poll）: project.json → server.publish("events", project.changed) → debounce → preview.build（前回をキャンセル可）
  │           .montash/history/{ops,moves}.jsonl → history.appended / history.moved
  │           .montash/cache/** → proxy.state
  │           .montash/render/progress.json → render.progress
  └─ --open → open / xdg-open / wslview
```

## 4. 横断的関心事

### 4.1 エラー
- `MontashError { code, message, hint?, detail?, exitCode }` を全層で投げる。`cli/output.ts` が JSON／テキストに整形。
- ffmpeg 失敗は `run.ts` が stderr 末尾を捕まえ `E_FFMPEG_FAILED` に詰める。既知パターン（`Cannot find a valid font`, `No such filter`）は個別コードにマップ。

### 4.2 ログ
- `.montash/logs/montash-YYYYMMDD.log` に、実行コマンド、ffmpeg 引数（配列を shell-quote した形）、所要時間、stderr（失敗時）を追記。`--verbose` で stderr にも出す。

### 4.3 並行性・整合性
- `project.json` の書き込みは `tmp → rename` で原子的に。
- 同時実行（`serve` の auto preview と手動 `preview build`）は `.montash/preview/.lock`（pid + timestamp、古ければ奪取）で直列化。
- `render` は `project.json` をコピーして固定（レンダー中の変更に影響されない）。

### 4.4 プラットフォーム差
- ブラウザ起動: `darwin: open`, `linux: xdg-open`, `wsl: wslview || cmd.exe /c start`（`/proc/version` に `microsoft` があれば WSL）。`scripts/install-deps.sh` が WSL で `wslu` を導入する。
- 依存導入: `scripts/install-deps.sh`（12 章 ADR-07）。`montash doctor` は不足時の `hint` にこのスクリプトを提示し、`--json` 出力（`install-deps.sh --check --json`）を取り込んで表示する。
- パス: 常に POSIX。`/mnt/*` 上のプロジェクトはポーリング監視、`doctor` で性能警告。
- フォント: macOS `/System/Library/Fonts`, `~/Library/Fonts`; Linux `fc-list`; WSL は追加で `/mnt/c/Windows/Fonts`。
- `ffmpeg` の progress パイプは `pipe:1`（stdout）で統一。

### 4.5 セキュリティ
- Web は `127.0.0.1` 既定。CORS 無し。POST は `/api/cli`（許可リスト制、confirm 必須フラグ）と `/api/upload`（プロジェクト配下限定、サニタイズ、サイズ上限）のみ。`--read-only` で両方 405。
- `POST /api/cli` の引数は配列のまま `spawn` に渡し、シェルを経由しない。`--project` / `-C` / `--ffmpeg-path` 等のグローバルオプションはサーバ側で固定し、クライアントから上書きできない。
- パス引数はプロジェクトルート配下か `--allow-outside` を要求（`import` は例外的に任意パスを許可するが、シンボリックリンク解決後の実パスを保存）。
- テキストは生成した ASS ファイル（`.montash/tmp/`）経由で渡し、`markup: plain` では `{ } \` をエスケープする。フォントパス等は配列引数で渡し、シェルを経由しない（`Bun.spawn` に配列）。フィルタ文字列内のパスは短い相対パスに限定してエスケープ事故を防ぐ。

## 5. `schema` 出力の生成

各コマンドは `defineCommand({ name, summary, workflows: ['W-04'], args: zodSchema, examples: [...] })` で宣言する。この定義から：

- `yargs` への登録（`.command()` のビルダーとハンドラを zod スキーマから生成。時間表記の引数は `type: "string"` で受けて `cli/time.ts` で解釈）
- `montash help --json` / `montash schema`（JSON Schema、LLM ツール定義）
- `server/cli-examples.ts` のテンプレート
- ドキュメント `04-cli-spec.md` の自動生成チェック（CI で差分検出）

を一元的に導出し、仕様と実装のズレを防ぐ。

### 定義リストの合成（13 章 D-18）

上の 3 つの導出先は、いずれも `registry/commands.ts` の **`getCommands()` という 1 本の経路**からコマンド定義を受け取る。

```
cli/commands/registry.ts（組み込みの静的配列）
        │  await import()（循環回避）
        ▼
registry/commands.ts  getCommands() = 組み込み + registerCommand() で実行時登録された分
        ├──▶ cli/index.ts  buildCli()  → registerCommands(yargs, ...)   実行
        ├──▶ cli/commands/schema.ts    → montash schema（AI のツール定義）
        └──▶ cli/commands/help.ts      → montash help
```

`getCommands()` は合成結果を `buildCommandTree()` に通すので、組み込みと衝突するパスは
`duplicate command path` で弾かれる。3 者が同じリストを見るため、実行時に足したコマンドが
「実行はできるが `schema` / `help` に出ない（= AI のツール定義から漏れる）」ことが起きない。

ffmpeg の機能要求も同じ形で合成する。`ffmpeg/locate.ts` の `REQUIRED_FILTERS` / `RECOMMENDED_FILTERS` は
「組み込みが必要とする最小集合」で、拡張は `registry/requirements.ts` の `registerRequirements()` で
自分が必要とするフィルタ・エンコーダを宣言する。`montash doctor` はその合成結果を検査するので、
拡張を入れた環境では不足がそのまま診断に出る。登録が空のときは定数そのままで、従来と同じ判定になる。

## 6. テスト戦略

| 層 | 方法 |
|----|------|
| `core/` | `bun test`。タイムライン操作の性質テスト（重なり無し、リンク同期、リップルで総尺保存 等） |
| `core/history` | `bun test`。性質テスト: 任意の op 列と checkout 列に対し `HEAD.after == hash(project.json)`、undo→redo で同一 object、分岐後に旧系列が `log --all` に残る、`revert(revert(x)) == x`、`verify` が常に通る |
| `server/cli-exec` | 許可リスト・confirm・直列化・actor 付与のテスト。不許可コマンドが 403 になること |
| `server/watcher` | chokidar / poll 両バックエンドで `tmp → rename` 保存と `ops.jsonl` 追記を検知すること（12 章 ADR-05 の spike をテスト化） |
| `core/time` | `bun test`。有理数変換の往復（`frames→sec→frames` が恒等）、29.97/59.94 でのサンプル丸め誤差 < 1、fps 変更の再スナップ、`W_SNAPPED` 判定 |
| `ffmpeg/graph` | `bun test` スナップショット。`Project` フィクスチャ → 引数配列を固定。`ass.ts` は生成 ASS 文書のスナップショット |
| `ffmpeg/run`, `proxy`, `render` | 実 ffmpeg を使う統合テスト。素材は `testsrc2`/`sine` で生成した数秒の mp4（`scripts/make-fixtures.sh`）。**ゴールデンテスト**: 30 / 29.97 / 59.94 fps のプロジェクトで concat・xfade・overlay・ASS を含むタイムラインをレンダーし、`ffprobe -count_frames` のフレーム数が `duration_f` と一致、各カット点のフレームが期待どおり（`testsrc2` のフレームカウンタ表示を OCR せず、`select=eq(n,K)` で切り出した PSNR で判定） |
| `server/` | `Bun.serve({ port: 0 })` を起動して `fetch` / `WebSocket` で直接叩く（Range 206、WS echo、POST 許可リスト） |
| `web/` | Playwright で主要表示と操作（History クリック→`status` の HEAD 変化、Assets 取り込み）。CI では smoke |
| E2E | `tests/workflows/W-xx.sh`：03 章の手順をそのまま bash で実行し、`--json` 出力を `jq` で検証。CI マトリクス: ubuntu / macos / windows(WSL2)。各ジョブ冒頭で `scripts/install-deps.sh --yes` を実行しスクリプト自体も検証 |
| 型 | `bunx tsc --noEmit`（Bun は型検査をしないため CI で必須） |
