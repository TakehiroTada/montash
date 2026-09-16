# 04. CLI コマンド仕様

> この章は最終仕様です。**実装済みの引数は常に `montash schema --json` が正**で、2026-09-15 時点の実装状況は §1.9 の表にまとめてあります。動作例は README「現在実行できる編集」を参照してください。`import --strict` は入力検査に失敗した際に登録を中止します。一部成功の場合はJSONの `result.imported` / `result.failed` と終了コード4を確認してください。

コマンド名は `montash`。すべてのサブコマンドは 03 章の作業手順（W-xx）から導出されたものです。各コマンドの見出しに由来手順を付記します。

## 1. 共通仕様

### 1.1 書式

```
montash [global-options] <command> [<subcommand>] [args] [options]
```

### 1.2 グローバルオプション

| オプション | 既定 | 説明 |
|------------|------|------|
| `--project <dir>`, `-C <dir>` | カレントから上方向に `project.json` を探索 | プロジェクトディレクトリ |
| `--json` | off | 出力を JSON（1 オブジェクト）にする。エラーも JSON |
| `--quiet`, `-q` | off | 人間向け出力を抑制（`--json` と併用可） |
| `--verbose`, `-v` | off | 実行した ffmpeg コマンド等を stderr に出力 |
| `--dry-run` | off | 状態を変更せず、変更内容・実行予定の ffmpeg コマンドを表示 |
| `--yes`, `-y` | off | 確認プロンプトをすべて yes（AI 実行時は基本付与） |
| `--ffmpeg-path <p>` / `--ffprobe-path <p>` | `PATH` から探索 | バイナリの明示指定 |
| `-m <message>`, `--message` | — | 状態変更コマンドで指定すると、その op を即座にコミットする（11 章 §4.2）。`--body <text>` を併用可 |
| `--no-color` | TTY 判定 | 色出力を無効化 |

環境変数 `MONTASH_PROJECT`, `MONTASH_JSON=1`, `MONTASH_FFMPEG`, `MONTASH_FFPROBE`, `MONTASH_ACTOR`, `MONTASH_ACTOR_DETAIL`, `MONTASH_AUTHOR` で同等の指定ができる。

`--no-history` は **提供しない**。すべての状態変更は op として記録される（監査性 N-13）。

### 1.3 時間の表記（入力）

内部はプロジェクト fps 基準の **整数フレーム**（05 章 §2）。入力はすべてフレームに変換して受理する。

| 形式 | 例 | 意味 |
|------|----|------|
| 秒（小数可） | `12.5` | `round(12.5 * num/den)` フレーム |
| タイムコード | `00:00:12.500`, `1:02:03`, `12:30` | 時:分:秒.ミリ秒（省略可）。同様に丸め |
| フレーム | `f:375` | プロジェクト fps 基準のフレーム番号（丸めなし） |
| フレーム数（相対） | `+f:15`, `-f:2` | 現在値からの増減（フレーム） |
| 相対（秒） | `+0.5`, `-2` | 現在値からの増減（秒 → フレームに丸め） |
| 末尾基準 | `end`, `end-3`, `end-f:10` | タイムライン／アセット末尾、末尾から 3 秒／10 フレーム |
| キーワード | `timeline` | タイムライン全長（`--duration` で使用） |
| サンプル（音声補正のみ） | `s:-960` | `audio offset` の `--by` で使うサンプル数 |

- 秒／タイムコード入力がフレーム境界に無い場合は最寄りフレームに丸め、警告 `W_SNAPPED`（`{ input: "12.5", frame: 375, seconds: 12.5125 }`）を返す。AI は以後 `f:375` を使うことで丸めの再発を避けられる。
- 負の値は **`--in=-10` の形式（`=` を挟む）** で渡す。`--in -10` のように数値に見えるものは空白区切りでも解釈できるが、`--in -f:300` / `--out -12:30` は yargs が短縮フラグとして読み `E_USAGE` になる（docs/13 B-11）。この形を検出したときは `E_USAGE` / `E_INVALID_TIME` の `hint` が `=` 形式を案内する。短縮形 `-m` は常にグローバルの `--message`（`--margin` などは長形式のみ。§1.2）。
- 29.97 のような分数 fps では「1 秒」がフレームの整数倍にならない（`30000/1001` では 30 フレーム = 1.001 秒）。相対指定 `+1` は `round(1 * num/den) = 30` フレームになる。

### 1.3a 時間の表記（出力）

JSON 出力の時間フィールドは常に次の 3 つを併記する。

```json
{ "start_f": 375, "start": 12.5125, "start_tc": "00:00:12.513" }
```

`*_f` が正（整数フレーム）、`*`（秒）は `f * den / num`、`*_tc` はミリ秒丸めの `HH:MM:SS.mmm`。`--time-format frames|seconds|tc` で人間向け表示の既定を切り替えられる（JSON は常に 3 つ）。

### 1.4 ID とセレクタ

- ID はコマンドが自動生成する短い文字列。プレフィックス + 連番で種別が分かる: アセットはファイル名由来の slug（`clip_a`）、クリップ `c7`（オーバーレイも映像クリップなので `c*`）、トランジション `t3`、テキスト `x2`、字幕 `s1`、op `o_0042`、コミット `k_0007`、トラック `V1`/`A1`/`T1`。
- 連番カウンタは `.montash/ids.json`（履歴対象外）に置く。`checkout` で過去に戻っても巻き戻らないため、別系列で同じ ID は生まれない（05 章 §2.3、ADR-13）。`montash ids rebuild` で復元。
- `--id <id>` で ID を明示指定できる（冪等な再実行のため）。現在の `project.json` に存在すれば `E_ID_EXISTS`、過去の履歴に存在すれば `W_ID_REUSED`。
- クリップの位置指定セレクタ: `--track V1 --index 2`（1 始まり）、`--at-time 12.3`（その時刻にあるクリップ）。

### 1.5 出力形式

**成功（`--json`）**

```json
{
  "ok": true,
  "command": "clip add",
  "result": { "...コマンド固有..." },
  "changes": [ { "op": "add", "path": "/tracks/V1/clips/2", "id": "c3" } ],
  "warnings": [ { "code": "W_ASSET_MISMATCH", "message": "...", "hint": "..." } ],
  "op": "o_0042",
  "commit": null,
  "head": { "op": "o_0042", "pending": 3, "detached": false },
  "timeline": { "duration_f": 1335, "duration": 44.5445, "duration_tc": "00:00:44.545", "fps": { "num": 30000, "den": 1001 }, "clip_count": 3 }
}
```

`op` は今回の操作で作られた op ID（読み取り系・`--dry-run` は `null`）。`commit` は `-m` 指定時のコミット ID。

**失敗（`--json`、終了コード ≠ 0）**

```json
{
  "ok": false,
  "command": "clip add",
  "error": {
    "code": "E_RANGE_OUT_OF_ASSET",
    "message": "out (f:600 = 20.020s) exceeds asset duration (f:426 = 14.214s) for asset 'clip_a'",
    "hint": "Use --out f:426 (or <= 14.214) or omit --out to use the asset end.",
    "detail": { "asset": "clip_a", "asset_duration_f": 426, "asset_duration": 14.214, "requested_out_f": 600 }
  }
}
```

人間向け出力（既定）は同じ情報を簡潔なテキストで表示する。

### 1.6 終了コード

| コード | 意味 |
|--------|------|
| 0 | 成功（警告があっても 0） |
| 1 | 一般エラー（引数不正、状態不整合） |
| 2 | 使用法エラー（未知のコマンド、必須引数欠落） |
| 3 | 外部依存エラー（ffmpeg 不在／失敗） |
| 4 | I/O エラー（ファイル不在、権限） |
| 5 | 検証エラー（`validate` 失敗、`--strict` 違反） |
| 130 | ユーザー中断（Ctrl-C） |

### 1.7 エラーコード一覧（主要）

