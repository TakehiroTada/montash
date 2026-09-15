# 06. Web プレビューアプリ仕様

`montash serve` が起動するローカル Web アプリ。人間が **確認し、履歴をたどり、素材を管理する** ための UI。

## 1. 役割と制約

### 1.1 原則: Web の操作はすべて CLI コマンドの発行である

要件 P-1「全処理は CLI コマンドで行う」を守るため、Web UI が行う状態変更は **例外なく対応する `montash` コマンドの発行** として実装する。

- ブラウザはサーバに `POST /api/cli { "args": [...] }` を送る。
- サーバは許可リスト（§3.3）に含まれるコマンドのみ、`montash` を `MONTASH_ACTOR=web` で子プロセスとして実行する。
- 結果は CLI の `--json` 出力そのまま。履歴（11 章）には `actor: web` の op として記録される。
- したがって Web からの操作もすべてトレース可能で、`undo` / `checkout` で戻せる。

### 1.2 する／しない

| する | しない |
|------|--------|
| タイムラインのプロキシプレビュー再生・シーク | クリップのドラッグ・トリム等の **タイムライン編集操作**（CLI で行う） |
| トラック／クリップ／トランジション／テキストの可視化 | `project.json` の直接書き込み（常に CLI 経由） |
| **History タイムライン**の表示、クリックで任意時点へ checkout（戻る／進む） | コミットの作成（メッセージを書くのは AI/人間の CLI） |
| **素材（アセット）管理**: 一覧・検索・単体プレビュー・取り込み・削除・ラベル・再リンク・プロキシ再生成・テキスト素材の作成 | 素材ファイル自体の編集（トランスコード等） |
| 選択要素に対する **CLI コマンド例の表示とコピー** | レンダーの開始（CLI で行う。進捗表示のみ） |
| `project.json` 変更の自動反映 | 外部ネットワークへの通信、認証（localhost 前提） |

「Web で見て → 人間が口頭で AI に伝える → AI が CLI を打つ」の往復を最短にすることが目的。UI は **ID と時刻を常に見せる**。

## 2. 画面構成

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ montash · my-vlog   1920x1080 30fps · 00:00:44.500 · 3 clips   HEAD o_42 (k_7 +2 pending) ● │ ← ヘッダー
├───────────────────────────────────────────────┬──────────────────────────────────┤
│                                               │ [Inspector] [Assets] [History]   │ ← 右ペインのタブ
│               プレビュー (video)               │                                  │
│               (proxy timeline.mp4)            │  （選択タブの内容）               │
│                                               │                                  │
├───────────────────────────────────────────────┤                                  │
│ ▶ ❚❚ ⏮ ⏭  00:00:18.233 f:547 / 44.500  [ ] ] │                                  │
│ [────────────●────────────────────────────────]│                                  │
├───────────────────────────────────────────────┤                                  │
│      0s        10s       20s       30s   40s  │                                  │
│ T1   [title]              [福岡到着]           │                                  │
│ V2   |logo──────────────────────────────|      │                                  │
│ V1   |c1=========|t1|c2==========|t2|c3===|    │                                  │
│ A1   |c1a▁▂▃▅▃▂▁|  |c2a▂▃▅▆▅▃▂▁|  |c3a▂▃▂|    │                                  │
│ A2   |~bgm~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~|   │                                  │
├───────────────────────────────────────────────┴──────────────────────────────────┤
│ History ─────────────────────────────────────────────────────────────────────── │
│  k_5 ●━━━━━━━ k_6 ●━━━━━━━━━━━━━ k_7 ●━━━━ ○ ○ ◉(HEAD)                          │ ← 履歴タイムライン
│  「素材取り込み」 「粗編集 3 クリップ」 「00:12〜00:15 カット」  (pending 2)          │   （常時表示・折り畳み可）
│                          └─ ○ ○ (別系列)                                          │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Log: 02:00:01 [ai] clip trim c2 --in +0.5 --ripple · 02:00:03 preview built (3.2s)│
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 ヘッダー
- プロジェクト名、解像度、fps、タイムライン尺、クリップ数。
- **HEAD 状態**: 現在 op、所属コミット、pending op 数、detached なら警告色。クリックで History タブへ。
- 接続状態（WebSocket）、プレビュー状態（`ready / building 45% / stale`）。

