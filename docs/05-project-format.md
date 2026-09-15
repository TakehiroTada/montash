# 05. プロジェクトファイル仕様（`project.json`）

編集状態の唯一の正（Single Source of Truth）。CLI が読み書きし、Web プレビューとレンダーが読む。人間や AI が直接編集することも想定し、可読な JSON とする。

## 1. ディレクトリ構成

```
<project>/
├── project.json              # 本書のスキーマ。唯一の編集状態
├── assets/                   # プロジェクトが所有する素材
│   ├── incoming/YYYYMMDD/    # Web からアップロードされたファイル（→ import）
│   ├── text/<id>.txt         # テキスト素材（`assets new-text` が生成）
│   └── ...                   # `import --copy` 時のコピー先
├── out/                      # レンダー出力の既定先
├── .gitignore                # .montash/cache, .montash/preview, .montash/tmp, out/ を除外
└── .montash/
    ├── ids.json              # 要素 ID の採番カウンタ（履歴対象外・単調増加。ADR-13）
    ├── history/              # git ライク履歴（11 章。追記専用）
    │   ├── HEAD              # 現在の op id
    │   ├── ops.jsonl         # op の追記ログ
    │   ├── commits.jsonl     # commit の追記ログ
    │   ├── moves.jsonl       # checkout/undo/redo の移動ログ
    │   ├── tags.json         # タグ（旧スナップショット）
    │   └── objects/<sha1>.json[.gz]   # project.json の不変スナップショット（内容アドレス）
    ├── cache/                # アセット派生物（削除しても再生成可）
    │   └── <asset_id>/
    │       ├── probe.json     # ffprobe の生 JSON（project.json には要約のみ。ADR-14）
    │       ├── proxy.mp4
    │       ├── thumbs.jpg     # スプライト
    │       ├── thumbs.json    # {interval_f, width, height, columns, count}
    │       └── waveform.json  # {points_per_second: 100, peaks: [0..1,...]}
    ├── preview/
    │   ├── timeline.mp4       # プレビュー用合成プロキシ（video.mp4 + audio.m4a を mux）
    │   ├── timeline.json      # 生成元ハッシュ、セグメント一覧、音声ハッシュ
    │   ├── video.mp4          # 映像セグメントを concat したもの（音声なし）
    │   ├── audio.m4a          # タイムライン全体の音声（毎回 1 パス）
    │   └── segments/<hash>.mp4   # 映像セグメントキャッシュ（音声なし）
    ├── render/
    │   ├── last.json          # 直前のレンダーオプション
    │   └── progress.json      # 実行中レンダーの進捗（Web が配信）
    ├── tmp/                   # 一時ファイル（生成した .ass、フォントディレクトリ、SRT シフト版 等）
    ├── logs/
    │   └── montash-YYYYMMDD.log # 実行コマンド、ffmpeg コマンド、stderr
    └── serve.pid              # --daemon 時
```

## 2. 単位規約（時間・座標）

浮動小数の誤差で「隣接しているのに等しくない」「フレーム境界からずれる」問題を起こさないため、**保存する時間はすべて整数**とする。

### 2.1 時間の単位

| 対象 | 単位 | フィールド接尾辞 | 例 |
|------|------|------------------|----|
| タイムライン上の位置・長さ（クリップ start / duration、トランジション、テキスト、フェード、`affects.range`） | **プロジェクト fps 基準の整数フレーム** | `_f` | `start_f: 375` |
| ソース（アセット）内の in / out | **プロジェクト fps 基準の整数フレーム**（アセット native fps ではない） | `_f` | `in_f: 60, out_f: 435` |
| 音声のサブフレーム補正（リンク解除後の同期ずらし） | **プロジェクト sample_rate 基準の整数サンプル** | `_smp` | `offset_smp: -960` |
| アセットの native 情報（ffprobe 由来） | 秒（数値。参照情報。編集判断には使わない） | `_s` | `duration_s: 14.214` |