| コード | 発生 | hint の内容 |
|--------|------|-------------|
| `E_PROJECT_NOT_FOUND` | `project.json` が見つからない | `montash init` または `-C` |
| `E_PROJECT_EXISTS` | `init` 時に既存 | `--force` |
| `E_FFMPEG_NOT_FOUND` | ffmpeg/ffprobe 不在 | OS 別インストールコマンド |
| `E_FFMPEG_FEATURE_MISSING` | libfreetype 等が無いビルド | 代替ビルドの案内 |
| `E_FFMPEG_FAILED` | ffmpeg が非 0 終了 | stderr 末尾 20 行を `detail.stderr_tail` に |
| `E_ASSET_NOT_FOUND` | ID 不一致 | 類似 ID 候補 |
| `E_ASSET_MISSING` | パス先にファイルが無い | `assets relink` |
| `E_ASSET_UNREADABLE` | ffprobe 失敗 | — |
| `E_CLIP_NOT_FOUND` / `E_TRACK_NOT_FOUND` | ID 不一致 | 候補 |
| `E_RANGE_OUT_OF_ASSET` | in/out がアセット尺外 | 許容範囲 |
| `E_CLIP_OVERLAP` | 同トラックで重なり | `--on-overlap` |
| `E_TRIM_EXCEEDS_CLIP` | トリム量 > クリップ尺 | 最大トリム量 |
| `E_INSUFFICIENT_HANDLE` | トランジション余白不足 | 最大 duration、`--mode overlap` |
| `E_FONT_NOT_FOUND` | フォント不在 | 類似フォント |
| `E_OUTPUT_EXISTS` | 出力先が既存 | `--overwrite` |
| `E_PATH_OUTSIDE_PROJECT` | プロジェクト外パス | `--allow-outside` |
| `E_INVALID_TIME` | 時間表記の解釈失敗 | 受理形式一覧 |
| `E_NOTHING_TO_UNDO` / `E_NOTHING_TO_REDO` | 履歴端 | — |
| `E_NOTHING_TO_COMMIT` | pending op 無し | `--allow-empty` |
| `E_PLUGIN_MISSING` | クリップが未知の種別を持ち、供給するプラグインが無い。**読み込み・保存は通り、レンダー時のみ**（docs/05 §6.1a） | 該当プラグインの導入、または `clip delete` |
| `E_EFFECT_NOT_FOUND` | そのクリップに指定の効果が掛かっていない | 掛かっている効果の一覧 |
| `E_PLUGIN_INVALID` | マニフェストや エントリの形が不正 | 必要なキー、エントリの置き場所 |
| `E_PLUGIN_INCOMPATIBLE` | プラグインが要求する API バージョンをホストが支えない | 受理できるバージョン範囲 |
| `E_PLUGIN_LOAD_FAILED` | プラグインの読み込み・登録中に例外 | どのプラグインか |
| `E_PLUGIN_EXISTS` / `E_PLUGIN_NOT_FOUND` | 導入済み／未導入 | `--force`、`plugin list` |
| `E_PLUGIN_CAPABILITY_REQUIRED` | 宣言していない能力（`analyze` など）を使おうとした | マニフェストに足すべき `capabilities` |
| `E_PLUGIN_COMMAND_CONFLICT` | プラグインが組み込みコマンド（または他のプラグインが取ったパス）を名乗ろうとした | どのプラグインがどのパスを取ろうとしたか |
| `E_SCHEMA_TOO_OLD` | `project.json` の `schema_version` が古い。v1.0 前なので移行は提供しない | `montash init` で作り直す |
| `E_HISTORY_REF_NOT_FOUND` | op/commit/tag が無い | 類似 ID 候補 |
| `E_TAG_EXISTS` / `E_TAG_NOT_FOUND` | タグ名 | — |
| `E_REVERT_CONFLICT` | 逆差分の対象が既に無い | 対象一覧、`checkout` の提案 |
| `E_DIRTY_WORKTREE` | `project.json` が HEAD と一致しない（手編集） | `commit --from-worktree -m` または `checkout HEAD` |
| `E_WEB_COMMAND_NOT_ALLOWED` | Web から不許可コマンド | CLI で実行 |
| `E_CONFIRM_REQUIRED` | Web から破壊的操作を確認無しで | `confirm: true` |
| `E_UPLOAD_TOO_LARGE` | アップロード上限超過 | パス指定 import |
| `E_ASSET_TYPE_MISMATCH` | `text add --asset` に非テキスト素材等 | — |
| `E_ID_EXISTS` | `--id` が既存 ID と衝突 | 別 ID |
| `E_TRACK_LOCKED` | ロック中トラックへの編集 | `track unlock` |
| `E_SPLIT_AT_EDGE` | 分割位置がクリップ端 | trim / delete |
| `E_BATCH_PARSE` | `batch` の行が JSON Lines としても bash 行としても読めない | 受理形式（`detail.line` に行番号） |
| `E_BATCH_EMPTY` | `batch` の入力に実行できる行が無い | 1 行 1 コマンドの書き方 |
| `E_BATCH_UNSUPPORTED` | バッチの中で実行できないコマンド（`batch`/`serve`/`init`、`--atomic` では `checkout`/`undo`/`redo`/`revert`/`reset`/`commit` など HEAD を動かすもの） | バッチの外で実行する、または `--continue-on-error` |
| `E_TRANSCRIBER_NOT_FOUND` | `subtitle generate` の書き起こしエンジンが無い（montash は取得しない） | 導入方法（`brew install whisper-cpp` 等）、`--engine-path` / `MONTASH_TRANSCRIBER` |
| `E_TRANSCRIBER_MODEL_NOT_FOUND` | モデル（`*.bin`）が無い | 置き場（`~/.local/share/montash/whisper/`）、`--model` / `MONTASH_TRANSCRIBER_MODEL` |
| `E_TRANSCRIBER_FAILED` | エンジンが非 0 終了 / JSON を書かなかった | `detail.stderr_tail`（モデルとビルドの不一致が多い） |
| `E_TRANSCRIBER_TIMEOUT` / `E_TRANSCRIBER_CANCELLED` | `--timeout` 超過 / 中断 | 小さいモデル、`--asset` で範囲を絞る |
| `E_TRANSCRIPT_EMPTY` | 音声から 1 つも字幕が作れなかった | `--lang` の確認、音声の有無（`audio show`） |
| `E_TRANSCRIPT_NOT_FOUND` | `--from-transcript` の書き起こしが無い | `subtitle generate --save-transcript <path>` で作る |
| `E_TRANSCRIPT_INVALID` | `--from-transcript` が montash の書き起こしとして読めない | `detail.problem`、`--save-transcript` が書いた形 |
| `E_REPLACE_FILE_NOT_FOUND` | `--replace-file` が無い | 1 行 1 規則（`誤=正`）の書き方 |
| `E_BATCH_FAILED` | `--atomic` のバッチが途中で失敗（開始前へ巻き戻し済み） | 失敗した行の hint、`detail.lines` に各行の結果 |

警告は `W_` プレフィックス（`W_ASSET_MISMATCH`, `W_BEYOND_TIMELINE`, `W_CLIP_SHORTER_THAN_REQUESTED`, `W_GAP_CREATED`, `W_LEAVING_PENDING`, `W_MULTIPLE_CHILDREN`, `W_DETACHED_HEAD`, `W_COMMIT_MESSAGE_STYLE`, `W_DIRTY_WORKTREE`, `W_SNAPPED`（時間入力をフレームに丸めた）, `W_FPS_RESNAPPED`（fps 変更で全時間を再スナップ）, `W_RESOLUTION_RESCALED`, `W_TEXT_ENGINE_LIMITED`（libass 無しで drawtext フォールバック）, `W_TEXT_FIT_CLAMPED`（`--fit-width` が下限サイズでも指定幅に収まらなかった）, `W_TEXT_FIT_ESTIMATED`（`--measure` で測れず概算に落ちた行がある）, `W_ID_REUSED`, `W_RIPPLE_SPAN_NOT_EXTENDED`（リップル挿入で跨ぎクリップを伸ばせなかった）, `W_TRANSITION_REMOVED`（編集点を跨ぐトランジションを削除）, `W_FFMPEG_BEST_EFFORT`（ffmpeg 6.0 未満）, `W_BATCH_MESSAGE_IGNORED`（`--atomic` のバッチの行に付いた `-m` は無視した）, `W_REPLACE_UNUSED`（`--replace` の規則が 1 度も当たらなかった））。

### 1.8 履歴への記録

状態を変更するコマンドは、実行前後のスナップショット（内容ハッシュ）・コマンド引数・actor・差分・影響範囲を **op** として `.montash/history/ops.jsonl` に追記する（11 章）。`--dry-run` と読み取り系コマンドは記録しない。`checkout`/`undo`/`redo` は op を作らず `moves.jsonl` に移動を記録する。

### 1.9 実装状況（2026-09-15 / M4 進行中）

本章は最終仕様なので、まだ実装されていないコマンド・オプションを含む。`montash schema --json` の出力との差分は以下のとおり（実機で確認した値）。

**未実装のコマンド**

| コマンド | 章 | 予定 |
|----------|----|------|
| `clip show` | §6 | `clip list --json` で代替中 |
| `clip link` / `clip unlink` | §11 | `clip move/trim/split/set --unlink` は実装済み |
| `snapshot save|restore|list|delete` | §15 | `tag` / `checkout` を使う。互換別名は後回し |
| `serve stop` / `serve status` | §13 | `--daemon` 自体は実装済み |

**M4 で実装済みになったもの**（旧「未実装」から移動）: `render batch` / `render still` / `render gif` / `render audio`、`blame` / `revert` / `reset --hard`、`history prune|export|import`、`help`（docs/13 D-11）、`batch`（§16）。

**未実装のオプション**

| コマンド | 未実装のオプション | 備考 |
|----------|--------------------|------|
| `import` | `--thumbs`, `--waveform` | `proxy build --thumbs/--waveform` は実装済み |
| `assets show` | `--keyframes` | `--probe` は実装済み |
| `clip add` | `--loop` | `--ripple` と `--on-overlap overwrite|push` は実装済み（docs/13 D-9）。意味論は `clip move` と同じ |
| `render` | `--from`, `--to`, `--skip-validate` | 区間レンダーは `render gif --from/--to` で可能。それ以外（`--last` `--vcodec` `--acodec` `--vbitrate` `--abitrate` `--pix-fmt` `--fps` `--two-pass` `--hwaccel` `--reframe`）は**すべて実装済み**、プリセットは 10 種 |
| `log` | `--since` | |
| `commit` | `--body-file`, `--amend`, `--from-worktree` | `-m` / `--body` / `--last` / `--ops` / `--tag` / `--author` / `--allow-empty` / `--auto-message` は実装済み |
| `project set` | `fps` / `resolution` キー | それ以外のキーは実装済み |

レンダーで **グラフが対応していない構成**（`E_UNSUPPORTED`）: クリップの `loop`、クリップエフェクト、3D LUT、3ch 以上の音声、テキストトラック上のジェネレータクリップ。

未実装の機能を呼ぶと `E_NOT_IMPLEMENTED`（終了コード 6）またはオプション未知のエラーになる。

> この表は実装が進むたびにずれる。`montash schema --json` が常に正なので、食い違いを見つけたら docs/13 に起票して直すこと。

---

## 2. 環境・メタ

### `montash doctor` — W-01

環境診断。

```
montash doctor [--json] [--fix-hints]
```

出力: `ffmpeg`/`ffprobe` のパスとバージョン、**機能検出の結果**（ADR-15。必須: `libx264` `aac` `xfade` `concat` `overlay` `loudnorm` `sidechaincompress`／推奨: `subtitles`（libass） `drawtext`／任意: `libx265` HW エンコーダ）、テキストエンジン判定（`libass` / `drawtext` フォールバック）、Bun バージョン、OS/WSL 判定、既定フォントディレクトリと CJK フォントの有無、ファイル監視モード（chokidar / poll）。

- ffmpeg の可否は **バージョンではなく必須機能の有無**で判定する。4.4 未満は `E_FFMPEG_OUTDATED`、6.0 未満は `W_FFMPEG_BEST_EFFORT`、必須機能欠落は `E_FFMPEG_FEATURE_MISSING`（欠落一覧と `hint`: `bash scripts/install-deps.sh --static`）。
- バイナリの探索順: `--ffmpeg-path` / `MONTASH_FFMPEG` → `~/.local/share/montash/ffmpeg/bin`（`install-deps.sh` が static ビルド／Homebrew `ffmpeg-full` をここに置く。montash 管理の ffmpeg を最優先）→ `PATH` → Homebrew keg-only の `ffmpeg-full`（`/opt/homebrew/opt/ffmpeg-full/bin` 等）。
- 不足項目には `hint`（例: `bash scripts/install-deps.sh --with-fonts`）。`--fix-hints` は `scripts/install-deps.sh --check --json` を実行して結果を統合する。

### `montash schema` — AI 支援

```
montash schema [<command>] [--format json|openai-tools|anthropic-tools]
```

全コマンド（または指定コマンド）の引数定義・型・説明・例を JSON で出力。`--format *-tools` は LLM の関数呼び出し定義形式で出力。

### `montash help [<command>...] [--json]`

```
montash help                    # グループごとの全コマンド一覧
montash help clip               # clip 配下の一覧
montash help clip add           # 1 コマンドの詳細
montash help clip add --json    # schema と同じ JSON
```