### 2.2 プレビューペイン
- `<video>` 要素で `/preview/timeline.mp4` を再生。`stale` のときは半透明バッジで「プレビュー再生成中」を表示し、旧プレビューは再生可能。完了時に再生位置を保って `src` を差し替える。
- キーボード: `Space` 再生/停止、`←/→` 1 フレーム、`Shift+←/→` 1 秒、`J/K/L`、`Home/End`、`I/O` ループ区間（表示のみ）、**`[` / `]` = undo / redo（`POST /api/cli ["undo"]` / `["redo"]`）**。
- 音声のみプレビュー時は波形とタイムコードのみ表示。

### 2.3 トランスポート・シークバー
- 現在時刻を `HH:MM:SS.mmm` と `f:<frame>` の両方で表示。クリックでコピー（**AI に伝えるときは `f:` を推奨**。丸めが起きない）。
- 再生ヘッドのフレームは `<video>.currentTime` から `floor(t * num / den + 1e-6)` で求める。`←/→` は 1 フレーム = `den/num` 秒ずつ `currentTime` を動かす。
- シークバー hover でサムネイル。ループ区間は表示専用（`preview build --from --to` の例を Inspector に出す）。

### 2.4 編集タイムラインビュー
- トラックを上から `T*` → `V*`（配列逆順）→ `A*` の順に表示。クリップに `id`・ラベル・アセット名、音声は波形。
- トランジション・テキスト・ギャップの描画、ミュートは薄く、ズーム／スクロール／再生ヘッド追従。
- クリップクリックで **選択** → Inspector。ダブルクリックで再生ヘッドをクリップ先頭へ。ドラッグ等の編集操作は無い。
- **History 連動**: History ノードを hover すると、その op/commit の `affects.range` を時間軸上に帯でハイライトし、`affects.clips` のクリップを強調する。checkout 直後は変化したクリップを 2 秒間フラッシュ表示。

### 2.5 Inspector タブ
- 選択要素の全プロパティ（整形表示 + 生 JSON トグル）。
- **由来**: その要素を最後に変更した op / commit / actor（`GET /api/blame/:id`）。クリックで History の該当ノードへ。
- **CLI examples**: 選択要素・再生ヘッドに応じたコマンド例（§3.6）。コピー用ボタン。

### 2.6 Assets タブ（素材管理）

プロジェクトの素材（動画・音声・画像・テキスト・字幕）を管理する。

```
┌──────────────────────────────────────────────┐
│ [+ 取り込み] [+ テキスト素材]   🔍 検索        │
│ 種別: [All][Video][Audio][Image][Text][Sub]   │
│ 表示: [グリッド|リスト]  並び: 名前|尺|取込日   │
├──────────────────────────────────────────────┤
│ ▣ clip_a      video 14.2s 3840x2160 29.97    │
│   ▶ proxy ready · 使用: c1 (V1) · タグ: 冒頭   │
│ ▣ clip_b      video 32.0s 1920x1080 30       │
│   ⟳ proxy building 40%                        │
│ ♪ bgm         audio 3:12 stereo 48k          │
│ ▣ logo        image 512x512 alpha            │
│ T title_main  text  "Summer Trip 2026"       │
│ ≡ ja_srt      subtitle srt 120 cues          │
│ ⚠ clip_c      video — ファイルが見つかりません  │
└──────────────────────────────────────────────┘
```

**表示**
- 種別アイコン、ID、ラベル、尺、解像度／fps／ch、プロキシ・サムネ・波形の状態、**使用箇所**（どのクリップ／トラックで使われているか。未使用は「未使用」バッジ）、タグ、欠落（`E_ASSET_MISSING`）警告。
- 選択すると詳細パネル: メタデータ（`probe` 要約）、**単体プレビュー**（動画・音声はプロキシ再生、画像は表示、テキストは本文、字幕は先頭 cue）、サムネイルストリップ、波形。
- 検索（ID・ラベル・タグ・ファイル名）、種別フィルタ、並び替え。

**操作（すべて `POST /api/cli` → CLI 実行、履歴に `actor: web` で記録）**