- fps は有理数 `{ num, den }` で保持する（`29.97` → `30000/1001`）。1 フレームの長さは `den / num` 秒。
- **秒への変換**は表示・ffmpeg 境界でのみ行う: `seconds = f * den / num`。表示用ミリ秒は `round(f * den * 1000 / num)`、ffmpeg に秒で渡す必要がある箇所はマイクロ秒精度（小数 6 桁）で書式化する（ffmpeg 内部もマイクロ秒で解釈するため誤差 < 1µs ≪ 1 フレーム）。可能な限り ffmpeg にも **フレーム数・サンプル数で渡す**（07 章）。
- **入力の受理**（04 章 §1.3）: 秒・タイムコード入力は `f = round(t * num / den)` に丸め、丸め幅が 1µs を超えるときは警告 `W_SNAPPED` で「入力値 → 採用したフレーム／秒」を返す。`f:375` は直接。
- **フレーム → サンプル**: `smp = round(f * den * sr / num)`（29.97fps/48kHz では 1 フレーム = 1601.6 サンプルなので丸めが入るが、誤差 < 1 サンプル = 約 21µs で聴感上問題ない）。
- 速度変更後の長さ: `duration_f = max(1, round((out_f - in_f) / speed))`。
- fps を後から変えた場合（`project set fps`）は、全 `_f` を `f' = round(f * num' * den / (den' * num))` で再スナップし、`W_FPS_RESNAPPED` を出して op に記録する（`_smp` はサンプルレートが変わらなければ不変）。

### 2.2 座標・サイズの単位

| 対象 | 単位 |
|------|------|
| `settings.resolution` | ピクセル（プロジェクトのキャンバス） |
| オーバーレイの位置・スケール、クロップ | プリセット名（`top-right` 等）、または `%`（文字列 `"5%"`）、または px（整数）。**`%`／プリセットを推奨** |
| テキストのサイズ・余白・縁取り・影 | px（プロジェクト解像度の高さに対する絶対値。ASS の `PlayResY` と一致させる） |
| 解像度変更（`project set resolution`） | px 指定のフィールドを比率で再計算（x・幅は横比、y・高さ・文字サイズは縦比）、`%`／プリセットは不変。`W_RESOLUTION_RESCALED` を出して op に記録 |

### 2.3 ID の採番（ADR-13）

- 要素 ID はプレフィックス + 連番（クリップ `c7`、トランジション `t3`、テキスト `x2`、オーバーレイは映像クリップなので `c*`、字幕 `s1`、ダッキング `d1`）。
- カウンタは **`.montash/ids.json`** に置き、`project.json` には含めない。`checkout` で過去に戻っても採番は巻き戻らないので、別系列で同じ ID が生まれない。

```json
{ "counters": { "c": 12, "t": 3, "x": 2, "s": 1, "d": 1 } }
```

- `ids.json` が無い／壊れている場合、`montash ids rebuild`（または次回コマンド実行時に自動）が現在の `project.json` と `.montash/history/objects/*` を走査して各プレフィックスの最大値 +1 に復元する。
- `--id` で明示指定した ID が現在の `project.json` に存在すれば `E_ID_EXISTS`、過去の object のいずれかに存在すれば `W_ID_REUSED`。
- アセット ID はファイル名 slug（`clip_a`）で、カウンタの対象外。衝突時は `_2`, `_3`。
- op / commit ID（`o_0042` / `k_0007`）は追記専用ログの行数に基づくため自然に単調増加。

## 3. スキーマ概要

```jsonc
{
  "schema_version": 2,
  "name": "my-vlog",
  "created_at": "2026-09-14T01:23:45Z",
  "updated_at": "2026-09-14T02:00:00Z",
  "settings": { ... },          // §4
  "assets": { "<id>": {...} },  // §5
  "tracks": [ {...} ],          // §6（配列順 = 合成順、後ろが上）
  "transitions": [ {...} ],     // §7
  "audio": { ... },             // §8 タイムライン全体の音声設定
  "text_presets": { ... },      // §9
  "render_presets": { ... },    // §10 ユーザー定義プリセット
  "meta": { "last_render": {...}, "tags": [] }
}
```