`schema` と同じ定義（`defineCommand`）を人間向けに整形する。`--json` の出力は `montash schema <command> --json` と同一。
yargs の `--help` と違い、次の 3 点を出す。

- **状態を変えるコマンドか**（`changes the project (recorded as an op...)` / `read-only`）
- **由来する作業手順**（`workflow: W-03`）
- **時間表記を受け取るオプション**（`--in <time>`）

逆に全コマンド共通のグローバルオプションは並べず 1 行の案内に留める（`--help` で見られるため）。

---

## 3. プロジェクト

### `montash init <name|.>` — W-01

```
montash init <dir> [--name <str>] [--fps 30] [--resolution 1920x1080] [--sample-rate 48000] [--channels 2]
                 [--template <name>] [--force]
```

- `<dir>` を作成（`.` でカレント）し `project.json`、`.montash/`、`.gitignore`（`.montash/cache` 等を除外）を生成。
- 既定トラック: `V1`（video）、`A1`（audio）。
- **fps と解像度はプロジェクトの基準単位**（05 章 §2）。fps は `24 | 25 | 30 | 50 | 60 | 23.976 | 29.97 | 59.94` のプリセット、または `30000/1001` の分数を受理し、有理数 `{num, den}` で保存する。解像度は偶数 px（`1920x1080`, `1080x1920`, `3840x2160` ...）。
- 省略時の既定は `--fps 30 --resolution 1920x1080 --sample-rate 48000 --channels 2`。`--template <name>` で `youtube-1080p30 | youtube-4k30 | reel-1080x1920-30 | cinema-24 | broadcast-2997` 等を選べる。

### `montash project show [--json]` — W-01

設定（fps は `{num, den}` と表示用 `29.97`、1 フレームの秒数）・アセット数・トラック数・タイムライン尺（`_f` / 秒 / tc）・最終更新・履歴件数を表示。

### `montash project set <key> <value> [--dry-run]`

`fps` / `resolution` / `sample_rate` / `channels` / `name` / `default_font` / `text_engine` を変更。

- `fps`: すべての `_f` フィールド（クリップ・トランジション・テキスト・フェード・プリセット）を `round(f * num' * den / (den' * num))` で再スナップし、アセットの `duration_f` を再計算。丸めが生じた項目を `changes` に列挙し `W_FPS_RESNAPPED`。1 つの op として記録（undo 可）。`--dry-run` で影響一覧だけ確認できる。
- `resolution`: px 指定の位置・サイズ・文字サイズ・余白を比率で再計算（x/幅は横比、y/高さ/文字サイズは縦比）。`%`／プリセット指定は不変。`W_RESOLUTION_RESCALED`。
- `sample_rate`: `offset_smp` を `round(smp * sr' / sr)` で再計算。
- 変更後は `preview` が `stale` になり、プロキシは fps 変更時のみ `stale`（プロジェクト fps で生成しているため）。

### `montash validate [--deep] [--strict] [--json]` — W-03, W-09, W-13

| チェック | レベル |
|----------|--------|
| アセットファイル存在 | error |
| すべての時間フィールドが整数（`_f` / `_smp`） | error |
| クリップ in/out がアセット尺内（`out_f <= asset.duration_f`） | error |
| 同トラック内クリップ重なり（整数区間の比較） | error |
| トランジションのハンドル充足 | error |
| 参照 ID の存在 | error |
| フォント存在（`--deep`: ffmpeg でダミー描画） | error |
| ギャップ（無素材区間） | warning（`--strict` で error） |
| fps／解像度不一致 | warning（`--strict` で error） |
| タイムライン尺を超えるテキスト等 | warning |
| `--deep`: 各アセットの先頭 1 秒を ffmpeg でデコードして読めるか確認 | error |

出力は `{ ok, errors: [...], warnings: [...] }`。error があれば終了コード 5。

### `montash diff [<a>] [<b>] [--json]` — W-11

現在の `project.json` と指定時点の差分を JSON Patch 形式と人間向け要約で表示。

---

## 4. アセット

### `montash import <path...>` — W-02, W-14

```
montash import <path...> [--id <id>] [--proxy] [--thumbs] [--waveform] [--copy] [--strict]
# 実装済み: --id / --proxy / --copy / --strict（--thumbs / --waveform は未実装。proxy build を使う）
```

- glob 展開は bash に任せる。ディレクトリ指定時は再帰で対応拡張子（mp4 mov mkv webm avi mts m2ts mp3 wav aac flac m4a png jpg jpeg webp srt ass vtt txt md）を取り込む。
- ffprobe（`-show_streams -show_format -of json`）を実行し `probe` に保存。種別を判定（video / audio / image / subtitle / **text**）。`.txt`/`.md` は UTF-8 として読み、`type: text` で登録（ffprobe は実行しない）。
- `--proxy` で派生物をその場で生成（無ければ `proxy build` で後から）。`--thumbs` / `--waveform` は未実装で、`proxy build --thumbs --waveform` を使う（§1.9）。
- `--copy` でプロジェクト内 `assets/` にコピー（既定は絶対パス参照）。
- 複数指定時は 1 件失敗しても続行し、結果に `failed: [...]` を含める（終了コードは 4）。
- ID は拡張子を除いたファイル名の slug（`clip_a`）。衝突時は `_2`, `_3`。

### `montash assets list [--type video|audio|image|subtitle|text] [--tag <t>] [--unused] [--missing] [--search <str>] [--json]` — W-02, W-17

ID、種別、ラベル、タグ、パス、尺、解像度、fps、音声 ch、プロキシ状態、使用クリップ数（`usage`）。

### `montash assets show <id> [--json]` — W-02, W-17

要約メタデータ、`--probe` で生 JSON（`.montash/cache/<id>/probe.json` から。無ければ ffprobe を再実行して再生成）、キーフレーム間隔（`--keyframes` でスキャン。未実装）、使用箇所一覧（クリップ ID・トラック・区間）、テキスト素材は本文、最後に変更した op（`blame`）。

### `montash assets set <id> [--label <s>] [--tags a,b] [--add-tag <t>] [--remove-tag <t>] [--color <hex>] [--note <s>]` — W-17

表示用メタデータの変更。ID の変更は不可（参照が壊れるため）。

### `montash assets new-text <id> --text <str> | --text-file <path> [--label <s>] [--tags ...]` — W-17

`assets/text/<id>.txt` を UTF-8 で作成し `type: text` のアセットとして登録。テロップの定型文・タイトル案などの再利用素材。`text add --asset <id>` で参照する（本文は参照時にコピーされず、レンダー時に読む。素材を更新すると全参照に反映）。

### `montash assets set-text <id> --text <str> | --text-file <path>` — W-17

テキスト素材の本文を更新（ファイルを書き換える。元素材非破壊の原則の **唯一の例外** で、プロジェクトが生成・所有する `assets/text/` 配下のファイルのみ対象。`import` した外部 `.txt` は `E_ASSET_NOT_OWNED` で拒否し、`--copy` 取り込みを案内）。

### `montash assets remove <id> [--force]` — W-17

使用中なら `E_ASSET_IN_USE` と参照クリップ一覧（`--force` で参照クリップも削除。跨っているトランジション・リンククリップも削除し警告）。

### `montash assets relink [<id>] (--path <p> | --search <dir>) [--match name|size|hash]` — W-13

`--search` はファイル名一致→サイズ一致→（`--match hash`）先頭 1MB ハッシュ一致で照合し、一括更新。結果に `relinked`/`unresolved` を返す。

名前の照合は両辺を **NFC に正規化**してから行う（macOS は NFD、Linux は NFC でファイル名を返すため。docs/13 A-12）。`assets list --search` の部分一致も同じく NFC で揃える。

### `montash proxy build [--all | <id...>] [--force] [--height 360] [--parallel 2] [--thumbs] [--waveform]` — W-02

プロキシ（H.264 baseline、指定高さ、CRF 28、AAC 96k、キーフレーム 1 秒）、サムネイル（`--thumbs`、既定 1 枚/秒、160px 幅、スプライト JPEG + JSON インデックス）、波形（`--waveform`、`astats`/`ebur128` ではなく PCM ダウンサンプルからピーク配列、100 点/秒）を `.montash/cache/<asset_id>/` に生成。

### `montash proxy status [--json]`

各アセットの `proxy: ready|building|missing|stale`（元ファイル mtime／サイズ変化で stale 判定）。

### `montash fonts list [--filter <str>] [--json]` — W-06

`fc-list`（あれば）と OS 標準ディレクトリ走査で、ファミリー名・スタイル・ファイルパスを列挙。CJK 対応かのフラグを付与（`charset` に日本語コードポイントを含むか）。

---

## 5. トラック

### `montash track add --kind video|audio|text [--name V2] [--above <track>|--below <track>]` — W-07, W-08

名前省略時は種別ごとの連番。映像トラックは配列で後ろが上（合成順）。

### `montash track list [--json]` / `montash track remove <name> [--force]` / `montash track mute <name> [--off]` / `montash track lock <name> [--off]` / `montash track move <name> (--above|--below) <track>` — W-08

`remove` はクリップがある場合 `--force` 必須。`mute` は映像なら非表示、音声なら無音としてレンダー・プレビューから除外。`lock` したトラックは編集コマンドを拒否し（`E_TRACK_LOCKED`）、**全トラックリップルの対象からも外れる**（§6a）。

---

## 6. クリップ

### 6a. リップルの意味（ADR-16）

`--ripple` を伴う操作（`trim` / `delete` / `move` / `split` 後の詰め、`add --on-overlap push` の押し出し）は、**既定で全トラックに及ぶ**。

```
--ripple            = --ripple=all   全トラック（既定）
--ripple=track                       当該トラックのみ
（フラグ無し）                        リップルしない（ギャップが残る / 重なりはエラー）
```

編集点 `p_f` と変化量 `delta_f`（削除・短縮は負、挿入・延長は正）に対して:

| 対象 | 規則 |
|------|------|
| `start_f >= p_f` の要素（全トラックのクリップ・テキスト・字幕・トランジション） | `start_f += delta_f` |
| `start_f < p_f < end_f` で編集点を跨ぐ要素 | 削除（`delta_f < 0`）: `duration_f -= |delta_f|`（`out_f` を縮める。BGM は末尾が短くなる）。挿入（`delta_f > 0`）: アセットに余白があるか `loop` なら `out_f` を伸ばす、無ければ伸ばさず `W_RIPPLE_SPAN_NOT_EXTENDED`（そのトラックにギャップ） |
| 編集点を跨ぐトランジション | 削除して `W_TRANSITION_REMOVED` |
| `locked: true` のトラック | 対象外（動かない） |
| `--ripple=track` | 上記を当該トラック（とリンク先の音声トラック）のみに適用 |