| UI 操作 | 実行される CLI | 備考 |
|---------|----------------|------|
| 「+ 取り込み」→ パス入力 | `import <path> --proxy --thumbs --waveform` | ローカルサーバなのでパス直接指定が基本。glob 可 |
| 「+ 取り込み」→ ファイルをドロップ／選択 | `POST /api/upload`（`<project>/assets/incoming/` に保存）→ `import <saved path> --proxy --thumbs --waveform` | ブラウザからはパスが取れないため、バイト列をアップロードしてから import。大容量は進捗表示 |
| 「+ テキスト素材」→ ID・本文・（任意）ラベル入力 | `assets new-text <id> --text "<本文>" [--label]` | `assets/text/<id>.txt` を作り `type: text` として登録 |
| テキスト素材の本文編集 | `assets set-text <id> --text "<本文>"` | ファイルを更新。参照するテキストクリップは再レンダー時に反映 |
| ラベル・タグ・色の変更 | `assets set <id> --label <s> --tags a,b --color <hex>` | ID の変更は不可（参照が壊れるため） |
| 削除 | `assets remove <id>`（使用中なら確認ダイアログ → `--force`） | `--force` はダイアログで明示確認後のみ |
| 再リンク（欠落素材） | `assets relink <id> --path <p>` / 「フォルダから探す」→ `assets relink --search <dir>` | |
| プロキシ／サムネ／波形の再生成 | `proxy build <id> --force [--thumbs --waveform]` | |
| 「タイムラインへ追加」 | **実行しない**。`clip add --asset <id> --at <playhead>` のコマンド例を Inspector にコピー | タイムライン編集は CLI の領分（§1.2） |

削除・`--force`・再リンクの一括は確認ダイアログを挟む。

### 2.7 History タブ / History タイムライン（下部常設）

CLI 実行ログをコミットと op の **時系列タイムライン**として描き、クリックで任意の時点へ移動する（11 章）。

**表示**
- 横軸 = 実時刻（操作した時間）。ズーム／スクロール可。`[時系列 | 等間隔]` 切替（等間隔はノードを均等配置）。
- **コミット**は大きなノード（●）とメッセージ 1 行目、作者アイコン（🤖 ai / 👤 human / 🌐 web）。**op** は小さなノード（○）。コミットは展開すると含まれる op を表示。
- **HEAD** は ◉ で強調。HEAD より右（未来側）のノードは「進める」候補として実線、別系列（分岐）は下段に薄く描く。
- **pending ops** は最終コミットの右に点線で描き、「未コミット n 件 — `montash commit -m "..."`」の注記とコマンド例（コピー可）。
- **tag** はノード上のラベル。
- **detached** 状態（HEAD が tip でない）はヘッダーと History に警告帯「過去の状態を表示中 — `montash checkout tip` で最新へ」。

**操作**

| UI 操作 | 実行される CLI |
|---------|----------------|
| ノード（op / commit / tag）をクリック | `checkout <id>` |
| `[` / `]` キー、◀ ▶ ボタン | `undo` / `redo` |
| 「最新へ」ボタン | `checkout tip` |
| ノード右クリック → 「ここにタグ」 | `tag <name> <id>`（名前入力） |
| ノード右クリック → 「このコミットを取り消す（revert）」 | `revert <id> -m "<自動生成>"`（確認ダイアログ） |
| ノード右クリック → 「差分を表示」 | `GET /api/history/diff?a=<id>&b=HEAD` を表示（読み取り） |

**即時性の設計**
- クリック → サーバが `montash checkout` を実行（`project.json` の書き換えのみ、通常 < 50ms）→ WS `project.changed` → 編集タイムライン・Inspector・Assets を即時再描画。
- プレビュー動画は `stale` バッジ → セグメントキャッシュにより多くの場合 1〜3 秒で `ready`（過去に一度生成した状態への移動なら concat のみで < 1 秒）。
- 連続クリック（履歴をスクラブ）時は preview build を最後のクリックから 1.5 秒デバウンス。

**hover 詳細**
- op: コマンド（配列を shell 表記に整形）、actor、時刻、`summary`、`changes` 件数、全長の変化。
- commit: message、body、含まれる op 数、`stats`。
- 同時に編集タイムライン上へ `affects.range` をハイライト（§2.4）。