- ID をキーとするものは **オブジェクト（辞書）**、順序が意味を持つものは **配列**。
- パスはプロジェクトルートからの相対（`./assets/...`）または絶対。`~` は展開しない。

## 4. `settings`

```jsonc
{
  "fps": { "num": 30000, "den": 1001 },      // 29.97。整数比で保持。init --fps 29.97 / 30 / 24000/1001 を受理
  "resolution": { "width": 1920, "height": 1080 },
  "sample_rate": 48000,
  "channels": 2,
  "background": "#000000",                    // ギャップ時の背景色
  "default_image_duration_f": 150,            // 5 秒 @ 30fps（init 時に fps から計算）
  "default_font": "Noto Sans CJK JP",
  "text_engine": "libass",                    // libass | drawtext（doctor が libass 不在時に drawtext へ）
  "proxy": { "height": 360, "crf": 28 },
  "preview": { "auto_build": true, "debounce_ms": 1500 }
}
```

- fps プリセット: `23.976 → 24000/1001`, `24 → 24/1`, `25 → 25/1`, `29.97 → 30000/1001`, `30 → 30/1`, `50 → 50/1`, `59.94 → 60000/1001`, `60 → 60/1`。`--fps 30000/1001` の直接指定も可。
- `settings.fps` と `settings.resolution` は `init` で設定し、以後は `project set fps|resolution` でのみ変更（§2 の再計算が走る）。
- 旧 `snap_to_frame` は廃止（常に整数フレーム）。

## 5. `assets`

```jsonc
"clip_a": {
  "id": "clip_a",
  "type": "video",                 // video | audio | image | subtitle | text
  "path": "/Users/me/raw/clip_a.mp4",
  "owned": false,                  // true = プロジェクトが生成・所有（assets/text/、assets/incoming/）。set-text の対象は owned のみ
  "label": "冒頭ドローン",
  "tags": ["空撮", "冒頭"],
  "color": "#3B82F6",
  "note": "",
  "imported_by": "web",            // ai | human | web
  "imported_at": "2026-09-14T01:30:00Z",
  "size": 123456789,
  "mtime": "2026-09-10T10:00:00Z",
  "hash_head": "sha1:...",         // 先頭 1MB のハッシュ（relink 用）
  "duration_s": 14.214,            // ffprobe の値（参照）
  "duration_f": 425,               // floor(duration_s * num / den) = floor(425.99)。in/out の上限に使う
  "start_time_s": 0.0,             // コンテナの start_time（非 0 なら in/out 解釈時に補正）
  "video": { "codec": "h264", "width": 3840, "height": 2160, "fps": { "num": 30000, "den": 1001 }, "pix_fmt": "yuv420p", "has_alpha": false, "rotation": 0 },
  "audio": { "codec": "aac", "sample_rate": 48000, "channels": 2 },
  "container": { "format": "mov,mp4,m4a,3gp,3g2,mj2", "bit_rate": 85000000 },
  "derived": {
    "probe": { "state": "ready", "path": ".montash/cache/clip_a/probe.json" },   // ffprobe 生 JSON（ADR-14。無ければ assets show が再生成）
    "proxy": { "state": "ready", "path": ".montash/cache/clip_a/proxy.mp4", "built_at": "..." },
    "thumbs": { "state": "ready", "path": ".montash/cache/clip_a/thumbs.jpg", "index": ".montash/cache/clip_a/thumbs.json" },
    "waveform": { "state": "missing" }
  }
}
```