結果 JSON の `changes` にはリップルで動いた全要素を含め、`affects.range_f` は `[p_f, 旧タイムライン末尾]` とする。

### `montash clip add` — W-03, W-07

```
montash clip add --asset <id> [--track V1] [--in <t>] [--out <t>] [--duration <t>]
               (--at <t> | --at end | --after <clip> | --before <clip>)
               [--on-overlap error|overwrite|push] [--ripple[=all|track]]
               [--video-only|--audio-only] [--loop] [--id <id>] [--label <str>]
```

`--loop` は未実装（§1.9）。

- `--in/--out` 省略時はアセット全体（`out_f = asset.duration_f`）。負値は末尾基準（`--in=-10` = 末尾 10 秒、`--in=-f:300` = 末尾 300 フレーム）。`--duration` は `--out` の代替。画像アセットは `--duration` 必須（省略時 `settings.default_image_duration_f`）。
- in/out はアセットの native fps ではなく **プロジェクト fps のフレーム**で指定する（アセットが 29.97fps でプロジェクトが 30fps なら、`f:30` は 1.0 秒地点）。
- 既定では映像アセットの映像を `--track`、音声を対応する音声トラック（`V1`→`A1`）に **リンククリップ** として同時配置する。`--video-only` / `--audio-only` で片方のみ。
- `--at end` はトラック末尾に隙間なく追加。`--after <clip>` はそのクリップ直後。
- `--loop` は `--duration` がアセット尺より長い場合に繰り返す（音声 BGM 用）。無ければ `W_CLIP_SHORTER_THAN_REQUESTED`。
- `--on-overlap push` は追加位置以降を追加尺ぶん後ろへずらす（リップル挿入。§6a の規則で **全トラック**。`--ripple=track` を併用すると当該トラック（とリンク先の音声トラック）のみ）。`overwrite` は重なった部分を既存クリップから削る。`error`（既定）は重なれば `E_CLIP_OVERLAP` で何も書かない。
- `--ripple` だけを付けた場合も挿入になる（`clip move --ripple` が移動先で後続を押し出すのと同じ。§6a）。`--before <clip>` と併用すると、そのクリップの位置に差し込んで以降を押し出す。
- 押し出し・上書きで動いた（消えた）クリップは結果の `moved_clips` に入る。ロックされたトラックは対象外（`E_TRACK_LOCKED`）。

結果: `{ clip: {...}, linked_clip: {...}|null, moved_clips: [<id>...] }`。

### `montash clip list [--track <t>] [--asset <id>] [--json]` — W-04

トラック順・時間順に `index`, `id`, `asset`, `start`, `end`, `in`, `out`, `duration`, `linked`, `label` を返す。

### `montash clip show <id> [--json]` — 未実装（§1.9）

クリップの全属性と適用エフェクト、前後のクリップ、隣接トランジション。

### `montash clip move <id> (--to <t> | --by <±t> | --before <clip> | --after <clip> | --track <t>) [--ripple[=all|track]] [--on-overlap ...] [--unlink]` — W-04

- 既定でリンククリップも同時に動く（`--unlink` で単独）。
- `--ripple`: 移動元の空きを詰め（§6a の削除規則）、移動先で後続を押し出す（挿入規則）。順序入れ替えの主用途。

### `montash clip trim <id> [--in <±t|t>] [--out <±t|t>] [--start <t>] [--ripple[=all|track]] [--unlink]` — W-04

- `--in +0.5`: ソース in を 0.5 秒後ろへ（頭を切る）。`--in 3.0` は絶対値。
- `--out -1`: 尻を 1 秒切る。
- `--ripple` 無し: `start_f` は固定、頭を切ると尺が縮み後ろにギャップ（`W_GAP_CREATED`）。有り: 編集点以降を全トラックで詰める（§6a）。
- 尺が 1 フレーム未満になる場合 `E_TRIM_EXCEEDS_CLIP`。

### `montash clip split <id> --at <t> [--unlink] [--new-id <id>]` — W-04

タイムライン時刻 `t`（フレーム境界に丸め）で 2 分割。**前半は元の ID を維持**し（`in_f` はそのまま、`out_f` を `t` に対応する位置へ縮める）、後半だけ新規採番（`--new-id` で明示可）。リンク音声も同様に分割し、前半同士・後半同士のリンクを維持する。跨っているトランジション・フェードは前半／後半に振り分ける（末尾フェードは後半へ）。

結果:

```json
{ "kept": { "id": "c2", "start_f": 375, "end_f": 600 }, "created": { "id": "c7", "start_f": 600, "end_f": 975 },
  "linked": { "kept": "c2a", "created": "c7a" } }
```

`t` がクリップの端（先頭または末尾）に一致する場合は `E_SPLIT_AT_EDGE`（分割の意味がない）。

### `montash clip delete <id...> [--ripple[=all|track]] [--unlink]` — W-04

`--ripple` で削除区間以降を全トラックで詰める（§6a。BGM など区間を跨ぐクリップは尺が縮む）。跨っているトランジションは削除し `W_TRANSITION_REMOVED`。

### `montash clip set <id> [--speed 1.5] [--pitch-keep] [--label <s>] [--volume <db>] [--opacity 0..1] [--ripple[=all|track]] [--unlink]`

速度変更（`setpts`/`atempo`）ほか単純プロパティ。速度変更で尺が変わる場合は `--ripple` に従う。

---

## 7. タイムライン

### `montash timeline show [--from <t>] [--to <t>] [--json] [--ascii]` — W-03, W-04

全トラックのクリップ、トランジション、テキスト、オーバーレイを時間順に。`--ascii` で簡易タイムライン図を描く:

```
      0s        10s       20s       30s       40s
V2    |---logo----------------------------------------|
V1    |==c1========|xx|==c2=========|xx|==c3==========|
A1    |==c1========|  |==c2=========|  |==c3==========|
A2    |~~bgm~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\|
T1         [title]                 [lower3rd]
```

### `montash timeline gaps [--track <t>] [--fill black|hold|close]`

ギャップを列挙。`--fill close` で詰める、`black` で黒クリップ挿入、`hold` で直前フレーム保持クリップ挿入。

---

## 8. トランジション・フェード

### `montash transition add` — W-05

```
montash transition add (--between <clipA> <clipB> | --track <t> --all-cuts | --at-cut <t>)
                     --type <name> --duration <t> [--mode handle|overlap] [--audio crossfade|cut] [--id <id>]
```

- `--type`: `crossfade`(=`fade`), `dissolve`, `fadeblack`, `fadewhite`, `wipeleft|wiperight|wipeup|wipedown`, `slideleft|...`, `circleopen|circleclose`, `pixelize`, `radial` …（ffmpeg `xfade` の transition 名をそのまま受理）。
- `--duration` はフレームに丸めて `duration_f` として保存（`0.5` @29.97 → `f:15`、`W_SNAPPED`）。最小 2 フレーム。
- `--mode handle`（既定）: 先行クリップの `out_f` を `ceil(d_f/2)`、後続の `in_f` を `d_f - ceil(d_f/2)` だけ広げて重ねる。タイムライン全長は変わらない。余白不足で `E_INSUFFICIENT_HANDLE`（`detail.max_duration_f`）。
- `--mode overlap`: B を duration ぶん前へずらして重ねる。全長が縮む（後続はリップル）。
- `--audio crossfade`（既定）: リンク音声に `acrossfade` を適用。

### `montash transition set <id> [--type] [--duration] [--mode] [--audio]` / `remove <id>` / `list [--track <t>] [--json]`

### `montash fade [--track <t>|--clip <id>] [--in <t>] [--out <t>] [--color black|white] [--with-audio]` — W-05

タイムライン（またはクリップ）の先頭／末尾フェード。

---

## 9. テキスト（テロップ）

### `montash text add` — W-06

```
montash text add (--text <str> | --text-file <path> | --asset <text-asset-id>) --at <t> (--duration <t> | --until <t>) [--track T1]
               [--preset <name>] [--font <family>] [--size <px>] [--color <hex[aa]>] [--bg <hex[aa]|none>] [--bg-padding <px>]
               [--position <preset|x,y|x%,y%>] [--align left|center|right] [--line-spacing <px>] [--wrap|--no-wrap]
               [--fit-width <pct|px>] [--max-size <px>] [--min-size <px>] [--measure]
               [--fade-in <t>] [--fade-out <t>] [--shadow <x,y,color>] [--outline <px,color>] [--bold] [--italic]
               [--markup plain|ass] [--id <id>]
```