### 2.8 ログペイン
- op の追記（`[ai] clip trim ...`）、プレビュー／プロキシ／レンダーのイベント、Web 発行コマンドの結果（成功／エラー `hint`）を時系列表示。`render` 中は進捗バー。

## 3. サーバ仕様

### 3.1 起動

```
montash serve [--port 7788] [--host 127.0.0.1] [--open] [--no-watch] [--no-auto-preview] [--daemon] [--read-only] [--allow <cmd,...>] [--deny <cmd,...>]
```

- 既定で `127.0.0.1` のみ。`--host` が loopback 以外のときは起動ログに `W_REMOTE_HOST` を出し、**`--read-only` を強制**する（13 章 A-7。解除手段は設けていない）。
- `--read-only`: `POST /api/cli` と `POST /api/upload` を無効化（405）。閲覧のみの旧動作。
- `--allow/--deny` で許可コマンドを調整（既定は §3.3）。**未実装**（現状は §3.3 の固定リスト。04 章 §1.9）。
- `--dev`: Web UI を Bun の HTML import 開発サーバ（HMR）で配信する。省略時は `web/dist`。
- `--daemon` とその制御（`serve stop|status`）は未実装（04 章 §1.9）。
- 監視対象: `project.json`、`.montash/history/**`、`.montash/preview/**`、`.montash/cache/**`、`.montash/render/progress.json`（chokidar; WSL `/mnt/*` はポーリング）。

### 3.2 HTTP API（読み取り）

| パス | 内容 |
|------|------|
| `GET /api/project` | `project.json` 全体 + 計算値（`duration`, 各クリップの `end`） |
| `GET /api/status` | `{ preview, proxy, render, watching, head: {op, commit, pending, detached, tip} }` |
| `GET /api/history?all=1&since=<id>` | `{ head, ops[], commits[], tags{}, moves[] }`（11 章のモデルそのまま。`since` で差分取得） |
| `GET /api/history/:id` | op / commit / tag の詳細（`show` 相当）。`?patch=1` で差分 — **未実装** |
| `GET /api/history/diff?a=<id>&b=<id>` | `diff` 相当 — **未実装** |
| `GET /api/blame/:elementId` | 要素を最後に変更した op / commit — **未実装**（CLI の `blame` も M4） |
| `GET /api/assets` | アセット一覧 + `usage`（クリップ参照）+ `derived` 状態 |
| `GET /api/assets/:id` | 詳細（probe 要約、usage、テキスト本文） |
| `GET /api/assets/:id/thumbs.json` / `thumbs.jpg` / `waveform.json` / `proxy.mp4`（Range） / `file`（画像・テキスト原本、Range） | 派生物・原本 |
| `GET /preview/timeline.mp4`（Range, `ETag`=project_hash） / `GET /preview/audio.m4a`（`--audio-only` 用） / `GET /preview/timeline.json` | 合成プレビュー。マニフェストに載っていないファイル名・シンボリックリンクは 404 |
| `GET /api/cli-examples?select=<id>&t=<sec>` | コマンド例 — **未実装**（Inspector が `defineCommand` の例をクライアント側で組み立てる） |
| `GET /api/fonts` | `fonts list` 相当 — **未実装** |
| `GET /api/cli/allowlist` | 現在 Web から実行可能なコマンド一覧（UI がボタンの有効／無効に使う） |

### 3.3 HTTP API（書き込み = CLI 実行）

#### `POST /api/cli`

```jsonc
// request
{ "args": ["checkout", "k_0006"], "confirm": false }
// response（CLI の --json 出力そのまま + 実行メタ）
{ "ok": true, "command": "checkout", "result": {...}, "exec": { "args": [...], "actor": "web", "duration_ms": 38, "op": null } }
```

