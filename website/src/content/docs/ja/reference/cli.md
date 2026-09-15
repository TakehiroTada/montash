---
title: CLI リファレンス
description: montash の全コマンドと引数の一覧（montash schema --json から自動生成）
---

<!-- このファイルは website/scripts/gen-cli-reference.ts が生成します。手で編集しないでください。 -->

このページは `montash schema --json` の出力から自動生成しています。
手で編集せず、`cd website && bun run gen:cli` で再生成してください。

各コマンドは `montash <command> --help` でも同じ内容を確認できます。
AI から使う場合は `montash schema --format anthropic-tools` でツール定義をそのまま取り出せます。

:::note
**状態を変更するコマンド**（表の「変更」が ✅）は履歴に op として記録されます。
記録された op は `montash log` で確認でき、`montash undo` / `montash checkout` で戻せます。
:::

## 共通オプション

以下のオプションはすべてのコマンドで使えます。

| 名前 | 型 | 説明 |
| --- | --- | --- |
| `-C, --project <dir>` | string | プロジェクトディレクトリ（既定: 上位ディレクトリを探索） |
| `--json` | boolean | 機械可読な JSON 出力（`MONTASH_JSON=1` でも可） |
| `-q, --quiet` | boolean | 人間向けの出力を抑制する |
| `-v, --verbose` | boolean | 実行した ffmpeg コマンドと詳細を表示する |
| `--dry-run` | boolean | 書き込まずに何が変わるかだけ表示する |
| `-y, --yes` | boolean | 確認プロンプトにすべて yes と答える |
| `--ffmpeg-path <path>` | string | ffmpeg のパス（`MONTASH_FFMPEG` でも可） |
| `--ffprobe-path <path>` | string | ffprobe のパス（`MONTASH_FFPROBE` でも可） |
| `-m, --message <msg>` | string | この操作をその場でコミットする |
| `--body <text>` | string | コミット本文（`-m` と併用） |
| `--no-color` | boolean | 色付き出力を無効にする |
| `--time-format <fmt>` | `frames` \| `seconds` \| `tc` | 人間向けの時間表記（既定 `seconds`） |

`time` 型は秒（`1.5`）・タイムコード（`00:00:12.500`）・フレーム（`f:45`）で指定できます。相対指定は `+0.5` / `-1` の形です。負の値は `--in=-10` のように `=` で渡してください。

## コマンド一覧

