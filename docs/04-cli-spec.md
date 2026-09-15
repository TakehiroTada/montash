# 04. CLI コマンド仕様

> この章は最終仕様です。2026-09-15時点の実装済み引数は `montash schema`、動作例は README「現在実行できる編集（M1）」を参照してください。M1の `clip add` は重なりエラー方式のみ、`render` は全区間のMP4（2プリセット）のみです。`import --strict` は入力検査に失敗した際に登録を中止します。一部成功の場合はJSONの `result.imported` / `result.failed` と終了コード4を確認してください。

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
- 負の数値を値として渡す場合は `--in=-10` の形式を使う（yargs がオプションと誤認しないため）。`--in -10` も可能な限り解釈するが、`=` 形式を推奨。
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

警告は `W_` プレフィックス（`W_ASSET_MISMATCH`, `W_BEYOND_TIMELINE`, `W_CLIP_SHORTER_THAN_REQUESTED`, `W_GAP_CREATED`, `W_LEAVING_PENDING`, `W_MULTIPLE_CHILDREN`, `W_DETACHED_HEAD`, `W_COMMIT_MESSAGE_STYLE`, `W_DIRTY_WORKTREE`, `W_SNAPPED`（時間入力をフレームに丸めた）, `W_FPS_RESNAPPED`（fps 変更で全時間を再スナップ）, `W_RESOLUTION_RESCALED`, `W_TEXT_ENGINE_LIMITED`（libass 無しで drawtext フォールバック）, `W_ID_REUSED`, `W_RIPPLE_SPAN_NOT_EXTENDED`（リップル挿入で跨ぎクリップを伸ばせなかった）, `W_TRANSITION_REMOVED`（編集点を跨ぐトランジションを削除）, `W_FFMPEG_BEST_EFFORT`（ffmpeg 6.0 未満））。

### 1.8 履歴への記録

状態を変更するコマンドは、実行前後のスナップショット（内容ハッシュ）・コマンド引数・actor・差分・影響範囲を **op** として `.montash/history/ops.jsonl` に追記する（11 章）。`--dry-run` と読み取り系コマンドは記録しない。`checkout`/`undo`/`redo` は op を作らず `moves.jsonl` に移動を記録する。

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

### `montash help [<command>] [--json]`

---

## 3. プロジェクト

### `montash init <name|.>` — W-01

```
montash init <dir> [--fps 30] [--resolution 1920x1080] [--sample-rate 48000] [--channels 2]
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

### `montash diff [--snapshot <name>|--history <id>] [--json]` — W-11

現在の `project.json` と指定時点の差分を JSON Patch 形式と人間向け要約で表示。

---

## 4. アセット

### `montash import <path...>` — W-02, W-14

```
montash import <path...> [--id <id>] [--proxy] [--thumbs] [--waveform] [--copy] [--strict]
```

- glob 展開は bash に任せる。ディレクトリ指定時は再帰で対応拡張子（mp4 mov mkv webm avi mts m2ts mp3 wav aac flac m4a png jpg jpeg webp srt ass vtt txt md）を取り込む。
- ffprobe（`-show_streams -show_format -of json`）を実行し `probe` に保存。種別を判定（video / audio / image / subtitle / **text**）。`.txt`/`.md` は UTF-8 として読み、`type: text` で登録（ffprobe は実行しない）。
- `--proxy --thumbs --waveform` で派生物をその場で生成（無ければ `proxy build` で後から）。
- `--copy` でプロジェクト内 `assets/` にコピー（既定は絶対パス参照）。
- 複数指定時は 1 件失敗しても続行し、結果に `failed: [...]` を含める（終了コードは 4）。
- ID は拡張子を除いたファイル名の slug（`clip_a`）。衝突時は `_2`, `_3`。

### `montash assets list [--type video|audio|image|subtitle|text] [--tag <t>] [--unused] [--missing] [--search <str>] [--json]` — W-02, W-17

ID、種別、ラベル、タグ、パス、尺、解像度、fps、音声 ch、プロキシ状態、使用クリップ数（`usage`）。

### `montash assets show <id> [--json]` — W-02, W-17

要約メタデータ、`--probe` で生 JSON（`.montash/cache/<id>/probe.json` から。無ければ ffprobe を再実行して再生成）、キーフレーム間隔（`--keyframes` でスキャン）、使用箇所一覧（クリップ ID・トラック・区間）、テキスト素材は本文、最後に変更した op（`blame`）。

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

### `montash proxy build [--all | <id...>] [--force] [--height 360] [--parallel 2]` — W-02

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
               [--on-overlap error|overwrite|push] [--video-only|--audio-only]
               [--loop] [--id <id>] [--label <str>]
```