- サーバは `args[0..1]` を **許可リスト** と照合し、一致しなければ 403 `E_WEB_COMMAND_NOT_ALLOWED`。
- `--json --yes` を強制付与し、`MONTASH_ACTOR=web`、`MONTASH_ACTOR_DETAIL=<クライアント識別子(UA+乱数)>` で `montash` を spawn。stdin は閉じる。
- 破壊的フラグ（`--force`, `--overwrite`, `reset --hard`, `revert`）は `confirm: true` が無ければ 409 `E_CONFIRM_REQUIRED` を返し、UI がダイアログを出して再送する。
- 同時実行は直列化（キュー）。タイムアウト 60 秒（`import`/`proxy build` は非同期ジョブとして即時 `job_id` を返し、進捗は WS `job.progress`）。

**既定の許可リスト**

| 分類 | コマンド |
|------|----------|
| 履歴移動 | `checkout`, `undo`, `redo`, `tag`, `tag delete`, `revert`, `reset --hard`（confirm）— `revert` / `reset --hard` は許可リストにあるが CLI 側が未実装（M4） |
| 素材管理 | `import`, `assets set`, `assets set-text`, `assets new-text`, `assets remove`（confirm when `--force`）, `assets relink`, `proxy build` |
| 補助 | `preview build`, `validate` |

**既定で不許可**（CLI で行う）: `clip *`, `track *`, `transition *`, `text *`, `overlay *`, `audio *`, `subtitle *`, `render *`, `commit`, `init`, `project set`, `history prune`, `batch`。

#### `POST /api/upload`（multipart）

- `<project>/assets/incoming/<YYYYMMDD>/<original name>` に保存（同名は連番）。パスをプロジェクトルート配下に限定し、ファイル名をサニタイズ。
- 保存後、自動で `POST /api/cli ["import", <path>, "--proxy", "--thumbs", "--waveform"]` 相当を実行し、結果を返す。
- 上限 **2 GB**（13 章 A-5。`MAX_UPLOAD_BYTES`。`--max-upload` での変更は未実装）。`Content-Length` の申告値と実ファイルサイズの両方で判定し、超過は 413。それ以上の素材はパス指定の `import` を案内する。

### 3.4 WebSocket（`/ws`）

サーバ → クライアントの push のみ。

```jsonc
{ "type": "project.changed", "hash": "sha1:...", "head": "o_0042", "cause": "checkout"|"op"|"external" }
{ "type": "history.appended", "ops": [...], "commits": [...] }       // 差分。UI は再取得せず追記
{ "type": "history.moved",   "from": "o_0042", "to": "o_0033", "actor": "web" }
{ "type": "preview.state",   "state": "building", "progress": 0.45 }
{ "type": "preview.state",   "state": "ready", "hash": "sha1:...", "duration": 44.5 }
{ "type": "proxy.state",     "asset": "clip_a", "state": "ready" }
{ "type": "assets.changed",  "added": ["clip_d"], "removed": [], "updated": ["clip_a"] }
{ "type": "job.progress",    "job_id": "j_12", "kind": "import"|"upload"|"proxy", "percent": 62.1, "message": "..." }
{ "type": "job.done",        "job_id": "j_12", "ok": true, "result": {...} }
{ "type": "render.progress", "percent": 62.1, "eta": 12.3, "output": "out/x.mp4" }
{ "type": "render.done",     "ok": true, "output": {...} }
{ "type": "log",             "level": "info", "actor": "ai", "message": "..." }
```

### 3.5 自動プレビュービルド

- `project.json` 変更をデバウンス（既定 1500ms）後 `preview build`。ビルド中にさらに変更があればキャンセルして再開。
- `cause: checkout` の場合は、その状態の映像セグメントがキャッシュにあれば concat + 音声 1 パス + mux のみ（通常 1〜3 秒。音声関連が不変なら < 1 秒）。

### 3.6 CLI コマンド例の生成ルール（`/api/cli-examples`）