| コマンド | 変更 | 説明 |
| --- | :-: | --- |
| [`montash doctor`](#doctor) |  | ffmpeg / Bun / プラットフォームを点検し、足りない機能とその直し方を表示する |
| [`montash schema`](#schema) |  | 機械可読なコマンド定義を出力する（AI のツール定義用） |
| [`montash init`](#init) |  | project.json と .montash/ を持つ新しいプロジェクトディレクトリを作る |
| [`montash project show`](#project-show) |  | プロジェクト設定・素材／トラック数・タイムライン尺を表示する |
| [`montash project set`](#project-set) | ✅ | プロジェクト設定を変更する（name, default_font, text_engine, background） |
| [`montash validate`](#validate) |  | project.json の不変条件を検査する（参照・範囲・重なり・のりしろ・ギャップ） |
| [`montash import`](#import) | ✅ | 映像・音声・字幕・テキストファイルを取り込む（同時にプロキシ生成も可能） |
| [`montash assets list`](#assets-list) |  | 取り込み済み素材をメタデータ・使用箇所・プロキシ状態つきで一覧する |
| [`montash assets show`](#assets-show) |  | 素材のメタデータと使用箇所を表示する（ffprobe の生データも可） |
| [`montash assets set`](#assets-set) | ✅ | 表示用メタデータ（ラベル・タグ・色・メモ）を設定する。ID は変更できない |
| [`montash assets new-text`](#assets-new-text) | ✅ | assets/text/<id>.txt を作り、再利用できるテキスト素材として登録する |
| [`montash assets set-text`](#assets-set-text) | ✅ | プロジェクト所有のテキスト素材の本文を書き換える |
| [`montash assets remove`](#assets-remove) | ✅ | 素材を削除する（--force を付けると参照しているクリップも削除） |
| [`montash assets relink`](#assets-relink) | ✅ | 行方不明の素材を、パス指定またはディレクトリ探索で新しい場所に再リンクする |
| [`montash proxy build`](#proxy-build) | ✅ | H.264/AAC のプロキシを生成する（サムネイル・波形も任意で生成） |
| [`montash proxy status`](#proxy-status) |  | プロキシ・サムネイル・波形が最新か、未生成か、古いかを報告する |
| [`montash fonts list`](#fonts-list) |  | システムのフォントファミリ・スタイル・ファイルを一覧する（CJK には印が付く） |
| [`montash track add`](#track-add) | ✅ | 映像・音声・テキストのトラックを追加する |
| [`montash track list`](#track-list) |  | トラックを合成順に一覧する |
| [`montash track remove`](#track-remove) | ✅ | トラックを削除する（クリップが残っている場合は --force） |
| [`montash track mute`](#track-mute) | ✅ | トラックをミュートする（映像は非表示、音声は無音） |
| [`montash track lock`](#track-lock) | ✅ | トラックをロックして編集とリップルの対象外にする |
| [`montash track move`](#track-move) | ✅ | トラックの合成順を入れ替える |
| [`montash clip add`](#clip-add) | ✅ | 素材の一部を切り出してタイムラインに置く（映像と音声はリンクされる） |
| [`montash clip list`](#clip-list) |  | クリップをトラック順・時間順に一覧する |
| [`montash clip move`](#clip-move) | ✅ | クリップ（とリンクされた音声）を時間方向または別トラックへ移動する |
| [`montash clip trim`](#clip-trim) | ✅ | クリップのソース in/out を詰める（--ripple で後続も一緒に詰める） |
| [`montash clip split`](#clip-split) | ✅ | タイムライン上の位置でクリップを 2 つに分割する（前半が元の ID を保持） |
| [`montash clip delete`](#clip-delete) | ✅ | クリップを削除する（--ripple で空いた区間を詰める） |
| [`montash clip set`](#clip-set) | ✅ | クリップの単純なプロパティを設定する（速度・ラベル・音量・不透明度） |
| [`montash timeline show`](#timeline-show) |  | トラック・クリップ・タイムライン尺を表示する |
| [`montash timeline gaps`](#timeline-gaps) | ✅ | 映像が無い区間（ギャップ）を一覧し、任意で埋める／詰める |
| [`montash transition add`](#transition-add) | ✅ | 隣り合う 2 クリップの間に xfade トランジションを入れる |
| [`montash transition set`](#transition-set) | ✅ | トランジションの種類・長さ・方式・音声の扱いを変更する |
| [`montash transition remove`](#transition-remove) | ✅ | トランジションを削除する（overlap 方式なら元の間隔に戻す） |
| [`montash transition list`](#transition-list) |  | タイムライン上のトランジションを一覧する |
| [`montash fade`](#fade) | ✅ | トラックまたはクリップの頭をフェードイン、尻をフェードアウトする |
| [`montash text add`](#text-add) | ✅ | テキストトラックにテロップを追加する（無ければ T1 を作る） |
| [`montash text set`](#text-set) | ✅ | テロップの本文・タイミング・スタイルを変更する |
| [`montash text remove`](#text-remove) | ✅ | テロップを削除する |
| [`montash text list`](#text-list) |  | テロップを時間順に一覧する |
| [`montash text presets`](#text-presets) |  | 組み込みおよびプロジェクト固有のテキストスタイルプリセットを一覧する |
| [`montash overlay add`](#overlay-add) | ✅ | 画像または映像を上位の映像トラックにオーバーレイとして置く |
| [`montash overlay set`](#overlay-set) | ✅ | オーバーレイの位置・サイズ・不透明度・フェードを変更する |
| [`montash overlay remove`](#overlay-remove) | ✅ | オーバーレイクリップを削除する |
| [`montash overlay list`](#overlay-list) |  | オーバーレイ（変形情報を持つ映像クリップ）を一覧する |
| [`montash subtitle add`](#subtitle-add) | ✅ | 字幕ファイルをタイムラインに付ける（焼き込み、または選択可能なトラックとして多重化） |
| [`montash subtitle set`](#subtitle-set) | ✅ | 字幕クリップの方式・スタイル・言語・オフセットを変更する |
| [`montash subtitle remove`](#subtitle-remove) | ✅ | 字幕クリップを削除する |
| [`montash subtitle list`](#subtitle-list) |  | 字幕クリップを一覧する |
| [`montash audio gain`](#audio-gain) | ✅ | クリップ・トラック・マスターの音量を dB で設定する |
| [`montash audio fade`](#audio-fade) | ✅ | クリップの音声フェードイン／アウトを設定する |
| [`montash audio duck`](#audio-duck) | ✅ | 別のトラックが鳴っている間、対象トラックを下げる（ダッキング / sidechaincompress） |
| [`montash audio duck remove`](#audio-duck-remove) | ✅ | ダッキング設定を ID 指定で削除する |
| [`montash audio normalize`](#audio-normalize) | ✅ | 書き出し時に適用するラウドネス正規化を設定する（2 パス loudnorm） |
| [`montash audio offset`](#audio-offset) | ✅ | クリップの音声をサンプル単位でずらす（フレーム未満の同期補正） |
| [`montash audio analyze`](#audio-analyze) |  | トラック・クリップ・素材の統合ラウドネス、ピーク、無音区間を測定する |
| [`montash audio show`](#audio-show) |  | 音量・フェード・ダッキング・正規化の設定を一覧する |
| [`montash serve`](#serve) |  | ローカルの Web プレビューサーバを起動する（Ctrl-C で停止） |
| [`montash preview build`](#preview-build) |  | タイムラインのプレビュー MP4 を生成する（映像はセグメントキャッシュ、音声は 1 パス） |
| [`montash preview status`](#preview-status) |  | プレビューが最新かどうかと、生成中の進捗を表示する |
| [`montash render`](#render) |  | render the timeline and verify the exact frame count |
| [`montash render verify`](#render-verify) |  | フレーム数・FPS・音声長・ストリーム構成を検証する |
| [`montash render presets`](#render-presets) |  | list the encoding presets (built-in and project.render_presets) |
| [`montash render batch`](#render-batch) |  | render the same timeline with several presets into one directory |
| [`montash render still`](#render-still) |  | write one frame of the timeline as a PNG/JPEG |
| [`montash render gif`](#render-gif) |  | write a range of the timeline as an animated GIF (palettegen/paletteuse) |
| [`montash render audio`](#render-audio) |  | write the mixed audio of the timeline (no video) |
| [`montash status`](#status) |  | HEAD、未コミットの op、直前のコミット、タグを表示する |
| [`montash log`](#log) |  | コミットを新しい順に一覧する（--ops で各コミットの op も展開） |
| [`montash show`](#show) |  | op / コミット / タグの詳細を表示する（--patch で JSON Patch 全体も表示） |
| [`montash diff`](#diff) |  | 履歴の 2 点間の差分を表示する（既定は直前のコミット → HEAD、つまり未コミット分） |
| [`montash blame`](#blame) |  | show the op / commit / actor that last changed an element (clip, text, transition, asset) |
| [`montash commit`](#commit) |  | 未コミットの op をまとめ、人が読めるメッセージ（-m）を付けてコミットする |
| [`montash checkout`](#checkout) | ✅ | HEAD を op / コミット / タグへ移し、その状態を project.json に展開する |
| [`montash undo`](#undo) | ✅ | HEAD を n 個（既定 1）前の op に戻し、その状態を project.json に展開する |
| [`montash redo`](#redo) | ✅ | 直近に使った系列に沿って HEAD を n 個（既定 1）先に進める |
| [`montash revert`](#revert) | ✅ | apply the inverse of a commit or op as a new op (does not rewrite history) |
| [`montash reset`](#reset) | ✅ | move HEAD to a ref and drop the ops after it from the default `log` view (--hard) |
| [`montash tag`](#tag) | ✅ | 現在の HEAD（または指定した op / コミット）に名前を付け、あとで checkout できるようにする |
| [`montash tag list`](#tag-list) |  | タグを一覧する |
| [`montash tag delete`](#tag-delete) | ✅ | タグを削除する（指している履歴自体は残る） |
| [`montash history verify`](#history-verify) |  | 履歴の整合性を検証する（オブジェクトのハッシュ、op DAG の連続性、コミット、タグ、移動ログ） |
| [`montash history prune`](#history-prune) |  | delete old uncommitted ops and objects that nothing references |
| [`montash history export`](#history-export) |  | export ops, commits, moves, tags and objects as one JSONL file (audit / backup) |
| [`montash history import`](#history-import) | ✅ | import a history exported with `history export` (restores ops, commits, tags and objects) |
| [`montash ids rebuild`](#ids-rebuild) |  | project.json と全履歴オブジェクトから .montash/ids.json の採番カウンタを作り直す |

## `montash doctor`

ffmpeg / Bun / プラットフォームを点検し、足りない機能とその直し方を表示する

```bash
montash doctor [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--fix-hints` | boolean | `false` | also run scripts/install-deps.sh --check --json and merge its result |

### 例

```bash
montash doctor --json
```

## `montash schema`

機械可読なコマンド定義を出力する（AI のツール定義用）

```bash
montash schema [command] [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `command` | string |  | command path, e.g. "clip trim" (default: all) |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--format` | `json` \| `anthropic-tools` \| `openai-tools` | `json` | output format |

### 例

```bash
# all commands as JSON
montash schema --json
# LLM tool definitions
montash schema --format anthropic-tools > tools.json
montash schema "clip trim" --json
```

## `montash init`

project.json と .montash/ を持つ新しいプロジェクトディレクトリを作る

```bash
montash init <dir> [options]
```

fps and resolution become the project's base units: all times are stored as integer frames of this fps.

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `dir` | string | ✅ | project directory to create ("." for the current directory) |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--fps` | string |  | frame rate: 23.976 \| 24 \| 25 \| 29.97 \| 30 \| 50 \| 59.94 \| 60, or a fraction like 30000/1001 (default 30) |
| `--resolution` | string |  | canvas size WIDTHxHEIGHT, even pixels (default 1920x1080) |
| `--sample-rate` | number | `48000` | audio sample rate |
| `--channels` | number | `2` | audio channels |
| `--name` | string |  | project name (default: directory name) |
| `--template` | `youtube-1080p30` \| `youtube-4k30` \| `reel-1080x1920-30` \| `cinema-24` \| `broadcast-2997` |  | preset for fps/resolution (explicit --fps/--resolution override it) |
| `--force` | boolean | `false` | overwrite an existing project.json (discards the existing project and its history) |

### 例

```bash
montash init my-vlog --fps 30 --resolution 1920x1080 --sample-rate 48000
# 29.97 is stored as 30000/1001
montash init my-vlog --fps 29.97 --json
montash init shorts --template reel-1080x1920-30
```

## `montash project show`

プロジェクト設定・素材／トラック数・タイムライン尺を表示する

```bash
montash project show
```

### 例

```bash
montash project show --json
```

## `montash project set`

プロジェクト設定を変更する（name, default_font, text_engine, background）

```bash
montash project set <key> <value>
```

fps / resolution / sample_rate / channels require re-snapping every _f/_smp field and are not implemented yet (M1).

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `key` | string | ✅ | setting key: name \| default_font \| text_engine \| background \| fps \| resolution \| sample_rate \| channels |
| `value` | string | ✅ | new value |

### 例

```bash
montash project set name "summer-trip"
montash project set default_font "Noto Sans CJK JP"
montash project set text_engine drawtext
```

## `montash validate`

project.json の不変条件を検査する（参照・範囲・重なり・のりしろ・ギャップ）

```bash
montash validate [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--deep` | boolean | `false` | also check that asset files exist (ffmpeg decode check: not implemented yet) |
| `--strict` | boolean | `false` | treat gaps and fps/resolution mismatches as errors |

### 例

```bash
montash validate --json
montash validate --deep --strict
```

## `montash import`

映像・音声・字幕・テキストファイルを取り込む（同時にプロキシ生成も可能）

```bash
montash import <paths...> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `paths...` | string | ✅ | files or directories (recursive) |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--id` | string |  | explicit ID (one file only) |
| `--copy` | boolean | `false` | copy into project assets/ |
| `--proxy` | boolean | `false` | build video/audio proxies |
| `--strict` | boolean | `false` | abort without importing if any input fails |

## `montash assets list`

取り込み済み素材をメタデータ・使用箇所・プロキシ状態つきで一覧する

```bash
montash assets list [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--type` | `video` \| `audio` \| `image` \| `subtitle` \| `text` |  | asset type |
| `--tag` | string |  | filter by tag |
| `--unused` | boolean |  | only unused assets |
| `--missing` | boolean |  | only missing source files |
| `--search` | string |  | search ID, label and path |

## `montash assets show`

素材のメタデータと使用箇所を表示する（ffprobe の生データも可）

```bash
montash assets show <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | asset ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--probe` | boolean |  | include raw ffprobe JSON |

## `montash assets set`

表示用メタデータ（ラベル・タグ・色・メモ）を設定する。ID は変更できない

```bash
montash assets set <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | asset ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--label` | string |  | display label (empty string clears it) |
| `--tags` | string |  | replace all tags (comma separated) |
| `--add-tag` | array |  | add a tag (repeatable) |
| `--remove-tag` | array |  | remove a tag (repeatable) |
| `--color` | string |  | hex color such as #3B82F6 (empty string clears it) |
| `--note` | string |  | free-form note (empty string clears it) |

### 例

```bash
montash assets set clip_a --label "冒頭ドローン" --tags 空撮,冒頭
```

## `montash assets new-text`

assets/text/<id>.txt を作り、再利用できるテキスト素材として登録する

```bash
montash assets new-text <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | new asset ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--text` | string |  | text body |
| `--text-file` | string |  | read the body from a UTF-8 file |
| `--label` | string |  | display label |
| `--tags` | string |  | tags (comma separated) |

### 例

```bash
montash assets new-text title_main --text "Summer Trip 2026"
```

## `montash assets set-text`

プロジェクト所有のテキスト素材の本文を書き換える

```bash
montash assets set-text <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | text asset ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--text` | string |  | new text body |
| `--text-file` | string |  | read the new body from a UTF-8 file |

### 例

```bash
montash assets set-text title_main --text "Summer Trip 2027"
```

## `montash assets remove`

素材を削除する（--force を付けると参照しているクリップも削除）

```bash
montash assets remove <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | asset ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--force` | boolean |  | also delete referencing clips, linked clips and transitions |

### 例

```bash
montash assets remove clip_x
montash assets remove clip_x --force
```

## `montash assets relink`

行方不明の素材を、パス指定またはディレクトリ探索で新しい場所に再リンクする

```bash
montash assets relink [id] [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string |  | asset ID (default: every missing asset) |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--path` | string |  | new file path (requires an asset ID) |
| `--search` | string |  | directory to search recursively |
| `--match` | `name` \| `size` \| `hash` |  | matching rule to try first (default order: name, size, hash) |

### 例

```bash
montash assets relink --search /Volumes/ext/raw --json
montash assets relink clip_a --path /Volumes/ext/raw/clip_a.mp4
```

## `montash proxy build`

H.264/AAC のプロキシを生成する（サムネイル・波形も任意で生成）

```bash
montash proxy build [ids...] [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `ids...` | string |  | asset IDs |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--all` | boolean |  | all assets that can have a proxy or the requested derivatives |
| `--force` | boolean |  | rebuild ready proxies |
| `--height` | number |  | even video height (default: project setting) |
| `--thumbs` | boolean |  | also build the thumbnail sprite (video and image assets) |
| `--waveform` | boolean |  | also build the waveform (audio, and video with sound) |
| `--parallel` | number | `2` | number of workers |

### 例

```bash
# W-02: proxies and browsable previews
montash proxy build --all --thumbs --waveform
```

## `montash proxy status`

プロキシ・サムネイル・波形が最新か、未生成か、古いかを報告する

```bash
montash proxy status
```

## `montash fonts list`

システムのフォントファミリ・スタイル・ファイルを一覧する（CJK には印が付く）

```bash
montash fonts list [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--filter` | string |  | case-insensitive substring match on the family name |

### 例

```bash
montash fonts list --json
montash fonts list --filter "Noto Sans"
```

## `montash track add`

映像・音声・テキストのトラックを追加する

```bash
montash track add --kind <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--kind` | `video` \| `audio` \| `text` |  | track kind（必須） |
| `--name` | string |  | track name / ID (default: V2, A2, T1 ...) |
| `--above` | string |  | insert above this track (later in the compositing order) |
| `--below` | string |  | insert below this track |

### 例

```bash
montash track add --kind video --above V1
```

## `montash track list`

トラックを合成順に一覧する

```bash
montash track list
```

## `montash track remove`

トラックを削除する（クリップが残っている場合は --force）

```bash
montash track remove <name> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `name` | string | ✅ | track ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--force` | boolean |  | remove the track and its clips |

## `montash track mute`

トラックをミュートする（映像は非表示、音声は無音）

```bash
montash track mute <name> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `name` | string | ✅ | track ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--off` | boolean |  | turn muted off again |

## `montash track lock`

トラックをロックして編集とリップルの対象外にする

```bash
montash track lock <name> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `name` | string | ✅ | track ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--off` | boolean |  | turn locked off again |

## `montash track move`

トラックの合成順を入れ替える

```bash
montash track move <name> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `name` | string | ✅ | track ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--above` | string |  | move above this track |
| `--below` | string |  | move below this track |

## `montash clip add`

素材の一部を切り出してタイムラインに置く（映像と音声はリンクされる）

```bash
montash clip add --asset <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--asset` | string |  | asset ID（必須） |
| `--track` | string |  | target track (V1 for video, A1 for audio) |
| `--in` | time |  | source in point; negative means from asset end |
| `--out` | time |  | source out point |
| `--duration` | time |  | duration instead of --out |
| `--at` | time |  | timeline position (default: end) |
| `--after` | string |  | place immediately after a clip |
| `--before` | string |  | place immediately before a clip in a free interval |
| `--video-only` | boolean |  | place video without linked audio |
| `--audio-only` | boolean |  | place audio only |
| `--id` | string |  | explicit primary clip ID |
| `--label` | string |  | clip label |
| `--on-overlap` | `error` | `error` | overlap policy (M1: error) |

## `montash clip list`

クリップをトラック順・時間順に一覧する

```bash
montash clip list [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--track` | string |  | track ID |
| `--asset` | string |  | asset ID |

## `montash clip move`

クリップ（とリンクされた音声）を時間方向または別トラックへ移動する

```bash
montash clip move <id> [options]
```

Use --ripple to close the gap left behind and push the destination's following clips; that is how clips are reordered (docs/04 §6a).

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | clip ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--to` | time |  | absolute timeline position |
| `--by` | time |  | signed timeline offset (+0.5, -f:15) |
| `--before` | string |  | place immediately before this clip |
| `--after` | string |  | place immediately after this clip |
| `--track` | string |  | destination track |
| `--on-overlap` | `error` \| `overwrite` \| `push` | `error` | what to do when the destination is occupied |
| `--ripple` | string |  | ripple following elements: --ripple (all tracks), --ripple=all, --ripple=track |
| `--unlink` | boolean |  | detach the linked audio/video clip and edit this clip alone |

### 例

```bash
# reorder: put c3 in front of c2
montash clip move c3 --before c2 --ripple
montash clip move c2 --by +f:15
```

## `montash clip trim`

クリップのソース in/out を詰める（--ripple で後続も一緒に詰める）

```bash
montash clip trim <id> [options]
```

--in +0.5 cuts half a second off the head, --out -1 a second off the tail. Without --ripple the clip keeps its start_f and leaves a gap (W_GAP_CREATED).

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | clip ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--in` | time |  | source in point (absolute or ±relative) |
| `--out` | time |  | source out point (absolute or ±relative) |
| `--start` | time |  | timeline start position |
| `--ripple` | string |  | ripple following elements: --ripple (all tracks), --ripple=all, --ripple=track |
| `--unlink` | boolean |  | detach the linked audio/video clip and edit this clip alone |

### 例

```bash
# cut 0.5s off the head and close the gap
montash clip trim c2 --in +0.5 --ripple
```

## `montash clip split`

タイムライン上の位置でクリップを 2 つに分割する（前半が元の ID を保持）

```bash
montash clip split <id> --at <string> [options]
```

ADR-12: the first half keeps the original ID; only the second half gets a new one (read it from result.created.id).

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | clip ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--at` | time |  | timeline position to split at（必須） |
| `--new-id` | string |  | explicit ID for the second half |
| `--unlink` | boolean |  | detach the linked audio/video clip and edit this clip alone |

### 例

```bash
montash clip split c1 --at 00:00:08.000 --json
```

## `montash clip delete`

クリップを削除する（--ripple で空いた区間を詰める）

```bash
montash clip delete <ids...> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `ids...` | string | ✅ | clip IDs |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--ripple` | string |  | ripple following elements: --ripple (all tracks), --ripple=all, --ripple=track |
| `--unlink` | boolean |  | detach the linked audio/video clip and edit this clip alone |

### 例

```bash
montash clip delete c5 --ripple
```

## `montash clip set`

クリップの単純なプロパティを設定する（速度・ラベル・音量・不透明度）

```bash
montash clip set <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | clip ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--speed` | number |  | playback speed (1 = normal, 1.5 = faster) |
| `--pitch-keep` | boolean |  | keep the original pitch when changing speed |
| `--label` | string |  | human readable label |
| `--volume` | number |  | audio gain in dB |
| `--opacity` | number |  | video opacity, 0..1 |
| `--ripple` | string |  | ripple following elements: --ripple (all tracks), --ripple=all, --ripple=track |
| `--unlink` | boolean |  | detach the linked audio/video clip and edit this clip alone |

### 例

```bash
montash clip set c2 --speed 1.5 --pitch-keep --ripple
```

## `montash timeline show`

トラック・クリップ・タイムライン尺を表示する

```bash
montash timeline show [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--from` | time |  | range start |
| `--to` | time |  | range end |
| `--ascii` | boolean |  | show a compact timeline |

## `montash timeline gaps`

映像が無い区間（ギャップ）を一覧し、任意で埋める／詰める

```bash
montash timeline gaps [options]
```

--fill close removes the gaps by rippling everything after them (all tracks); --fill black inserts a background clip.

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--fill` | `close` \| `black` \| `hold` |  | how to fill the gaps |
| `--track` | string |  | video track to put --fill black clips on (default: the first free one) |

### 例

```bash
montash timeline gaps --json
montash timeline gaps --fill close
```

## `montash transition add`

隣り合う 2 クリップの間に xfade トランジションを入れる

```bash
montash transition add --type <string> --duration <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--between` | array |  | the two clip IDs to join: --between c1 c2 |
| `--track` | string |  | track ID (with --all-cuts or --at-cut) |
| `--all-cuts` | boolean |  | add one transition at every cut on --track |
| `--at-cut` | time |  | add one transition at the cut on this timeline position |
| `--type` | string |  | xfade transition name (fade, dissolve, wipeleft, circleopen ...)（必須） |
| `--duration` | time |  | transition length（必須） |
| `--mode` | `handle` \| `overlap` | `handle` | how the overlap is produced |
| `--audio` | `crossfade` \| `cut` | `crossfade` | linked audio handling |
| `--id` | string |  | explicit transition ID |

### 例

```bash
montash transition add --track V1 --all-cuts --type crossfade --duration 0.5
montash transition add --between c1 c2 --type wipeleft --duration f:12
```

## `montash transition set`

トランジションの種類・長さ・方式・音声の扱いを変更する

```bash
montash transition set <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | transition ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--type` | string |  | xfade transition name |
| `--duration` | time |  | transition length |
| `--mode` | `handle` \| `overlap` |  | handle or overlap |
| `--audio` | `crossfade` \| `cut` |  | crossfade or cut |

### 例

```bash
montash transition set t2 --type wipeleft --duration 0.8
```

## `montash transition remove`

トランジションを削除する（overlap 方式なら元の間隔に戻す）

```bash
montash transition remove <id>
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | transition ID |

## `montash transition list`

タイムライン上のトランジションを一覧する

```bash
montash transition list [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--track` | string |  | only this track |

## `montash fade`

トラックまたはクリップの頭をフェードイン、尻をフェードアウトする

```bash
montash fade [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--track` | string |  | track ID (default: the lowest video track) |
| `--clip` | string |  | clip ID instead of a whole track |
| `--in` | time |  | fade-in length |
| `--out` | time |  | fade-out length |
| `--color` | `black` \| `white` | `black` | fade colour |
| `--with-audio` | boolean |  | apply the same fade to the linked audio |

### 例

```bash
montash fade --track V1 --in 1.0 --out 2.0 --with-audio
```

## `montash text add`

テキストトラックにテロップを追加する（無ければ T1 を作る）

```bash
montash text add [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--text` | string |  | text body (\n for line breaks) |
| `--text-file` | string |  | read the body from a UTF-8 file |
| `--asset` | string |  | text asset ID (the body is read at render time) |
| `--at` | time |  | timeline position (default: end of the track) |
| `--duration` | time |  | how long the text stays on screen |
| `--until` | time |  | end position instead of --duration |
| `--track` | string |  | text track (default: the first text track, else a new T1) |
| `--preset` | string |  | style preset (title-center, lower-third, caption-bottom, corner-tag or a project preset) |
| `--font` | string |  | font family (default: settings.default_font, then a CJK font) |
| `--size` | number |  | font size in px (project resolution basis) |
| `--color` | string |  | text color #RRGGBB[AA] |
| `--bg` | string |  | background box color #RRGGBB[AA], or none |
| `--bg-padding` | number |  | background box padding in px |
| `--position` | string |  | position preset (center, middle-center, middle-left, middle-right, top-left, top-center, top-right, bottom-left, bottom-center, bottom-right), "x,y" or "x%,y%" |
| `--align` | `left` \| `center` \| `right` |  | line alignment |
| `--line-spacing` | number |  | extra line spacing in px |
| `--wrap` | boolean |  | automatic line wrapping (--no-wrap to disable) |
| `--fade-in` | time |  | fade in duration |
| `--fade-out` | time |  | fade out duration |
| `--shadow` | string |  | drop shadow "x,y,#RRGGBB[AA]" (or none) |
| `--outline` | string |  | outline "px,#RRGGBB[AA]" (or none) |
| `--bold` | boolean |  | bold |
| `--italic` | boolean |  | italic |
| `--markup` | `plain` \| `ass` |  | plain escapes { } \; ass passes override tags through |
| `--id` | string |  | explicit clip ID (default: the next x<N>) |

### 例

```bash
montash text add --text "Summer Trip 2026" --at 0 --duration 3 --preset title-center
montash text add --text "福岡到着" --at 12 --duration 3 --preset lower-third --size 48
```

## `montash text set`

テロップの本文・タイミング・スタイルを変更する

```bash
montash text set <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | text clip ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--text` | string |  | text body (\n for line breaks) |
| `--text-file` | string |  | read the body from a UTF-8 file |
| `--asset` | string |  | text asset ID (the body is read at render time) |
| `--at` | time |  | move to this timeline position |
| `--duration` | time |  | new duration |
| `--until` | time |  | new end position |
| `--preset` | string |  | style preset (title-center, lower-third, caption-bottom, corner-tag or a project preset) |
| `--font` | string |  | font family (default: settings.default_font, then a CJK font) |
| `--size` | number |  | font size in px (project resolution basis) |
| `--color` | string |  | text color #RRGGBB[AA] |
| `--bg` | string |  | background box color #RRGGBB[AA], or none |
| `--bg-padding` | number |  | background box padding in px |
| `--position` | string |  | position preset (center, middle-center, middle-left, middle-right, top-left, top-center, top-right, bottom-left, bottom-center, bottom-right), "x,y" or "x%,y%" |
| `--align` | `left` \| `center` \| `right` |  | line alignment |
| `--line-spacing` | number |  | extra line spacing in px |
| `--wrap` | boolean |  | automatic line wrapping (--no-wrap to disable) |
| `--fade-in` | time |  | fade in duration |
| `--fade-out` | time |  | fade out duration |
| `--shadow` | string |  | drop shadow "x,y,#RRGGBB[AA]" (or none) |
| `--outline` | string |  | outline "px,#RRGGBB[AA]" (or none) |
| `--bold` | boolean |  | bold |
| `--italic` | boolean |  | italic |
| `--markup` | `plain` \| `ass` |  | plain escapes { } \; ass passes override tags through |

### 例

```bash
montash text set x1 --text "福岡に到着" --position 5%,85%
```

## `montash text remove`

テロップを削除する

```bash
montash text remove <id>
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | text clip ID |

## `montash text list`

テロップを時間順に一覧する

```bash
montash text list [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--track` | string |  | limit to one text track |

## `montash text presets`

組み込みおよびプロジェクト固有のテキストスタイルプリセットを一覧する

```bash
montash text presets
```

## `montash overlay add`

画像または映像を上位の映像トラックにオーバーレイとして置く

```bash
montash overlay add --asset <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--asset` | string |  | asset ID (video or image)（必須） |
| `--track` | string |  | target video track; created if missing (default: one above the top one) |
| `--at` | time |  | timeline position (default: 0) |
| `--duration` | time |  | overlay duration (`timeline` for the whole timeline) |
| `--until` | time |  | timeline position to stop at, instead of --duration |
| `--in` | time |  | source in point |
| `--position` | string |  | preset (top-right ...), or x,y / x%,y% coordinates |
| `--margin` | string |  | margin from the edge in px or % (presets only) |
| `--scale` | string |  | size as a ratio (0.12) or a box (320x180) |
| `--opacity` | number |  | opacity, 0..1 |
| `--fade-in` | time |  | fade in duration |
| `--fade-out` | time |  | fade out duration |
| `--keep-alpha` | boolean |  | keep the source alpha channel (alpha PNG / ProRes 4444) |
| `--id` | string |  | explicit clip ID |
| `--label` | string |  | clip label |

### 例

```bash
# W-08: put a logo in the top-right corner for the whole timeline
montash overlay add --asset logo --track V2 --at 0 --duration timeline --position top-right --scale 0.12 --opacity 0.9
```

## `montash overlay set`

オーバーレイの位置・サイズ・不透明度・フェードを変更する

```bash
montash overlay set <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | overlay clip ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--position` | string |  | preset (top-right ...), or x,y / x%,y% coordinates |
| `--margin` | string |  | margin from the edge in px or % (presets only) |
| `--scale` | string |  | size as a ratio (0.12) or a box (320x180) |
| `--opacity` | number |  | opacity, 0..1 |
| `--fade-in` | time |  | fade in duration |
| `--fade-out` | time |  | fade out duration |
| `--keep-alpha` | boolean |  | keep the source alpha channel (alpha PNG / ProRes 4444) |

### 例

```bash
montash overlay set c3 --position bottom-right --scale 0.3
```

## `montash overlay remove`

オーバーレイクリップを削除する

```bash
montash overlay remove <id>
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | overlay clip ID |

## `montash overlay list`

オーバーレイ（変形情報を持つ映像クリップ）を一覧する

```bash
montash overlay list [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--track` | string |  | only this track |

## `montash subtitle add`

字幕ファイルをタイムラインに付ける（焼き込み、または選択可能なトラックとして多重化）

```bash
montash subtitle add --asset <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--asset` | string |  | subtitle asset ID (srt, vtt or ass)（必須） |
| `--mode` | `burn` \| `soft` | `burn` | burn into the picture, or mux as a selectable track |
| `--at` | time |  | timeline position of the first cue (default 0) |
| `--track` | string |  | text track (default: the first text track, else a new T1) |
| `--font` | string |  | font family (default: settings.default_font, then a CJK font) |
| `--size` | number |  | font size in px (project resolution basis) |
| `--color` | string |  | text color #RRGGBB[AA] |
| `--margin-bottom` | number |  | distance from the bottom edge in px |
| `--lang` | string |  | language tag stored on the clip (soft subtitles: ISO 639) |
| `--offset` | time |  | shift every cue by ±t |
| `--id` | string |  | explicit clip ID (default: the next s<N>) |

### 例

```bash
montash subtitle add --asset ja_srt --mode burn --font "Noto Sans CJK JP" --size 40 --margin-bottom 60
montash subtitle add --asset ja_srt --mode soft --lang ja
```

## `montash subtitle set`

字幕クリップの方式・スタイル・言語・オフセットを変更する

```bash
montash subtitle set <id> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | subtitle clip ID |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--asset` | string |  | point at another subtitle asset |
| `--mode` | `burn` \| `soft` |  | burn or soft |
| `--font` | string |  | font family (default: settings.default_font, then a CJK font) |
| `--size` | number |  | font size in px (project resolution basis) |
| `--color` | string |  | text color #RRGGBB[AA] |
| `--margin-bottom` | number |  | distance from the bottom edge in px |
| `--lang` | string |  | language tag stored on the clip (soft subtitles: ISO 639) |
| `--offset` | time |  | shift every cue by ±t |

### 例

```bash
montash subtitle set s1 --mode soft --lang ja
```

## `montash subtitle remove`

字幕クリップを削除する

```bash
montash subtitle remove <id>
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | subtitle clip ID |

## `montash subtitle list`

字幕クリップを一覧する

```bash
montash subtitle list [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--track` | string |  | limit to one text track |

## `montash audio gain`

クリップ・トラック・マスターの音量を dB で設定する

```bash
montash audio gain --db <number> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--clip` | string |  | clip ID |
| `--track` | string |  | audio track ID |
| `--master` | boolean |  | the master bus (project.audio.master_gain_db) |
| `--db` | number |  | gain in dB (negative lowers the level)（必須） |

### 例

```bash
# lower the BGM by 12 dB
montash audio gain --clip c_bgm --db=-12
```

## `montash audio fade`

クリップの音声フェードイン／アウトを設定する

```bash
montash audio fade --clip <string> [options]
```

Track-wide fades are `montash fade --track A1`; this sets the clip's own afade (docs/07 §8.1).

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--clip` | string |  | clip ID（必須） |
| `--in` | time |  | fade-in length |
| `--out` | time |  | fade-out length |
| `--curve` | `tri` \| `exp` \| `log` \| `qsin` \| `hsin` \| `esin` |  | afade curve |

### 例

```bash
montash audio fade --clip c_bgm --out 2.0
```

## `montash audio duck`

別のトラックが鳴っている間、対象トラックを下げる（ダッキング / sidechaincompress）

```bash
montash audio duck --target <string> [options]
```

The target is compressed by the sidechain track's level (docs/07 §8.3). --simple falls back to a silencedetect + volume automation for ffmpeg builds without sidechaincompress.

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--target` | string |  | track to duck (the BGM)（必須） |
| `--sidechain` | string |  | track that triggers the ducking (the dialogue) |
| `--threshold` | string | `-30dB` | level above which the sidechain ducks (dB) |
| `--ratio` | number | `8` | compression ratio |
| `--attack` | string | `20ms` | attack time (ms, or 0.02s) |
| `--release` | string | `500ms` | release time (ms, or 0.5s) |
| `--makeup` | number | `0` | makeup gain in dB |
| `--id` | string |  | explicit ducking ID |
| `--simple` | boolean |  | use the silencedetect + volume fallback |
| `--off` | boolean |  | remove the ducking on --target instead of adding one |

### 例

```bash
montash audio duck --target A2 --sidechain A1 --threshold -30dB --ratio 8 --release 0.5
montash audio duck --target A2 --off
```

## `montash audio duck remove`

ダッキング設定を ID 指定で削除する

```bash
montash audio duck remove <id>
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `id` | string | ✅ | ducking ID |

### 例

```bash
montash audio duck remove d1
```

## `montash audio normalize`

書き出し時に適用するラウドネス正規化を設定する（2 パス loudnorm）

```bash
montash audio normalize [options]
```

Stored in project.audio.normalize. `montash render` measures the timeline first and applies a linear correction (docs/07 §8.4); preview keeps the source levels.

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--loudness` | number |  | target integrated loudness in LUFS (default -14) |
| `--true-peak` | number |  | target true peak in dBTP (default -1) |
| `--lra` | number |  | target loudness range in LU (default 11) |
| `--off` | boolean |  | disable normalization |

### 例

```bash
montash audio normalize --loudness=-14 --true-peak=-1
```

## `montash audio offset`

クリップの音声をサンプル単位でずらす（フレーム未満の同期補正）

```bash
montash audio offset --clip <string> [options]
```

Linked clips must be unlinked first (`montash clip unlink`), otherwise E_CLIP_LINKED. Shifts of a frame or more belong to `clip move` (docs/04 §11).

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--clip` | string |  | clip ID（必須） |
| `--by` | string |  | relative shift: s:-960 (samples), -0.02 (seconds), +f:1 (frames) |
| `--set` | string |  | absolute offset in samples (s:480) |

### 例

```bash
montash audio offset --clip c2 --by s:-960
```

## `montash audio analyze`

トラック・クリップ・素材の統合ラウドネス、ピーク、無音区間を測定する

```bash
montash audio analyze [target] [options]
```

Runs one audio-only ffmpeg pass (ebur128 / volumedetect / silencedetect). Reads only (docs/04 §11).

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `target` | string |  | track ID (A1) or clip ID (c2) |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--asset` | string |  | analyze an asset file instead of the timeline |
| `--noise-db` | number |  | silence threshold in dBFS (default -40) |
| `--min-silence` | number |  | shortest silence to report, in seconds (default 0.3) |

### 例

```bash
montash audio analyze A1 --json
```

## `montash audio show`

音量・フェード・ダッキング・正規化の設定を一覧する

```bash
montash audio show
```

### 例

```bash
montash audio show --json
```

## `montash serve`

ローカルの Web プレビューサーバを起動する（Ctrl-C で停止）

```bash
montash serve [options]
```

Serves the web UI, read-only APIs and a WebSocket that pushes project.json / history changes. Web actions run `montash` as a child process (MONTASH_ACTOR=web) restricted by an allowlist.

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--port` | number | `7788` | TCP port (0 = random) |
| `--host` | string | `127.0.0.1` | bind address. Non-loopback forces --read-only |
| `--open` | boolean | `false` | open the URL in the default browser |
| `--read-only` | boolean | `false` | disable POST /api/cli (viewing only) |
| `--dev` | boolean | `false` | serve web/index.html via Bun's HTML import with HMR instead of web/dist |
| `--watch` | boolean | `true` | watch project.json and history (use --no-watch to disable) |
| `--auto-preview` | boolean | `true` | automatically rebuild preview (use --no-auto-preview to disable) |
| `--daemon` | boolean | `false` | run in the background (not implemented yet) |

### 例

```bash
# start and open the browser
montash serve --open
montash serve --port 8080 --read-only
# frontend development with HMR
montash serve --dev
```

## `montash preview build`

タイムラインのプレビュー MP4 を生成する（映像はセグメントキャッシュ、音声は 1 パス）

```bash
montash preview build [options]
```

Video is split at frame boundaries and cached under .montash/preview/segments/, audio is rendered in one pass to audio.m4a, and both are muxed with -c copy into .montash/preview/timeline.mp4 (docs/07 §11).

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--from` | time |  | rebuild segments from this time |
| `--to` | time |  | rebuild segments up to this time |
| `--force` | boolean |  | rebuild even when the preview is up to date |
| `--audio-only` | boolean |  | render audio.m4a only (docs/07 §11.2) |
| `--height` | number |  | even output height (default: project proxy height) |

### 例

```bash
# incremental rebuild
montash preview build
# regenerate one range
montash preview build --from 10 --to 20 --json
```

## `montash preview status`

プレビューが最新かどうかと、生成中の進捗を表示する

```bash
montash preview status
```

## `montash render`

render the timeline and verify the exact frame count

```bash
montash render --output <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `-o, --output` | string |  | output path（必須） |
| `--preset` | string |  | encoding preset (default youtube-1080p; see `render presets`) |
| `--resolution` | string |  | override output WxH |
| `--crf` | number |  | H.264/H.265 quality (0..51) |
| `--preset-speed` | `ultrafast` \| `superfast` \| `veryfast` \| `faster` \| `fast` \| `medium` \| `slow` \| `slower` \| `veryslow` |  | x264/x265 encoding speed |
| `--vcodec` | string |  | override the video encoder |
| `--vbitrate` | string |  | target video bitrate (8M); switches off CRF |
| `--acodec` | string |  | override the audio encoder |
| `--abitrate` | string |  | audio bitrate (192k) |
| `--pix-fmt` | string |  | override the pixel format |
| `--fps` | number |  | output frame rate (re-times the output; verification is skipped) |
| `--reframe` | string |  | crop anchor when the output aspect differs from the timeline: center\|left\|right\|<x>% (default: letterbox) |
| `--hwaccel` | `auto` \| `none` \| `videotoolbox` \| `nvenc` \| `vaapi` \| `qsv` |  | hardware encoder |
| `--two-pass` | boolean |  | two-pass encoding (libx264/libx265 with --vbitrate) |
| `--threads` | number |  | encoder threads |
| `--overwrite` | boolean |  | replace an existing output after successful verification |
| `--progress` | `text` \| `jsonl` \| `none` | `text` | progress output |
| `--last` | boolean |  | reuse the options of the previous render (.montash/render/last.json) |

### 例

```bash
montash render -o out/final.mp4 --preset youtube-1080p
montash render -o out/reel.mp4 --preset instagram-reel --reframe center
# same settings as last time
montash render --last -o out/v2.mp4
```

## `montash render verify`

フレーム数・FPS・音声長・ストリーム構成を検証する

```bash
montash render verify <path>
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `path` | string | ✅ | rendered MP4 |

## `montash render presets`

list the encoding presets (built-in and project.render_presets)

```bash
montash render presets
```

### 例

```bash
montash render presets --json
```

## `montash render batch`

render the same timeline with several presets into one directory

```bash
montash render batch --preset <array> --output <string> [options]
```

Each output is named <project>_<preset><ext>. Per-preset options: --preset name:--opt=value[,--opt2=v].

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--preset` | array |  | preset name, optionally with options (repeatable)（必須） |
| `-o, --output` | string |  | output directory（必須） |
| `--parallel` | number | `1` | how many renders to run at once |
| `--overwrite` | boolean |  | replace existing outputs |
| `--progress` | `text` \| `jsonl` \| `none` | `text` | progress output |

### 例

```bash
montash render batch --preset youtube-1080p --preset web-preview -o out/
montash render batch --preset instagram-reel:--reframe=center --preset web-preview -o out/
```

## `montash render still`

write one frame of the timeline as a PNG/JPEG

```bash
montash render still --output <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `-o, --output` | string |  | output image path (.png / .jpg)（必須） |
| `--at` | time | `0` | timeline position (12.5 / 00:00:12.500 / f:375 / end-1) |
| `--resolution` | string |  | override output WxH |
| `--reframe` | string |  | crop anchor: center\|left\|right\|<x>% |
| `--overwrite` | boolean |  | replace an existing file |

### 例

```bash
montash render still --at 00:00:03.000 -o out/thumb.png
```

## `montash render gif`

write a range of the timeline as an animated GIF (palettegen/paletteuse)

```bash
montash render gif --output <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `-o, --output` | string |  | output .gif path（必須） |
| `--from` | time |  | range start (default 0) |
| `--to` | time |  | range end, exclusive (default: end of timeline) |
| `--resolution` | string |  | override output WxH |
| `--fps` | number |  | GIF frame rate (default 15) |
| `--reframe` | string |  | crop anchor: center\|left\|right\|<x>% |
| `--overwrite` | boolean |  | replace an existing file |
| `--progress` | `text` \| `jsonl` \| `none` | `none` | progress output |

### 例

```bash
montash render gif --from 2 --to 4 -o out/loop.gif
```

## `montash render audio`

write the mixed audio of the timeline (no video)

```bash
montash render audio --output <string> [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `-o, --output` | string |  | output .wav / .mp3 / .m4a path（必須） |
| `--acodec` | string |  | override the audio encoder |
| `--abitrate` | string |  | audio bitrate (192k) |
| `--overwrite` | boolean |  | replace an existing file |
| `--progress` | `text` \| `jsonl` \| `none` | `none` | progress output |

### 例

```bash
montash render audio -o out/mix.wav
```

## `montash status`

HEAD、未コミットの op、直前のコミット、タグを表示する

```bash
montash status
```

### 例

```bash
montash status --json
```

## `montash log`

コミットを新しい順に一覧する（--ops で各コミットの op も展開）

```bash
montash log [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--ops` | boolean | `false` | expand the ops of each commit |
| `--all` | boolean | `false` | show all branches, not only the HEAD line |
| `--limit` | number | `20` | maximum number of commits |
| `--grep` | string |  | only commits whose message/body contains this text (case-insensitive) |
| `--author` | string |  | only commits by this author |
| `--graph` | boolean | `false` | draw a simple ASCII graph (● commit, ○ op) |

### 例

```bash
montash log --ops --json
# find the commit, then `montash checkout k_0006~1`
montash log --grep テロップ --json
montash log --all --graph
```

## `montash show`

op / コミット / タグの詳細を表示する（--patch で JSON Patch 全体も表示）

```bash
montash show <ref> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `ref` | string | ✅ | o_xxxx \| k_xxxx \| <tag> \| HEAD \| tip \| <ref>~n |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--patch` | boolean | `false` | include every change (JSON Patch style) |

### 例

```bash
montash show k_0002 --patch --json
montash show HEAD~1
```

## `montash diff`

履歴の 2 点間の差分を表示する（既定は直前のコミット → HEAD、つまり未コミット分）

```bash
montash diff [a] [b]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `a` | string |  | from: o_xxxx \| k_xxxx \| <tag> \| HEAD \| tip \| <ref>~n (default: last commit) |
| `b` | string |  | to (default: HEAD) |

### 例

```bash
montash diff --json
montash diff k_0005 k_0007
montash diff HEAD~3
```

## `montash blame`

show the op / commit / actor that last changed an element (clip, text, transition, asset)

```bash
montash blame <element> [options]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `element` | string | ✅ | element id (c3, x1, t2, an asset id, ...) |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--all` | boolean | `false` | search every branch, not only the HEAD line |

### 例

```bash
montash blame c3 --json
montash blame x1
```

## `montash commit`

未コミットの op をまとめ、人が読めるメッセージ（-m）を付けてコミットする

```bash
montash commit [options]
```

Commits all pending ops by default; --last <n> / --ops <a>..<b> select a contiguous tail. Messages should start with the affected timeline range (MM:SS.s〜MM:SS.s); otherwise W_COMMIT_MESSAGE_STYLE is warned.

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--last` | number |  | commit only the last n pending ops |
| `--ops` | string |  | commit only these pending ops, e.g. o_0040..o_0042 (must end at HEAD) |
| `--tag` | string |  | also tag the new commit |
| `--author` | string |  | commit author (default: MONTASH_AUTHOR or the actor) |
| `--allow-empty` | boolean | `false` | create a commit without ops (milestone) |
| `--auto-message` | boolean | `false` | generate a rule-based message from the op summaries when -m is omitted |

### 例

```bash
montash commit -m "00:12.0〜00:15.0 の言い間違いをカット" --body "指示: 「12秒あたりの噛んだところ消して」"
montash commit --last 2 -m "00:00.0〜00:03.0 にタイトルを追加"
# draft message; edit and re-run with -m
montash commit --auto-message --json
```

## `montash checkout`

HEAD を op / コミット / タグへ移し、その状態を project.json に展開する

```bash
montash checkout <ref>
```

Does not create an op (recorded in moves.jsonl). Pending ops are kept; use `checkout tip` to return.

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `ref` | string | ✅ | o_xxxx \| k_xxxx \| <tag> \| HEAD \| tip \| <ref>~n |

### 例

```bash
# the state just before commit k_0006
montash checkout k_0006~1
montash checkout before-bgm
# back to the newest state of the current branch
montash checkout tip
```

## `montash undo`

HEAD を n 個（既定 1）前の op に戻し、その状態を project.json に展開する

```bash
montash undo [n]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `n` | number |  | number of ops to go back |

### 例

```bash
montash undo
montash undo 3 --json
```

## `montash redo`

直近に使った系列に沿って HEAD を n 個（既定 1）先に進める

```bash
montash redo [n]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `n` | number |  | number of ops to go forward |

### 例

```bash
montash redo
montash redo 2 --json
```

## `montash revert`

apply the inverse of a commit or op as a new op (does not rewrite history)

```bash
montash revert <ref>
```

The original op stays in the history; reverting twice returns to the original state. If the target of the inverse diff no longer exists, the command fails with E_REVERT_CONFLICT.

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `ref` | string | ✅ | o_xxxx \| k_xxxx \| <tag> \| HEAD \| <ref>~n |

### 例

```bash
montash revert k_0006 -m "テロップ追加を取り消し"
# undo the last op as a new op (history keeps both)
montash revert HEAD
```

## `montash reset`

move HEAD to a ref and drop the ops after it from the default `log` view (--hard)

```bash
montash reset <ref> [options]
```

Nothing is deleted: the discarded ops stay in ops.jsonl and are listed by `montash log --all`. Only --hard is supported (the working project.json is always rewritten to the target state).

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `ref` | string | ✅ | o_xxxx \| k_xxxx \| <tag> \| HEAD~n |

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--hard` | boolean | `false` | required: expand the target state into project.json |

### 例

```bash
montash reset --hard k_0006 --yes
# the discarded ops are still there
montash log --all
```

## `montash tag`

現在の HEAD（または指定した op / コミット）に名前を付け、あとで checkout できるようにする

```bash
montash tag <name> [ref]
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `name` | string | ✅ | tag name (not HEAD/tip, not an id like o_0001/k_0001, no ~ / or spaces) |
| `ref` | string |  | target: o_xxxx \| k_xxxx \| HEAD \| tip \| <ref>~n (default HEAD) |

### 例

```bash
montash tag rough-cut -m "粗編集完了"
montash tag before-bgm k_0006
# restore
montash checkout rough-cut
```

## `montash tag list`

タグを一覧する

```bash
montash tag list
```

### 例

```bash
montash tag list --json
```

## `montash tag delete`

タグを削除する（指している履歴自体は残る）

```bash
montash tag delete <name>
```

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `name` | string | ✅ | tag name |

### 例

```bash
montash tag delete rough-cut
```

## `montash history verify`

履歴の整合性を検証する（オブジェクトのハッシュ、op DAG の連続性、コミット、タグ、移動ログ）

```bash
montash history verify
```

### 例

```bash
montash history verify --json
```

## `montash history prune`

delete old uncommitted ops and objects that nothing references

```bash
montash history prune [options]
```

Committed ops, HEAD and its ancestors, commit heads and tag targets are never deleted. Use --dry-run first: it lists exactly what would go.

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `--keep-commits` | number | `100` | keep every op from the last n commits onwards |
| `--keep-days` | number | `30` | keep ops newer than n days |

### 例

```bash
montash history prune --dry-run --json
montash history prune --keep-commits 20 --keep-days 7
```

## `montash history export`

export ops, commits, moves, tags and objects as one JSONL file (audit / backup)

```bash
montash history export [options]
```

### オプション

| 名前 | 型 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `-o, --out` | string |  | output file (.jsonl); '-' for stdout |

### 例

```bash
montash history export -o history.jsonl
```

## `montash history import`

import a history exported with `history export` (restores ops, commits, tags and objects)

```bash
montash history import <file>
```

Ids must not collide with the ones already present: import into a project whose .montash/history is empty.

### 引数

| 名前 | 型 | 必須 | 説明 |
| --- | --- | :-: | --- |
| `file` | string | ✅ | exported .jsonl file |

### 例

```bash
montash history import history.jsonl --json
```

## `montash ids rebuild`

project.json と全履歴オブジェクトから .montash/ids.json の採番カウンタを作り直す

```bash
montash ids rebuild
```

Counters never go backwards: the result is max(existing counter, highest used id + 1) per prefix.

### 例

```bash
montash ids rebuild --json
```