- `--in/--out` 省略時はアセット全体（`out_f = asset.duration_f`）。負値は末尾基準（`--in=-10` = 末尾 10 秒、`--in=-f:300` = 末尾 300 フレーム）。`--duration` は `--out` の代替。画像アセットは `--duration` 必須（省略時 `settings.default_image_duration_f`）。
- in/out はアセットの native fps ではなく **プロジェクト fps のフレーム**で指定する（アセットが 29.97fps でプロジェクトが 30fps なら、`f:30` は 1.0 秒地点）。
- 既定では映像アセットの映像を `--track`、音声を対応する音声トラック（`V1`→`A1`）に **リンククリップ** として同時配置する。`--video-only` / `--audio-only` で片方のみ。
- `--at end` はトラック末尾に隙間なく追加。`--after <clip>` はそのクリップ直後。
- `--loop` は `--duration` がアセット尺より長い場合に繰り返す（音声 BGM 用）。無ければ `W_CLIP_SHORTER_THAN_REQUESTED`。
- `--on-overlap push` は追加位置以降を追加尺ぶん後ろへずらす（リップル挿入。§6a の規則で **全トラック**。`--ripple=track` を併用すると当該トラックのみ）。`overwrite` は重なった部分を既存クリップから削る。

結果: `{ clip: {...}, linked_clip: {...}|null }`。

### `montash clip list [--track <t>] [--asset <id>] [--json]` — W-04

トラック順・時間順に `index`, `id`, `asset`, `start`, `end`, `in`, `out`, `duration`, `linked`, `label` を返す。

### `montash clip show <id> [--json]`

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

### `montash clip set <id> [--speed 1.5] [--pitch-keep] [--label <s>] [--volume <db>] [--opacity 0..1]`

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

### `montash timeline gaps [--fill black|hold|close]`

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

### `montash transition set <id> [--type] [--duration] [--mode]` / `remove <id>` / `list [--json]`

### `montash fade [--track <t>|--clip <id>] [--in <t>] [--out <t>] [--color black|white] [--with-audio]` — W-05

タイムライン（またはクリップ）の先頭／末尾フェード。

---

## 9. テキスト（テロップ）

### `montash text add` — W-06

```
montash text add (--text <str> | --text-file <path> | --asset <text-asset-id>) --at <t> (--duration <t> | --until <t>) [--track T1]
               [--preset <name>] [--font <family>] [--size <px>] [--color <hex[aa]>] [--bg <hex[aa]|none>] [--bg-padding <px>]
               [--position <preset|x,y|x%,y%>] [--align left|center|right] [--line-spacing <px>] [--wrap|--no-wrap]
               [--fade-in <t>] [--fade-out <t>] [--shadow <x,y,color>] [--outline <px,color>] [--bold] [--italic]
               [--markup plain|ass] [--id <id>]
```