| 選択 | 例 |
|------|----|
| クリップ `c2`、再生ヘッド `t` | `clip split c2 --at f:<n>`（前半は `c2` のまま、後半は新 ID）, `clip trim c2 --in +f:15 --ripple`, `clip trim c2 --out -f:15`, `clip move c2 --by +f:15`, `clip delete c2 --ripple -m "<範囲> を削除"` |
| カット点（c1\|c2 境界） | `transition add --between c1 c2 --type crossfade --duration 0.5` |
| トランジション `t1` | `transition set t1 --duration 1.0`, `transition remove t1` |
| テキスト `x1` | `text set x1 --text "..."`, `text set x1 --position bottom-center` |
| 音声クリップ `c2a` | `audio gain --clip c2a --db -6`, `audio fade --clip c2a --out 1.0` |
| アセット `clip_d`（Assets タブ） | `clip add --asset clip_d --at <t>`, `overlay add --asset logo --track V2 --at <t> --duration 5 --position top-right`, `text add --asset title_main --at <t> --duration 3` |
| pending ops あり | `commit -m "<auto-message 案>"` |
| 何も選択せず再生ヘッド `t` | `clip add --asset <id> --at <t>`, `text add --text "..." --at <t> --duration 3`, `preview build --from <t-5> --to <t+5>` |

## 4. フロントエンド技術（12 章 ADR-06）

**React 19（仮想 DOM）と canvas のハイブリッド**。境界は「時間軸に同期して高頻度に描くか否か」。

| 担当 | 対象 | 理由 |
|------|------|------|
| **React**（TSX） | アプリ構造、ヘッダー、Inspector、Assets タブ（一覧・グリッド・フィルタ・検索・詳細・ダイアログ）、History タブ（詳細・差分・タグ・revert）、ログ、トースト、確認ダイアログ、**タイムラインの枠**（トラック行レイアウト・トラック名・ミュート表示・時間ルーラーの目盛りラベル・スクロールコンテナ）、**History タイムラインの枠**（ズーム切替・凡例・pending 注記） | リスト・フォーム・ダイアログは仮想 DOM の差分更新とフォーカス管理が素直に効く。トラック行の増減・並び替えも差分に任せられる |
| **canvas**（rAF 描画） | 編集タイムラインの **クリップ本体・波形・トランジション・テキスト矩形・ギャップ・再生ヘッド・選択枠・影響範囲ハイライト**、History タイムラインの **ノード・辺・HEAD・分岐** | 再生ヘッドは 60fps、クリップは数百〜数千、波形はピクセル単位。DOM 要素にすると再レンダーとレイアウトがボトルネック。1 フレーム 1 回の描画で `<video>.currentTime` と同期しやすい |

- canvas を保持する React コンポーネント（`TimelineCanvas.tsx`, `HistoryStrip.tsx`）は、ストアの値（playhead 等）を **React の再レンダーを経由せず** rAF ループで直接読んで描く（zustand の `subscribe` / `getState`）。
- ヒットテスト（クリップ矩形・ノード円）は canvas 側で自前実装し、結果（hover / selection）をストアに書く。ツールチップ・コンテキストメニュー・選択要素の枠線ラベルは React が `position: absolute` の DOM で描く。
- 状態管理: **zustand** の単一ストア（`project`, `history`, `assets`, `selection`, `playhead`, `previewState`, `jobs`）。WS の差分メッセージ（`history.appended` 等）でストアを更新。
- ビルド・開発: Bun の HTML import（`Bun.serve({ routes: { "/": index } , development: true })`）で HMR 付き開発。本番は `bun build web/index.html --outdir web/dist --minify` し、成果物をバイナリに埋め込む。Vite は使わない。
- 外部 CDN・フォント不使用（オフライン）。ダーク配色既定。

## 5. 非機能

- `project.json` 変更 → 画面反映 500ms 以内。History ノードクリック → 編集タイムライン更新 300ms 以内（プレビュー再生成は別）。
- 1000 クリップの編集タイムライン、2000 op の History を 60fps でスクロール。
- Web 発行コマンドは直列化し、失敗時は CLI の `error.hint` をそのままトースト表示。
- サーバ停止時は「切断」バッジと自動再接続。

## 6. 手順との対応

| 手順 | Web が担う部分 |
|------|----------------|
| W-02 素材下見 | Assets タブ（一覧・サムネイル・単体プレビュー） |
| W-04 微調整ループ | 再生・シーク・ID／時刻提示・CLI 例のコピー |
| W-05〜W-08 | 効果の見た目・タイミング確認 |
| W-09 書き出し | 進捗表示 |
| W-10 / W-16 | History タイムラインで戻る・進む |
| W-15 | pending 表示とコミット催促（コミット自体は CLI） |
| W-17 | Assets タブでの取り込み・削除・再リンク・テキスト素材作成 |