- `type: image` は `duration_s/f: null`。`type: subtitle` は `format: srt|ass|vtt`、`language`。
- `type: text` は `path` が UTF-8 テキスト、`text_preview`（先頭 80 文字）、`line_count`。`derived` は無し。
- `project.json` には **ffprobe の要約のみ**を持つ（`video` / `audio` / `container` / `duration_*`）。生 JSON は `.montash/cache/<id>/probe.json`（派生物）。履歴 object の肥大化を防ぐため（ADR-14）。
- `video.fps` がプロジェクト fps と異なる場合は `W_ASSET_MISMATCH`。in/out はプロジェクト fps のフレームで指定し、レンダー時に `fps=` フィルタで変換される（07 章）。
- `derived.*.state`: `ready | building | missing | stale`。`stale` は `size`/`mtime` の変化で判定。
- 使用箇所（`usage`）は保存せず、`assets show` / `GET /api/assets` が `tracks` から算出する。

## 6. `tracks`

```jsonc
{
  "id": "V1",
  "kind": "video",                 // video | audio | text
  "name": "V1",
  "muted": false,
  "locked": false,                 // true: リップル（全トラック）の対象外。編集コマンドも E_TRACK_LOCKED
  "fade": { "in_f": 0, "out_f": 0, "color": "black" },   // トラック先頭／末尾フェード（montash fade --track）
  "clips": [ /* §6.1 start_f 昇順 */ ]
}
```

### 6.1 クリップ（映像・音声）

```jsonc
{
  "id": "c1",
  "asset": "clip_a",
  "start_f": 0,                    // タイムライン上の開始（フレーム）
  "in_f": 60,                      // アセット内の開始（プロジェクト fps のフレーム）
  "out_f": 435,                    // アセット内の終了（exclusive）
  "speed": 1.0,                    // duration_f = max(1, round((out_f - in_f) / speed))
  "pitch_keep": false,
  "loop": false,
  "link": "c1a",                   // リンクしている相手クリップ ID（null 可）
  "label": "オープニング",
  "video": {                       // kind=video のみ
    "opacity": 1.0,
    "transform": { "position": "top-right", "x": null, "y": null, "margin": 24, "scale": 0.12, "rotate": 0 },  // position はプリセット名 | null（x,y を使う）。x,y は px 整数 or "5%" 文字列
    "crop": null,                  // {x,y,w,h}（px または "%"）
    "color": null,                 // {brightness, contrast, saturation, gamma}
    "lut": null,
    "keep_alpha": false,
    "fade": { "in_f": 0, "out_f": 0, "color": "black" }
  },
  "audio": {                       // kind=audio のみ
    "gain_db": 0,
    "fade": { "in_f": 0, "out_f": 0, "curve": "tri" },
    "offset_smp": 0,               // サブフレームの同期補正（サンプル）。リンク解除後のみ有効
    "muted": false
  },
  "effects": []                    // 将来: キーフレーム、ぼかし等 [{type, params, keyframes}]
}
```

- `duration_f` は保存せず `speed` から算出する（派生値は持たない）。`end_f = start_f + duration_f`。
- オーバーレイは `video.transform` が設定された映像クリップに過ぎない（`overlay *` コマンドは糖衣）。
- **`clip split c --at t`** は `c` を `[in_f, in_f + (t - start_f))` に縮めて **ID を維持**し、後半を新 ID（採番）で作る。リンク音声も同様。

### 6.2 テキストクリップ（`kind: text` トラック）

```jsonc
{
  "id": "x1",
  "type": "text",
  "start_f": 0,
  "duration_f": 90,
  "text": "Summer Trip 2026",       // 直接指定。`asset` があれば無視され、レンダー時にテキスト素材から読む
  "asset": null,                    // type: text のアセット ID（`text add --asset`）
  "markup": "plain",                // plain | ass（ASS オーバーライドタグをそのまま通す。上級・AI 用）
  "style": {
    "preset": "title-center",
    "font": "Noto Sans CJK JP",
    "size": 96,                     // px（PlayResY 基準）
    "color": "#FFFFFF",
    "alpha": 1.0,
    "bg": null,                     // "#00000080" 等（libass BorderStyle=4 のボックス）
    "bg_padding": 16,
    "position": "center",           // プリセット名 or {x, y}（px または "50%"）
    "align": "center",              // left | center | right（複数行の揃え）
    "line_spacing": 0,
    "wrap": true,                   // 自動折り返し（libass WrapStyle）
    "shadow": { "x": 2, "y": 2, "color": "#000000AA" },
    "outline": { "width": 0, "color": "#000000" },
    "bold": false, "italic": false
  },
  "fade": { "in_f": 15, "out_f": 15 }
}
```