- 描画エンジンは **libass**（ASS を生成して `subtitles` フィルタで焼く。07 章 §6）。`doctor` が libass 無しと判定した環境では `drawtext` にフォールバックし、`--wrap`/`--bg-padding`/`--markup ass` は無効（`W_TEXT_ENGINE_LIMITED`）。
- `--position` プリセット: `center`, `top-center`, `bottom-center`, `top-left`, `top-right`, `bottom-left`, `bottom-right`（ASS の `\an` に対応）。座標は px（プロジェクト解像度基準）または %。
- `--size` 等の px はプロジェクト解像度（`PlayResY`）基準。解像度変更時は比率で再計算される（`project set resolution`）。
- `--markup ass` で本文中の ASS オーバーライドタグ（`{\b1}強調{\b0}`、`{\c&H00FFFF&}` 等）をそのまま通す。既定 `plain` は `{ } \` をエスケープ。
- `--fade-in/--fade-out` はフレームに丸めて保存（`fade.in_f`）。
- 複数行は `\n` を受理。`--text-file <path>` でファイルから読む。`--asset <id>` は `type: text` の素材を参照（テキストクリップに `text` ではなく `asset` を保持し、レンダー時に本文を読む。W-17）。
- 既定フォントは `doctor` が検出した CJK 対応フォント（Noto Sans CJK JP → Hiragino → Yu Gothic → DejaVu の順）。

### `montash text set <id> [同上のオプション]` / `remove <id>` / `list [--json]` / `presets [--json]`

プリセット（`title-center`, `lower-third`, `caption-bottom`, `corner-tag`）はサイズ・位置・背景・フェードの組。ユーザー定義は `project.json` の `text_presets` に追加。

---

## 10. オーバーレイ

### `montash overlay add` — W-08

```
montash overlay add --asset <id> --track <Vn> --at <t> (--duration <t>|--until <t>)
                  [--position <preset|x,y|%>] [--margin <px>] [--scale <0..1|WxH>] [--opacity 0..1]
                  [--fade-in <t>] [--fade-out <t>] [--keep-alpha] [--in <t>] [--id <id>]
```

内部的には「配置属性付きクリップ」。`overlay set|remove|list` は `clip` 系と同じ。

---

## 11. 音声

### `montash audio gain (--clip <id>|--track <t>) --db <±n>` — W-07
### `montash audio fade --clip <id> [--in <t>] [--out <t>] [--curve tri|exp|log]` — W-07
### `montash audio duck --target <track> --sidechain <track> [--threshold -30dB] [--ratio 8] [--attack 20] [--release 500] [--makeup 0]` — W-07

`sidechaincompress` を用いる。`--simple` 指定時は音声レベル解析（`silencedetect`）で会話区間を検出し、`volume` のキーフレームで下げる方式にフォールバック（sidechaincompress が使えない環境向け）。

### `montash audio normalize [--loudness -14] [--true-peak -1] [--lra 11] [--off]` — W-07

レンダー時に 2 パス `loudnorm` を適用する設定。`project.json` の `audio.normalize` に保存。

### `montash audio analyze (<track>|<clip>|--asset <id>) [--json]`

`ebur128` / `volumedetect` で統合ラウドネス、ピーク、無音区間を返す。

### `montash audio show [--json]`

トラック／クリップ単位のゲイン・フェード・ダッキング・正規化設定を一覧。

### `montash audio offset --clip <id> (--by <±t|s:±N> | --set <s:N>)` / `montash clip unlink <id>` / `montash clip link <video> <audio>`

`offset` はサブフレームの同期補正で、**サンプル単位**（`offset_smp`）に保存する。`--by 0.02` はサンプルに変換（`round(0.02 * SR)`）。リンク中のクリップには適用不可（`E_CLIP_LINKED`。先に `clip unlink`）。フレーム単位以上のずらしは `clip move` を使う。

---

## 12. 字幕

### `montash subtitle add --asset <srt|ass id> --mode burn|soft [--font] [--size] [--color] [--margin-bottom] [--lang ja] [--offset <±t>]` — W-14
### `montash subtitle set|remove|list`

`burn` は SRT/VTT をテキストトラックの ASS に統合して 1 回で焼く（ASS 素材はそのスタイルを尊重して別の `subtitles` フィルタで焼く）。`soft` は `-c:s mov_text`（MP4）または `srt`/`ass`（MKV）で多重化。`--offset` はフレームに丸めて `offset_f` に保存。

---

## 13. プレビュー

### `montash serve` — W-02, W-04

```
montash serve [--port 7788] [--host 127.0.0.1] [--open] [--no-watch] [--no-auto-preview]
            [--read-only] [--allow <cmd,...>] [--deny <cmd,...>] [--max-upload 8G] [--daemon]