- 描画エンジンは **libass**（ASS を生成して `subtitles` フィルタで焼く。07 章 §6）。`doctor` が libass 無しと判定した環境では `drawtext` にフォールバックし、`--wrap`/`--bg-padding`/`--markup ass` は無効（`W_TEXT_ENGINE_LIMITED`）。
- `--position` プリセット: `center`, `top-center`, `bottom-center`, `top-left`, `top-right`, `bottom-left`, `bottom-right`（ASS の `\an` に対応）。座標は px（プロジェクト解像度基準）または %。
- `--size` 等の px はプロジェクト解像度（`PlayResY`）基準。解像度変更時は比率で再計算される（`project set resolution`）。
- `--markup ass` で本文中の ASS オーバーライドタグ（`{\b1}強調{\b0}`、`{\c&H00FFFF&}` 等）をそのまま通す。既定 `plain` は `{ } \` をエスケープ。
- `--line-spacing` は `style.line_spacing` に保存されるが、**現状 ASS には反映されない**（ASS の Style に行間の指定が無く、`Spacing` は字間のため。libass の制約）。将来、行ごとの Dialogue 分割で対応する可能性がある。
- `--fade-in/--fade-out` はフレームに丸めて保存（`fade.in_f`）。

**`--fit-width`（幅の自動フィット）**

`--size` が「決め打ちのサイズ」なのに対し、`--fit-width` は「**この幅に収まる最大のサイズ**」を頼む。切り抜き動画のテロップのように、短い一言は大きく・長い一言は小さくして**常に 1 行で画面幅いっぱい**にしたいときに使う（一言ごとに人や AI が文字数からサイズを逆算せずに済む）。

```
montash text add --text "まじで神ゲーになった" --at 30 --duration 2.5 --position bottom-center --fit-width 92%
```

- `--fit-width <pct|px>`: 収めたい幅。`92%` はプロジェクト解像度の横幅に対する割合、`1152` は px。
- `--max-size <px>`: 上限。既定は**同じコマンドで `--size` か `--preset` を渡していればそのサイズ**、無ければ画面高の 10%（1080p で 108px）。`text set --fit-width` を繰り返しても前回の結果が上限にならないので、縮み続けることはない。
- `--min-size <px>`: 下限。既定は画面高の 4%（1080p で 43px）。下限でも収まらないときは下限のサイズで置き、`W_TEXT_FIT_CLAMPED` で知らせる（黙って溢れさせない）。
- `--measure`: 幅を **libass に実際に描かせて測る**（`ffmpeg` を 1 パス、1 行につき 1 回だけ余分に回す）。既定は外部プロセスを使わない概算。
- 複数行（`\n`）のときは**いちばん幅の要る行**が全体のサイズを決める。
- `--wrap` / `--no-wrap` を明示していなければ `wrap: false` にする（1 行に押し込むのが目的なので、libass が左右マージンで折り返さないようにする）。
- 決まったサイズは `style.size` に**ただの数値として**保存される。レンダー時の挙動は `--size` で指定した場合とまったく同じで、グラフ側には何も足さない。結果は `result.fit`（`size` / `target_width` / `max_size` / `min_size` / `line` / `em` / `width` / `source` / `size_scale` / `clamped`）で返る。
- 幅の見積もりの精度: 全角は 1em、ラテン・数字は字ごとの advance（Helvetica の AFM 値を土台にした概算）で足し、そこに**フォントの `unitsPerEm / (usWinAscent + usWinDescent)`** を掛ける（ASS の `Fontsize` は em の大きさではなく、libass はこの比で字を縮めるため。CJK フォントでは 0.8 前後）。日本語主体の文字列なら指定幅の 87〜95% 程度に収まり、`--measure` なら 97〜99%。欧文の極太ウェイト・カーニングの強い書体・`--markup ass` でタグを書いた本文では概算がずれるので `--measure` を使う。
- 複数行は `\n` を受理。`--text-file <path>` でファイルから読む。`--asset <id>` は `type: text` の素材を参照（テキストクリップに `text` ではなく `asset` を保持し、レンダー時に本文を読む。W-17）。
- 既定フォントは `doctor` が検出した CJK 対応フォント（Noto Sans CJK JP → Hiragino → Yu Gothic → DejaVu の順）。

### `montash text set <id> [同上のオプション]` / `remove <id>` / `list [--track <t>] [--json]` / `presets [--json]`

プリセット（`title-center`, `lower-third`, `caption-bottom`, `corner-tag`）はサイズ・位置・背景・フェードの組。ユーザー定義は `project.json` の `text_presets` に追加。

---

## プラグイン（W-19）

拡張を導入・確認する。契約は docs/14。**`install` は人間が実行する操作**で、AI は自律実行しない（プラグインは任意コードを実行するため）。

### `montash plugin list [--json]` — W-19

読み込まれているプラグインと、それぞれが登録した拡張、探索したディレクトリを表示する。

### `montash plugin install <path> [--force] [--yes]` — W-19

プラグインディレクトリ（`montash-plugin.json` を含む）をユーザーの置き場（`~/.local/share/montash/plugins/<id>`）へコピーする。

- 導入前に **capabilities を提示して確認**する。`--yes` が無い非対話実行（AI・スクリプト）は `E_CONFIRM_REQUIRED` で止まる。
- 同じ ID が導入済みなら `E_PLUGIN_EXISTS`（`--force` で置き換え）。
- **ネットワークから取得はしない。** 入手は利用者が行う。

### `montash plugin remove <id>` — W-19

### `montash plugin doctor [--json]` — W-19

このプロジェクトが必要とするプラグイン（`project.plugins.requires[]`）と、解釈できない効果を照合して報告する。不足があれば終了コード 1。

### プラグインが足すコマンド

プラグインは効果・ジェネレータ・トランジションだけでなく、**CLI コマンドそのもの**を足せる（`host.commands.define()`。docs/14 §3.3）。登録されたコマンドは組み込みとまったく同じ `CommandSpec` として `getCommands()` に合成されるので、`montash schema` / `montash help` にも自動で載り、「実行はできるが AI からは見えない」が起きない。**コマンドは必ずプラグイン ID の末尾セグメントを名前空間として持つ**（`com.example.glow` なら `montash glow ...` の下だけ）。名前空間が組み込みの第 1 セグメント（`clip` / `render` など）と同じになる場合や、別のプラグインが既に取ったパスの場合は `E_PLUGIN_COMMAND_CONFLICT` で登録を拒否し、そのプラグインだけを読み込み失敗にする（組み込みは決して置き換わらない）。状態を変える（`mutates: true`）コマンドも通常の状態変更コマンドと同じ道を通る — 変更は op として履歴に残り、`--dry-run` / `-m` もそのまま効く。プラグインが `project.json` を直接書くことはない。どのコマンドがどのプラグイン由来かは `plugin list` の `registered.commands` で分かる。Web から実行できるのはマニフェストの `webAllow` と `serve --allow` が許した範囲だけ（docs/06）。

## エフェクト（W-18）

クリップに掛ける効果。効果の種類と引数は**エフェクトレジストリ**が持ち、CLI のオプションはその定義から導出される（docs/07 §3a、docs/14）。組み込みもプラグインも同じ扱いで、`effect presets` の `source` で出自が分かる。

### `montash effect presets [--target video|audio] [--json]` — W-18

登録済みの効果を、引数の型・既定値・範囲つきで一覧する。`--json` は AI 向け（`schema` にも同じ情報が載る）。

### `montash effect add <clip> <effect> [効果ごとの引数...] [--index N]` — W-18

```
montash effect add c1 color --saturation 1.2 --brightness 0.05
montash effect add c1 color --gamma 1.1 --index 0     # 先頭に差し込む
```

- 引数は効果ごとに違う。**受け取れる引数は `effect presets` が返すものだけ**で、その効果が持たない引数は無視される。
- 値の型・範囲・`choices` は追加時に検査する（レンダーまで持ち越さない）。範囲外は `E_USAGE`。
- `--index` 省略時は末尾に追加。効果は**配列順に適用**される。
- 登録されていない効果は `E_PLUGIN_MISSING`（終了コード 1）。`hint` に導入済みの効果一覧を出す。
  - **注意**: その効果固有の引数を一緒に渡すと、引数の解析が先に走って `E_USAGE`（`Unknown argument`）になる。まず `effect presets` で確認すること。

### `montash effect set <clip> <effect|index> [引数...] [--index N]` — W-18

指定した引数だけを更新する（指定しなかった値は残る）。`--index` で適用順を変えられる。効果は名前でも、`effect list` の index でも指定できる。

### `montash effect remove <clip> <effect|index>` — W-18

### `montash effect list <clip> [--json]` — W-18

掛かっている効果を**適用順**に返す。プラグインが無くて解釈できない効果には `missing: true` が付く（その状態でもプロジェクトは開ける。F-EXT-4）。

## 10. オーバーレイ

### `montash overlay add` — W-08

```
montash overlay add --asset <id> --track <Vn> --at <t> (--duration <t>|--until <t>)
                  [--position <preset|x,y|%>] [--margin <px>] [--scale <0..1|WxH>] [--opacity 0..1]
                  [--fade-in <t>] [--fade-out <t>] [--keep-alpha] [--in <t>] [--id <id>] [--label <str>]