### 6.3 字幕クリップ

```jsonc
{ "id": "s1", "type": "subtitle", "asset": "ja_srt", "mode": "burn", "start_f": 0, "offset_f": 0,
  "style": { "font": "Noto Sans CJK JP", "size": 40, "margin_bottom": 60 }, "lang": "ja" }
```

`kind: text` トラックに置く。`mode: soft` はレンダー時に多重化のみ。

### 6.4 ギャップ・生成クリップ

`asset` の代わりに `generator` を持つクリップ。`{ "generator": "color", "params": {"color": "#000000"}, "start_f": .., "duration_f": .. }`、`{ "generator": "hold", "params": {"from_clip": "c1", "at": "end"} }`。

## 7. `transitions`

```jsonc
{
  "id": "t1",
  "track": "V1",
  "from": "c1",                    // 先行クリップ
  "to": "c2",                      // 後続クリップ
  "type": "fade",                  // xfade の transition 名
  "duration_f": 15,
  "mode": "handle",                // handle | overlap
  "audio": "crossfade",            // crossfade | cut
  "params": {}                     // xfade 固有パラメータ（将来）
}
```

- `mode: handle`: レンダー時に `ext_from = ceil(duration_f / 2)`、`ext_to = duration_f - ext_from` として `from.out_f += ext_from`、`to.in_f -= ext_to` に素材を延長して重ねる（`project.json` 上の in/out は変更しない）。`validate` は `from.out_f + ext_from <= from.asset.duration_f` と `to.in_f - ext_to >= 0` を確認する（不足なら `E_INSUFFICIENT_HANDLE` と最大 `duration_f`）。
- `mode: overlap`: in/out はそのまま。`to.start_f` が `project.json` 上で既に `duration_f` 分前倒しされている。
- 先頭／末尾フェード（`montash fade`）はトランジションではなく、`tracks[].fade` またはクリップの `video.fade` として保存。

## 8. `audio`（タイムライン全体）

```jsonc
{
  "master_gain_db": 0,
  "normalize": { "enabled": true, "i": -14, "tp": -1, "lra": 11 },
  "ducking": [
    { "id": "d1", "target": "A2", "sidechain": "A1", "threshold_db": -30, "ratio": 8, "attack_ms": 20, "release_ms": 500, "makeup_db": 0 }
  ],
  "track_gain_db": { "A1": 0, "A2": -12 }
}
```

## 9. `text_presets`

```jsonc
{
  "title-center":   { "size": 96, "position": "center", "bg": null, "fade": {"in_f": 15, "out_f": 15}, "outline": {"width": 2, "color": "#000000"} },
  "lower-third":    { "size": 48, "position": {"x": "5%", "y": "85%"}, "align": "left", "bg": "#00000099", "bg_padding": 12 },
  "caption-bottom": { "size": 40, "position": "bottom-center", "bg": "#00000080", "wrap": true },
  "corner-tag":     { "size": 32, "position": "top-right", "bg": "#00000080" }
}
```

組み込みプリセットはバイナリ側に持ち、`project.json` 側は上書き・追加のみ。プリセットの `fade` はフレームで持つため、fps 変更時に §2.1 の再スナップ対象になる。

## 10. `render_presets`（ユーザー定義）

```jsonc
{
  "client-review": { "base": "web-preview", "crf": 30, "resolution": "1280x720", "abitrate": "96k" }
}
```

## 11. 履歴（`.montash/history/`）

git ライクな DAG モデル。詳細は **11 章** を正とする。要点:

- `ops.jsonl`: 状態変更 1 回 = 1 op（`id`, `parent`, `actor`, `command[]`, `summary`, `before`, `after`, `changes[]`, `affects`, `commit`）。追記専用。`affects.range_f: [from_f, to_f]`。
- `commits.jsonl`: op の連続列にメッセージ・作者を付けたもの。追記専用。
- `objects/<sha1>.json`: `project.json` の不変スナップショット。内容アドレスで重複排除。
- `HEAD`: 現在展開されている op。`checkout` は HEAD を書き換えて object を `project.json` に展開するだけ。
- `moves.jsonl`: `checkout`/`undo`/`redo`/`reset` の移動ログ。
- `tags.json`: 名前 → op/commit。

## 12. 派生データ形式

### thumbs.json

```json
{ "interval_f": 30, "width": 160, "height": 90, "columns": 10, "count": 15, "sprite": "thumbs.jpg" }
```

### waveform.json

```json
{ "points_per_second": 100, "channels": 1, "peaks": [0.01, 0.12, 0.35, ...] }
```

### preview/timeline.json

```json
{
  "project_hash": "sha1:...",
  "fingerprint": "sha1:...",
  "built_at": "...",
  "duration_f": 1335,
  "fps": { "num": 30000, "den": 1001 },
  "resolution": { "width": 640, "height": 360 },
  "video_segments": [ { "from_f": 0, "to_f": 375, "hash": "sha1:...", "path": "segments/ab12.mp4", "clips": ["c1", "x1"] } ],
  "audio": { "hash": "sha1:...", "path": "audio.m4a" }
}
```

- `project_hash` は `project.json` の内容ハッシュ。`GET /preview/timeline.mp4` の `ETag` と Web の `?v=` に使う。
- `fingerprint` は `project.json` + 参照している素材ファイルの指紋（サイズ・mtime）+ 出力解像度。現在値と一致すれば `ready`、違えば `stale`（素材を差し替えただけでも検出する）。
- `video_segments[].hash` は**セグメント内をローカル座標に直した内容**のハッシュなので、リップル編集で位置だけが動いたセグメントは同じキャッシュを指す。`path` は `segments/<sha1>.mp4` 固定で、この形以外のマニフェストは無効として読み捨てる。
- このファイルの書き込みが公開点。書かれるまで `timeline.mp4` は差し替わらない。

## 13. バージョニングとマイグレーション

- `schema_version` を整数で持つ。CLI は自身が対応する最大バージョンより新しいファイルを拒否（`E_SCHEMA_TOO_NEW`）。
- 古いバージョンは読み込み時に自動マイグレーションし、マイグレーション自体を `actor: system` の op として記録し、`pre-migrate-v<N>` タグを付ける。
- v1（秒 float）→ v2（整数フレーム）: `fps` を有理数化し、全時間フィールドを `round(t * num / den)` でフレーム化。丸めが発生したフィールドは op の `changes` に旧値を残す。
- 破壊的変更は `schema_version` を上げる。追加のみなら上げない（未知フィールドは保持）。

## 14. 不変条件（validate が保証するもの）

1. すべての `_f` / `_smp` フィールドは整数（`Number.isSafeInteger`）。`_f >= 0`（`offset_smp` は負も可）。
2. すべての `clips[].asset` は `assets` に存在する（generator クリップを除く）。
3. `0 <= in_f < out_f <= asset.duration_f`（image は `duration_f > 0`）。
4. 同一トラック内でクリップ区間 `[start_f, end_f)` は互いに重ならない（整数比較）。
5. `transitions[].from/to` は同一トラックで隣接し、`from.end_f == to.start_f`（`mode: handle`）。ハンドル充足（§7）。
6. `link` は相互参照で、`start_f` と `duration_f` が一致する。
7. `tracks[].id` は一意。`kind` に合わないクリップ種別を含まない。
8. テキストクリップの `asset` は `type: text` のアセットを指す（`E_ASSET_TYPE_MISMATCH`）。
9. `project.json` の内容ハッシュは `.montash/history/HEAD` が指す op の `after` と一致する（不一致は `W_DIRTY_WORKTREE`）。
10. `settings.fps.num/den` は正の整数で互いに素。`resolution` は偶数（yuv420p 制約）。