```

- Web プレビューサーバを起動（06 章）。フォアグラウンドで実行し Ctrl-C で終了。`--daemon` でバックグラウンド化し `montash serve stop|status` で制御。
- `project.json` と `.montash/history/` を監視し、変更があれば WebSocket でブラウザに通知。`--no-auto-preview` 以外では変更後にデバウンス（1.5 秒）して `preview build` を自動実行。
- Web からの操作（履歴移動、素材管理）は `POST /api/cli` 経由で **同じ `montash` バイナリを `MONTASH_ACTOR=web` で子プロセス実行** する。許可リストは 06 章 §3.3。`--read-only` で全面無効化。
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

- `--preset` 一覧は `render presets`（`youtube-1080p`, `youtube-4k`, `instagram-reel`(1080x1920), `twitter`, `web-preview`(720p CRF 28), `prores-422`, `archive-h265`, `audio-only-mp3`, `gif`, `thumbnail`）。個別オプションはプリセットを上書き。
- `--reframe`: 出力アスペクトがタイムラインと異なるときのクロップ基準。省略時はレターボックス（パディング）。
- `--progress jsonl`: 1 行 1 JSON（`{"frame":1234,"fps":98.2,"time":41.2,"percent":92.6,"eta":3.1,"speed":"3.2x"}`）を stdout に。人間向け `text` は 1 行更新のプログレスバー。
- `--last`: 前回のレンダーオプションを `.montash/render/last.json` から復元。
- 実行前に `validate` を自動実行（error があれば終了コード 5、`--skip-validate` で回避）。
- 完了後 `render verify` を自動実行し、結果に `output: { path, size, duration, streams }` を含める。

### `montash render verify <path> [--json]` — W-09

出力ファイルを `ffprobe -count_frames` し、映像フレーム数が `duration_f`（または `--from/--to` 区間、`--fps` 指定時は換算値）と**厳密に一致**するか、音声尺が ±1 フレーム以内か、ストリーム構成が期待どおりかを検証。

### `montash render presets [--json]` / `montash render batch --preset <name[:opts]>... -o <dir> [--parallel 1]` — W-12

`batch` はプリセット名をファイル名サフィックスにする（`<project>_<preset>.mp4`）。

### `montash render still --at <t> -o <path.png>` / `montash render gif --from --to -o` / `montash render audio -o <path.wav|mp3>`

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

`checkout`/`undo`/`redo`/`reset` は op を作らず `.montash/history/moves.jsonl` に記録する。Web からの操作は `actor: web` で同じコマンドが実行される（06 章 §3.3）。

---

## 16. AI 支援

### `montash batch <file.jsonl|-> [--atomic] [--continue-on-error]`

1 行 1 コマンドの JSON Lines（`{"args": ["clip","add","--asset","clip_a","--at","end"]}`）または素の bash 行を順次実行。`--atomic`（既定）は途中失敗で開始前状態へ巻き戻し、全体を 1 op として記録。`-m` を付ければそのままコミット。

### `montash explain (<id> | timeline | render) [--json]`

対象を自然言語で説明する（例: 「c2 は clip_b の 0.0–20.0 秒を 12.5 秒から配置。前に t1（crossfade 0.5s）、後に t2。音声は c2a とリンク」）。`render` は生成される ffmpeg コマンドとフィルタグラフを注釈付きで表示。

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
| `schema`, `batch`, `explain` | 全般 | F-AI-1〜5 |