```

内部的には「配置属性付きクリップ」。`overlay set <id> [--position] [--margin] [--scale] [--opacity] [--fade-in] [--fade-out] [--keep-alpha]` / `overlay remove <id>` / `overlay list [--track <t>] [--json]`。位置・尺の変更は `clip move|trim` を使う。

---

## 11. 音声

### `montash audio gain (--clip <id>|--track <t>|--master) --db <±n>` — W-07
### `montash audio fade --clip <id> [--in <t>] [--out <t>] [--curve tri|exp|log]` — W-07
### `montash audio duck --target <track> --sidechain <track> [--threshold -30dB] [--ratio 8] [--attack 20] [--release 500] [--makeup 0]` — W-07

`--attack` / `--release` の単位は **ms**（`20` = 20ms）。`500ms` / `0.5s` のように単位を明示しても受け付ける。単位なしで 10 未満の値は秒と解釈して `W_TIME_UNIT_GUESSED` を返す（`--release 0.5` → 500ms）。

`sidechaincompress` を用いる。`--simple` 指定時は音声レベル解析（`silencedetect`）で会話区間を検出し、`volume` のキーフレームで下げる方式にフォールバック（sidechaincompress が使えない環境向け）。

### `montash audio normalize [--loudness -14] [--true-peak -1] [--lra 11] [--off]` — W-07

レンダー時に 2 パス `loudnorm` を適用する設定。`project.json` の `audio.normalize` に保存。

### `montash audio analyze (<track>|<clip>|--asset <id>) [--min-silence <t>] [--noise-db <db>] [--json]`

`ebur128` / `volumedetect` で統合ラウドネス、ピーク、無音区間を返す。無音判定のしきい値は `--noise-db`（既定 -50dB）、最短の長さは `--min-silence`（既定 0.5 秒）。

### `montash audio duck remove <id>`

ダッキング設定を ID で削除する（`audio duck --target <track> --off` と同じ結果）。

### `montash audio show [--json]`

トラック／クリップ単位のゲイン・フェード・ダッキング・正規化設定を一覧。

### `montash audio offset --clip <id> (--by <±t|s:±N> | --set <s:N>)` / `montash clip unlink <id>` / `montash clip link <video> <audio>`

`clip unlink` / `clip link` は未実装（§1.9）。1 回の編集に閉じたリンク解除は `clip move|trim|split|set --unlink` で行う。

`offset` はサブフレームの同期補正で、**サンプル単位**（`offset_smp`）に保存する。`--by 0.02` はサンプルに変換（`round(0.02 * SR)`）。リンク中のクリップには適用不可（`E_CLIP_LINKED`。先に `clip unlink`）。フレーム単位以上のずらしは `clip move` を使う。

---

## 12. 字幕

### `montash subtitle add --asset <srt|ass id> --mode burn|soft [--track <t>] [--at <t>] [スタイル] [--lang ja] [--offset <±t>] [--id <id>]` — W-14
### `montash subtitle set <id> [同上]` / `remove <id>` / `list [--track <t>] [--json]`

`burn` は SRT/VTT をテキストトラックの ASS に統合して 1 回で焼く（ASS 素材はそのスタイルを尊重して別の `subtitles` フィルタで焼く）。`soft` は `-c:s mov_text`（MP4）または `srt`/`ass`（MKV）で多重化。`--offset` はフレームに丸めて `offset_f` に保存。

**スタイル**（`add` と `set` に共通。指定しなければ何も書き込まないので、既定の見た目は従来のまま）:

```
[--font <family>] [--size <px>] [--color <#RRGGBB[AA]>]
[--outline <px|px,#RRGGBB[AA]|none>] [--outline-color <#RRGGBB[AA]>]
[--bg <#RRGGBB[AA]|none>] [--bg-padding <px>] [--shadow <px|x,y,#RRGGBB[AA]|none>]
[--position <preset|x,y|x%,y%>] [--bold] [--margin-bottom <px>]
```

**名前も意味も `text add` §10 と同じ**（`project.json` に入る形も同じで、`style` は `TextStyleSchema` から取った部分集合 + `margin_bottom`）。字幕側の違いは 2 つだけ:

- `--position` の既定は `bottom-center`（テキストは `center`）。列（左・中・右）は `--position` の名前から決まるので、`--position bottom-left` は位置レジストリの `\an1` になる
- `--outline` と `--shadow` は px だけの略記も受ける。`--outline 3` = `--outline 3,#000000`、`--shadow 2` = `--shadow 2,2,#000000`。色だけ変えるなら `--outline-color`（幅が無いと `E_USAGE`）

白背景のスライドに焼くときは `--outline 3 --outline-color "#000000"`（細い縁取り。文字の形が残る）か `--bg "#000000B3" --bg-padding 10`（背景ボックス。最も確実）を使う。**`--bg` は縁取り・影より強く、指定すると `--outline` / `--shadow` は描かれない**（ASS の Style は箱と縁取りで同じ `Outline` の値を使うため。07 章 §6.2）。`--margin-bottom` は下端からの距離で、Style の `MarginV` に入る。

ASS 素材（`.ass` / `.ssa`）を `burn` するときは素材自身の Style が勝つので、スタイル指定は `W_SUBTITLE_STYLE_IGNORED` で無視を知らせる。

### `montash subtitle generate [--asset <id>] [--lang ja] [--vocabulary <語,語>] [--engine <name>] [--engine-path <p>] [--model <p>] [--threads N] [--timeout <s>] [--save-transcript <p.json>] [--from-transcript <p.json>] [--replace "誤=正"] [--replace-file <p>] [-o <path.srt>] [--overwrite] [--no-add] [--mode burn|soft] [--track <t>] [--at <t>] [--font <family>] [--asset-id <id>] [--id <id>] [--max-chars 20] [--max-lines 2] [--min-duration 1.2] [--max-duration 5.5] [--pause 0.5]` — W-22, W-24

音声を書き起こして字幕にする。1 コマンドで「音声の書き出し → 書き起こし → 整形 → SRT → `import` → `subtitle add`」までをやる。

- **書き起こしエンジンは組み込まない**（docs/14「やらないこと」: ネットワークから何も取得しない。モデルは数百 MB）。
  外部コマンドを呼ぶだけで、既定は whisper.cpp の `whisper-cli`（次いで `whisper-cpp` / `whisper`）。
  探索順は `--engine-path` → `MONTASH_TRANSCRIBER` → `~/.local/share/montash/whisper/bin` → PATH。
  モデルは `--model` → `MONTASH_TRANSCRIBER_MODEL` → `~/.local/share/montash/whisper/*.bin`。
  どちらも無ければ `E_TRANSCRIBER_NOT_FOUND` / `E_TRANSCRIBER_MODEL_NOT_FOUND`（`montash doctor` の `result.transcriber` でも見られる）。
- 入力は既定でタイムラインのミックス（`render audio` と同じ経路で 16kHz モノラル WAV を作る）。`--asset <id>` で素材 1 つだけにできる。
- `--vocabulary "多面観察,総括次長"` はエンジンの `--prompt` に渡る。固有名詞の精度が大きく変わるので、分かっているなら必ず渡す。
- **整形（トークン → 読める字幕）は montash 側が行う**（`src/core/subtitle-format.ts` の純関数）。
  文（。！？）でまとめるのを最優先し、長い文は読点、それでも長ければ文字数で分ける。語の途中（カタカナ語・漢字の連なり・助詞の直前・「お願い」のような接頭辞・「ございます」のような活用語尾）では切らない。
  **字幕の切れ目（cue 境界）と 1 字幕の中の行折り返しは同じ語境界の判定（`breakScore()`）を使う**ので、片方だけ語が割れることはない。
  cue を容量ちょうど（`--max-chars` × `--max-lines`）まで詰めると行の切れ目に選択肢が残らないため、**折り返せる形になるところまで cue を短く切る**（その結果 1 字幕あたりの字数は容量より少し短くなることがある）。
  1 字幕 = 最大 `--max-lines` 行 × `--max-chars` 字（既定 2 × 20）、表示 `--min-duration`〜`--max-duration` 秒（既定 1.2〜5.5）、日本語の禁則処理、字幕どうしは重ねない。
- エンジンが句点を出さない区間では **話者の間（トークン間の無音）** を文の切れ目として使う。`--pause <秒>`（既定 0.5、`0` で無効）以上の無音があり、
  かつ本文もそこで切れそうなとき（敬体の語尾・呼びかけ・読点のあと、または接続表現の手前）だけ切る。時間だけ・言葉だけでは切らない
  （エンジンの時刻は語の中でも飛ぶため。実測で「33 | 回目」の間に 730ms あった）。`--max-len` のようなエンジン側の設定には頼らない。
- 出力は既定で `<project>/subtitles/<name>.<lang>.srt`。`--no-add` を付けると SRT を書くだけで `project.json` は変えない。
- `result` は `srt` / `cues` / `tokens` / `engine` / `model` / `language` / `vocabulary` / `command`（エンジンの引数）/ `asset` / `clip` /
  `from_transcript` / `saved_transcript` / `replacements`（`{from, to, count}` の配列）。
- 見た目（サイズ・色・位置）の調整は `subtitle set` に任せる。

**誤認識を直す（W-24）。** `--vocabulary` を渡してもエンジンが固有名詞を外すことはある（実地で「フロントエンド運用」→「フロント演動」、「山笠」→「山傘」）。
直すのは **SRT ではなく整形前のトークン列**にする。SRT は「2 行 × 20 字に折り返し、1.2〜5.5 秒に割り付けた」後の形なので、そこで語を 1 つ直すと行があふれ、折り返しをやり直す手段が無い（実地で「フロント演動」→「フロントエンド運用」の 2 文字で崩れた）。

- `--save-transcript <path.json>`: **整形前のトークン**を JSON で残す（`{format: "montash.transcript", version, tokens: [{text, startMs, endMs}], text, engine, model, language, vocabulary, source, asset, replacements}`）。
  `text` はトークンを繋いだ本文で、**誤認識を探すのはここを読む**。保存されるのは置換を当てた後のトークン（次はその続きから直せる）。特殊トークン（`[_BEG_]`）は落としてある。
- `--from-transcript <path.json>`: そのトークンを読み直して**整形からやり直す**。エンジンもモデルも音声の書き出しも要らないので速い（21 分の会議で whisper は分の単位、これは秒の単位）。`--asset` とは併用できない（`E_USAGE`）。
- `--replace "フロント演動=フロントエンド運用"`: **整形の前**にトークンを書き換える。複数指定できる（繰り返す。カンマでは割らない: 置換後にカンマが入りうるため）。`--replace-file <path>` は 1 行 1 規則（`#` はコメント）。
  区切りは**最初の `=`**。右辺が空なら語を落とす。規則は書いた順に当たり、`--replace-file` の中身 → `--replace` の順。
- **トークンをまたぐ語も置換できる**（whisper は「フロント」「演動」のように語を割って返す）。**置換したトークンの時刻は、置き換えた文字たちが占めていた時間をそのまま引き継ぐ**（開始 = 消えた最初の文字の開始、終了 = 消えた最後の文字の終了）。
  文字数が変わっても話している時刻は動かないので、**字幕の出るタイミングは置換の前後で変わらず、変わるのは折り返しだけ**になる。触れなかったトークンは 1 つも書き換えない。
- 1 度も当たらなかった規則は `W_REPLACE_UNUSED` で知らせる（綴り違いを黙って捨てない）。当たった回数は `result.replacements[].count`。
- **何を誤りと見なすかは montash が判断しない。** 規則を作るのは人（または人の指示を受けた AI）で、montash は辞書も推測も持たない（`suggest highlights` と同じ線引き。docs/13 D-23）。
- 保存した書き起こしが読めなければ `E_TRANSCRIPT_NOT_FOUND` / `E_TRANSCRIPT_INVALID`、規則ファイルが無ければ `E_REPLACE_FILE_NOT_FOUND`。

---

## 13. プレビュー

### `montash serve` — W-02, W-04

```
montash serve [--port 7788] [--host 127.0.0.1] [--open] [--no-watch] [--no-auto-preview]
            [--read-only] [--allow-remote-write] [--allow <cmd,...>] [--deny <cmd,...>]
            [--max-upload 2G] [--daemon] [--dev]
```

`--daemon` の制御コマンド（`serve stop|status`）は未実装（§1.9）。`--dev` は Web UI を HMR 付きで配信する開発用。

- Web プレビューサーバを起動（06 章）。フォアグラウンドで実行し Ctrl-C で終了。`--daemon` でバックグラウンド化し `montash serve stop|status` で制御。
- `project.json` と `.montash/history/` を監視し、変更があれば WebSocket でブラウザに通知。`--no-auto-preview` 以外では変更後にデバウンス（1.5 秒）して `preview build` を自動実行。
- Web からの操作（履歴移動、素材管理）は `POST /api/cli` 経由で **同じ `montash` バイナリを `MONTASH_ACTOR=web` で子プロセス実行** する。許可リストは 06 章 §3.3。`--read-only` で全面無効化。
- `--allow` / `--deny`: 既定の許可リストに足す／引く（繰り返し指定・カンマ区切り可。`--allow "effect set"`）。プラグインがマニフェストで宣言した `webAllow` も合成される。**`--deny` が `--allow` にもプラグインの `webAllow` にも勝ち、`--read-only` はそれらより強い**（書き込み API ごと閉じる）。渡せるのはコマンドパス 2 語までで、存在しないコマンドは `E_USAGE`。合成結果と出自は `GET /api/cli/allowlist` で確認できる（06 章 §3.3）。
- `--host` が loopback（`127.0.0.0/8` / `localhost` / `::1`）以外なら、起動ログに `W_REMOTE_HOST` を出して **`--read-only` を強制**する。Web の `import <任意パス>` はこのユーザーが読めるファイルをすべて読めるので、LAN 公開時の既定を安全側に倒している（13 章 A-7）。`--allow-remote-write` を明示すると強制を解除するが、そのときは `W_REMOTE_WRITE` で「到達できる誰でも許可リストのコマンドを実行でき、`import <path>` で任意のファイルを読める」ことを毎回警告する。SSH トンネルで `127.0.0.1` に繋ぐほうが安全。
- `--max-upload <size>`: `POST /api/upload` の上限（既定 `2G`）。`2G` / `512M` / `1.5GB` / バイト数を受け、単位は 2 進接頭辞（`1K` = 1024）。0 以下や解釈できない値は `E_USAGE`。上限を超えた送信は 413 `E_UPLOAD_TOO_LARGE` になり、`montash import <path>` での取り込みを案内する（13 章 A-5）。上限は起動時に決まり、`GET /api/status` の `server.max_upload_bytes` に出る。
- `--open`: OS 既定ブラウザで開く（macOS `open`、Linux `xdg-open`、WSL `wslview`/`cmd.exe /c start`）。

### `montash preview build [--from <t>] [--to <t>] [--force] [--audio-only] [--height 360]` — W-04, W-06, W-07

M2実装。`--from/--to`（部分再生成）、`--force`、`--audio-only`、`--height`、グローバル `--dry-run`（セグメント分割と各ハッシュを表示）に対応する。マニフェスト `.montash/preview/timeline.json`（05章 §12）の書き込みが公開点で、フレーム数・音声尺・解像度を検証してから差し替えるため、途中状態の `timeline.mp4` が読まれることはない。生成中は `.montash/preview/build.lock` を持ち、二重起動は `E_PREVIEW_BUSY`。生成中でも古い `timeline.mp4` は再生できる（`preview status` は `building`、直前版の `built_at` を返す）。トランジション・テキスト・速度変更を含むプロジェクトは `E_NOT_IMPLEMENTED`。

タイムラインをプロキシ品質で 1 本の MP4（`.montash/preview/timeline.mp4`）にレンダー。**映像**はフレーム境界のセグメントキャッシュ（`.montash/preview/segments/<hash>.mp4`、音声なし）を再利用して `concat`、**音声**はタイムライン全体を毎回 1 パスで生成（`audio.m4a`。音声関連が不変ならキャッシュ）、最後に `-c copy` で mux する（07 章 §11）。`--from/--to` で部分再生成。

### `montash preview status [--json]`

`state: ready|building|stale|missing`、最終ビルド時刻、対象の `project.json` ハッシュ、進捗。

---

## 14. 書き出し

### `montash render` — W-09, W-11, W-12

```
montash render -o <path> [--preset <name>] [--from <t>] [--to <t>]
             [--vcodec libx264|libx265|h264_videotoolbox|h264_nvenc|prores_ks|...] [--crf 18] [--vbitrate 8M] [--preset-speed medium]
             [--acodec aac|libopus|pcm_s16le] [--abitrate 192k]
             [--resolution WxH] [--fps <n>] [--reframe center|left|right|x%] [--pix-fmt yuv420p]
             [--hwaccel auto|none|videotoolbox|nvenc|vaapi|qsv] [--threads <n>]
             [--two-pass] [--overwrite] [--progress text|jsonl|none] [--dry-run] [--last]
```

実装済みは `-o/--output`, `--preset`, `--crf`, `--preset-speed`, `--resolution`, `--threads`, `--progress`, `--overwrite`, `--dry-run`。それ以外は未実装（§1.9）。

- `--preset` 一覧は `render presets`（`youtube-1080p`, `youtube-4k`, `instagram-reel`(1080x1920), `twitter`, `web-preview`(720p CRF 28), `prores-422`, `archive-h265`, `audio-only-mp3`, `gif`, `thumbnail`）。個別オプションはプリセットを上書き。**実装済みのプリセットは `youtube-1080p` / `web-preview` の 2 つのみ**（§1.9）。
- `--reframe`: 出力アスペクトがタイムラインと異なるときのクロップ基準。省略時はレターボックス（パディング）。
- `--progress jsonl`: 1 行 1 JSON（`{"frame":1234,"fps":98.2,"time":41.2,"percent":92.6,"eta":3.1,"speed":"3.2x"}`）を stdout に。人間向け `text` は 1 行更新のプログレスバー。
- `--last`: 前回のレンダーオプションを `.montash/render/last.json` から復元。
- 実行前に `validate` を自動実行（error があれば終了コード 5、`--skip-validate` で回避）。
- 完了後 `render verify` を自動実行し、結果に `output: { path, size, duration, streams }` を含める。

### `montash render verify <path> [--json]` — W-09

出力ファイルを `ffprobe -count_frames` し、映像フレーム数が `duration_f`（または `--from/--to` 区間、`--fps` 指定時は換算値）と**厳密に一致**するか、音声尺が ±1 フレーム以内か、ストリーム構成が期待どおりかを検証。

### `montash render presets [--json]` / `montash render batch --preset <name[:opts]>... -o <dir> [--parallel 1]` — W-12

`render presets` は実装済み。`render batch` は未実装（§1.9）。

`batch` はプリセット名をファイル名サフィックスにする（`<project>_<preset>.mp4`）。

### `montash render still --at <t> -o <path.png>` / `montash render gif --from --to -o` / `montash render audio -o <path.wav|mp3>` — 未実装（§1.9）

---

## 15. 履歴（git ライク） — W-10, W-11, W-15, W-16

モデルと詳細は **11 章** を正とする。ここでは一覧のみ。

| コマンド | 説明 |
|----------|------|
| `montash status [--json]` | HEAD（op / 所属コミット）、tip か detached か、pending op の一覧と要約、直近コミット、タグ、worktree の dirty 判定 |
| `montash log [--ops] [--all] [--limit 20] [--since <id\|time>] [--grep <str>] [--author <a>] [--graph] [--json]` | コミット一覧（既定）。`--ops` で op 展開、`--all` で全系列、`--graph` で ASCII DAG |
| `montash show <op\|commit\|tag> [--patch] [--json]` | 詳細と差分 |
| `montash diff [<a>] [<b>] [--json]` | 2 時点の差分。省略時は最終コミット〜HEAD（= pending の差分） |
| `montash blame <element-id> [--json]` | 要素を最後に変更した op / commit / actor |
| `montash commit -m <msg> [--body <s>\|--body-file <p>] [--last <n>\|--ops <a>..<b>] [--tag <name>] [--author <a>] [--allow-empty] [--auto-message] [--amend] [--from-worktree]` | pending op をコミットにまとめる。`--auto-message` は規則ベースで叩き台生成 |
| `<任意の状態変更コマンド> -m <msg> [--body <s>]` | その op だけを即コミット |
| `montash checkout <op\|commit\|tag\|tip\|HEAD~n\|<ref>~n>` | HEAD を移動し `project.json` に展開（ミリ秒）。pending は失われない |
| `montash undo [<n>]` / `montash redo [<n>]` | op 単位で親へ／子へ。子が複数なら候補を返す |
| `montash revert <commit\|op> [-m <msg>]` | 逆差分を新しい op として適用し即コミット |
| `montash reset --hard <ref>` | checkout + その先の系列を `log` 既定表示から外す（物理削除しない） |
| `montash tag <name> [<ref>] [-m <msg>]` / `tag list` / `tag delete <name>` | 名前付き位置（旧スナップショット） |
| `montash snapshot save\|restore\|list\|delete` | `tag` / `checkout` の別名（互換） |
| `montash history prune [--keep-commits 100] [--keep-days 30] [--dry-run]` / `verify` / `export -o <f>` / `import <f>` | 保守・監査 |
| `montash ids rebuild [--json]` | `.montash/ids.json` を現在の `project.json` と全 object から再構築（ADR-13） |

`blame` / `revert` / `reset --hard` / `snapshot` と `log --since`、`commit --body-file|--amend|--from-worktree` は未実装（§1.9）。

`checkout`/`undo`/`redo`/`reset` は op を作らず `.montash/history/moves.jsonl` に記録する。Web からの操作は `actor: web` で同じコマンドが実行される（06 章 §3.3）。

---

## 16. AI 支援

### `montash batch <file.jsonl|-> [--atomic] [--continue-on-error]` — W-20

1 行 1 コマンドの JSON Lines を順次実行する（F-AI-5）。`<file>` が `-` なら標準入力から読む。

**行の書き方**（3 通り。どれでも混ぜてよい）

```jsonl
# 空行と # で始まる行は読み飛ばす
{"args": ["clip", "add", "--asset", "clip_a", "--in", "f:0", "--duration", "f:90", "--at", "end"]}
["clip", "add", "--asset", "clip_b", "--at", "end"]
clip add --asset clip_c --at end
```

素の bash 行は `'...'` / `"..."` と `\` エスケープだけを解釈する（変数展開・グロブ・パイプは扱わない。batch はシェルではない）。先頭の `montash` は付けても付けなくてもよい。**構文エラーは 1 行も実行する前に `E_BATCH_PARSE` で落とす**（行番号は `detail.line`）。

**実行**: 各行は同じプロセス内で、通常の CLI とまったく同じコマンド定義・同じ引数解釈で実行される（`montash` を子プロセスとして起動し直さない）。行に付けたグローバルオプション（`--dry-run` など）も効く。`-C` はバッチ側のものを引き継ぐ。

**モード**

| モード | 途中で失敗したら | 履歴 |
|--------|------------------|------|
| `--atomic`（既定） | **開始前の状態へ巻き戻して** `E_BATCH_FAILED`。以降の行は `skipped` | 全行まとめて **1 op**（`command` は `["batch", ...]`、`changes` に全差分。docs/11 §3.2） |
| `--continue-on-error` | 失敗を記録して次の行へ進む。終了コードは 1 | **各行が通常どおり op を積む**（部分適用がどこまで進んだかを op 単位で戻せるように） |
| `--no-atomic`（`--continue-on-error` 無し） | その行で止まる。適用済みの行はそのまま残る | 同上 |

`--atomic` と `--continue-on-error` の同時指定は `E_USAGE`。

**巻き戻しの範囲**: 戻るのは **タイムラインの状態（`project.json`）だけ**。`render` / `proxy build` が書いたファイルは消さない。ID カウンタ（`.montash/ids.json`）も戻さない（失敗した試行の ID を再利用しないため。docs/05 §2.3）。

**バッチの中で実行できないコマンド**（`E_BATCH_UNSUPPORTED`）: `batch`（入れ子）・`serve`・`init`。加えて `--atomic` では HEAD を動かす／自分で op を積むもの（`checkout` `undo` `redo` `revert` `reset` `commit` `history import` `history prune`）。

**`-m`**: `montash batch ... -m "<メッセージ>"` で、実行後にそのままコミットする（`--atomic` なら 1 op = 1 コミット）。`--atomic` のバッチでは**行に付けた `-m` は無視**され `W_BATCH_MESSAGE_IGNORED` を返す（op が 1 つしか無いため）。

**`--dry-run`**: 何も実行せず、各行が**どのコマンドに解決されるか**だけを返す（打ち間違いの検出用）。行の中身の検証まではしない。

**`--json`**（AI 向け。どの行が成功しどこで失敗したかが分かる形）

```jsonc
{
  "ok": true, "command": "batch",
  "result": {
    "source": "/path/edits.jsonl",
    "mode": "atomic",            // atomic | continue-on-error
    "dry_run": false,
    "total": 3, "succeeded": 3, "failed": 0, "skipped": 0,
    "rolled_back": false,
    "lines": [
      { "line": 2, "index": 1, "args": ["clip","add", "..."], "command": "clip add",
        "status": "ok", "ok": true, "op": null, "summary": "add c1 (clip_a) on V1 at f:0",
        "change_count": 3, "result": { "clip": { "id": "c1" } } }
    ]
  },
  "op": "o_0007", "commit": null, "head": { "op": "o_0007", "pending": 3, "detached": false }
}
```

失敗時、`--atomic` は `ok: false` + `error.code = E_BATCH_FAILED` で、`error.detail` に上と同じ `lines` と `rolled_back` / `rollback` が入る。`--continue-on-error` は `ok: true` のまま `result.failed > 0` と終了コード 1 を返す（一部は実際に適用されているため。`import` / `proxy build` と同じ扱い）。`lines[].error` が `code` / `message` / `hint` を持つ。

### `montash explain (<id> | timeline | render) [--json]`

対象を自然言語（英語）で説明する。読み手は AI と人間の両方なので、**同じ内容を 2 つの形で返す**（F-AI-4）:

- `result.explanation`: 1 読で分かる文の配列。「何を・どこから・どれだけ・どう加工して置かれているか」を順に述べる。
- `result.facts`: 機械可読な事実（`_f` と秒・タイムコードを併記。§1.3a）。`result.notes` は注意（プラグイン不足・素材欠落・ロック）、`result.see_also` は次に叩くコマンド。

`<id>` は **ID で指せるものすべて**: クリップ（映像・音声 / テキスト / 字幕 / 生成 / プラグイン未導入の `opaque`）、トランジション、トラック、アセット、ダッキング。クリップでは掛かっている効果とそのパラメータ（`effect list` 相当）も述べる。

```
$ montash explain c2
c2 — media clip on track V1 (video)

  c2 takes 0.000s..20.000s (f:0..f:600) of asset clip_b (video, 30.000s long) and places it on track V1 at 12.500s..32.500s (f:375..f:975), 600 frames long.
  Its counterpart clip c2a is linked to it, so moves, trims and splits apply to both.
  t1 (crossfade, 0.500s, handle mode, audio crossfade) runs into it from c1.
  1 effect is applied, in order: color (saturation=1.2).
```

`timeline` はプロジェクト全体（尺・fps・解像度・トラック構成・トランジション・音声・ギャップ）を、`render` は生成される ffmpeg コマンドとフィルタグラフを**連鎖ごとに注釈付きで**表示する（`render --dry-run` と同じプランを組み立てる）。

解釈できない要素（未導入プラグインの `opaque` クリップ、未登録の効果・ジェネレータ）は「読み書きはできるがレンダーできない」ことを `notes` に書く（F-EXT-4）。存在しない ID は形から種別を当てて `E_CLIP_NOT_FOUND` / `E_TRANSITION_NOT_FOUND` / `E_TRACK_NOT_FOUND` / `E_DUCKING_NOT_FOUND` / `E_ASSET_NOT_FOUND` を返し、`hint` に候補を出す。

### `montash suggest highlights [--asset <id>] [--max <t>] [--count N] [--min-length <t>] [--max-length <t>] [--pause <s>] [--threshold 0..1] [--pad <s>] [--keywords N] [--no-transcribe] [--lang ja] [--vocabulary <語,語>] [--engine <name>] [--engine-path <p>] [--model <p>] [--threads N] [--timeout <s>] [--noise-db <db>] [--min-silence <s>] [--json]` — W-23

長い録画から「どこを使うか」を決める材料を出す。**候補を提示するだけで、タイムラインには一切触れない**（読み取り系。op を作らない）。出力を見て人（または人の指示を受けた AI）が `clip add` を打つ、という流れを前提にする（docs/13 D-23。実地で AI が独断で区間を選び、重要な話題を落としてやり直しになったのが起票の理由）。

**検出に使うシグナル**（すべて機械的に出せるもの。LLM は使わない）:

| シグナル | 出どころ | 使い方 |
|----------|----------|--------|
| 間（ま） | `silencedetect`（`audio analyze` と同じ 1 パス）と書き起こしトークンの隙間 | 長い間ほど「切ってよい所」 |
| 語彙の移り変わり | 書き起こしの前後 45 秒の窓で使う語のコサイン類似度 | 類似度が落ちる所が話題の変わり目 |
| 切り出しの語 | 「では」「続いて」「次に」「ということで」など | 話の頭に来る表現があれば境界を強める |
| 発話密度 | 無音でない割合・1 秒あたりの文字数 | 密度が低い区間は切り抜きに向かない |

話者の識別（diarization）は**使っていない**。whisper.cpp は話者を返さないので、話者交代は「長い間 + 語彙の入れ替わり」として間接的にしか見えない。

**要約に LLM を使わない。** `lead` は書き起こしの**先頭の文をそのまま切り出したもの**、`keywords` はその区間に偏って出る語（tf-idf。日本語は字種の連なりを 1 語として拾う。形態素解析器は入れない）。どちらも「人が判断するための材料」であって判断そのものではないので、`evidence` に**何を根拠にしたか**（前後の間の長さ・語彙の移り変わり・切り出しの語・発話密度）を必ず載せる。

- `--max <t>` は**選ぶ合計の長さの枠**（`5:00` のような時間表記。§1.3）。`--count N` は本数の枠。
  **枠に入らなかった候補もリストから消さない**（`selected: false` になるだけ）。枠は提案であって決定ではない。
- `--min-length` / `--max-length` は 1 候補の長さの下限・上限（既定 30 秒 / 180 秒）。上限を超える塊は中で一番強い切れ目で割る。
- `--no-transcribe` は書き起こしエンジンを呼ばず、無音区間だけで区切る（whisper もモデルも要らないが `lead` / `keywords` は空になる）。
- 書き起こしまわりのオプション（`--lang` `--vocabulary` `--engine` `--engine-path` `--model` `--threads` `--timeout` `--save-transcript` `--from-transcript` `--replace` `--replace-file`）は `subtitle generate`（§12）と同じ。エンジンとモデルは**人の手で**導入する（montash は取得しない）。
  `--from-transcript <path>` は `subtitle generate --save-transcript` が書いたトークンを読み直し、**エンジンを回さずに**候補を出す（無音解析は走るので音声の書き出しはする）。`--replace` は `lead` / `keywords` に効く（固有名詞が化けたまま tf-idf を見ても読めない。W-24）。
- 候補ごとに `command`（`montash clip add --asset <id> --in <tc> --out <tc>`）を添えるが、**montash は実行しない**。`--asset` を省いた（タイムラインのミックスを見た）ときは `null`。

```
$ montash suggest highlights --asset rec --max 5:00
20 candidate(s) from 21:06 (signals: transcript + silence)
* # 1  02:57-03:32    35s  score 0.89  speech 75%
        keywords: PML / コンフレンス / スペース / プロジェクトマニュメント / 何人
        lead: はいありがとうございますじゃあえっとやすもと君はいおはようございますえーとPMLの方から…
        why: pause 2.84s before, 0.91s after; lexical shift 1; 6.43 chars/s
        montash clip add --asset rec --in 00:02:57.067 --out 00:03:32.233
...
selected 8 candidate(s), 296s total — montash does not place them; you decide.
```

`--json` では候補ごとに `start_s` / `end_s` / `start_f` / `end_f` / `start_tc` / `end_tc`（§1.3a）・`score`・`speech_ratio`・`lead`・`keywords`・`evidence`・`command`・`selected` を返し、`result.applied` は常に `false`（このコマンドは何も適用しない）。`result.options` に実際に使ったしきい値が載るので、後から「何で出した候補か」が分かる。

話し声が見つからなければ `E_NO_HIGHLIGHTS`（終了コード 3）。勝手に区間をでっち上げない。

**このスコアは「面白さ」ではない。** 機械的に測れるのは「その区間がまとまって喋っているか」までで、話の重要度は測れない。実素材（21 分の社内ミーティング。人が選んだ 10 区間が手元にある）で確かめたところ、**候補のリストは人が選んだ 10 区間のすべてを 93〜100% 覆う**一方、人と同じ合計時間の枠で上位から採ると人の選択と 76% しか一致しなかった（同じ長さを無作為に採ったときの一致は 69%）。**取りこぼさないためのリストとしては使えるが、順位をそのまま信じて選ぶものではない。**

---

---

## 17. コマンドと手順・要件の対応（抜粋）

| コマンド | 手順 | 要件 |
|----------|------|------|
| `doctor` | W-01 | N-2, F-AI-2 |
| `init`, `project show` | W-01 | F-PRJ-1, F-PRJ-2 |
| `import`, `assets *`, `proxy *` | W-02, W-13, W-17 | F-AST-1〜8 |
| `clip add/move/trim/split/delete` | W-03, W-04 | F-TL-1〜5 |
| `transition *`, `fade` | W-05 | F-TL-7, F-FX-5 |
| `text *`, `fonts list` | W-06 | F-FX-1, N-11 |
| `audio *`, `track *` | W-07 | F-AU-1〜4, F-TL-4 |
| `overlay *` | W-08 | F-FX-2 |
| `serve`, `preview *` | W-02, W-04, W-16, W-17 | F-PV-1〜16 |
| `render *` | W-09, W-11, W-12 | F-RD-1〜9 |
| `status`, `log`, `show`, `diff`, `blame`, `commit`, `-m`, `checkout`, `undo`, `redo`, `revert`, `reset`, `tag`, `history *` | W-10, W-11, W-15, W-16 | F-PRJ-3, F-PRJ-5, F-HIS-1〜8, N-13 |
| `schema` | 全般 | F-AI-1〜3 |
| `batch` | W-20 | F-AI-5 |
| `explain` | W-21 | F-AI-4, F-EXT-4 |
| `subtitle generate` | W-22 | F-FX-1, N-2 |
| `suggest highlights` | W-23 | F-AI-4, F-AU-4, N-2 |
