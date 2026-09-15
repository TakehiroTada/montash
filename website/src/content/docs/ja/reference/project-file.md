---
title: プロジェクトファイル
description: project.json の形と .montash/ ディレクトリの構成
---

montash のプロジェクトは 1 つのディレクトリで、その中身はおおむね次のようになります。

```
my-edit/
├── project.json        編集状態のすべて（これが唯一の正）
├── assets/             プロジェクトが所有する素材（--copy で取り込んだもの、テキスト素材）
├── out/                書き出した成果物
└── .montash/           montash が管理する作業領域
```

`project.json` は人が読める JSON です。中身を見れば「何がどこに置いてあるか」がすべて分かります。
ただし**直接編集することは想定されていません**。CLI から操作してください。

## `project.json` の形

```json
{
  "schema_version": 2,
  "name": "my-vlog",
  "created_at": "2026-09-15T05:30:00Z",
  "updated_at": "2026-09-15T05:30:27Z",
  "settings": {
    "fps": { "num": 30000, "den": 1001 },
    "resolution": { "width": 1920, "height": 1080 },
    "sample_rate": 48000,
    "channels": 2,
    "text_engine": "libass"
  },
  "assets": {
    "clip_a": {
      "id": "clip_a",
      "type": "video",
      "path": "./assets/clip_a.mp4",
      "duration_f": 425
    }
  },
  "tracks": [
    {
      "id": "V1",
      "kind": "video",
      "clips": [
        { "id": "c1", "asset": "clip_a", "start_f": 0, "in_f": 60, "out_f": 435, "speed": 1.0 }
      ]
    }
  ],
  "transitions": [],
  "audio": {},
  "text_presets": {},
  "render_presets": {},
  "meta": { "tags": [] }
}
```

| キー | 内容 |
|------|------|
| `schema_version` | フォーマットのバージョン（現行 2） |
| `settings` | fps・解像度・サンプルレート・チャンネル数・既定フォント・テキストエンジンなど |
| `assets` | 取り込んだ素材。**ID をキーにしたオブジェクト** |
| `tracks` | トラックとその上のクリップ。**配列で、順序が合成順**（後ろほど上に重なる） |
| `transitions` | トランジション。**配列** |
| `audio` | マスターゲイン、ダッキング、ラウドネス正規化の設定 |
| `text_presets` / `render_presets` | プロジェクト固有のプリセット |
| `meta` | 直前の書き出し情報、タグ |

ID をキーにするもの（`assets` など）はオブジェクト、順序に意味があるもの（`tracks`、`transitions`）は配列、という使い分けです。

パスはプロジェクトルートからの相対（`./assets/...`）か絶対パスです。`~` は展開されません。

## fps は有理数

`settings.fps` は整数の分子・分母で保持されます。

```json
"fps": { "num": 30000, "den": 1001 }
```

これが 29.97fps です。1 フレームの長さは `den / num` 秒（= 1001/30000 ≒ 0.0333667 秒）。
`0.0333` のような小数で持つと丸め誤差が蓄積しますが、有理数なら**何フレーム経っても正確**です。

| 指定 | 保存される値 |
|------|------------|
| `23.976` | `24000/1001` |
| `24` | `24/1` |
| `25` | `25/1` |
| `29.97` | `30000/1001` |
| `30` | `30/1` |
| `50` | `50/1` |
| `59.94` | `60000/1001` |
| `60` | `60/1` |

`montash init --fps 30000/1001` のように分数を直接渡すこともできます。

秒への変換は、画面に表示するときと ffmpeg に渡すときにだけ行われます（`秒 = フレーム × den / num`）。

## 時間は整数

時間を表すフィールドは、接尾辞で単位が分かるようになっています。**保存される値は必ず整数です。**

| 接尾辞 | 単位 | 例 |
|--------|------|-----|
| `_f` | プロジェクト fps 基準の**フレーム数** | `start_f: 375`、`in_f: 60`、`out_f: 435` |
| `_smp` | `sample_rate` 基準の**サンプル数**（フレーム未満の音声補正用） | `offset_smp: -960` |
| `_s` | 秒（ffprobe 由来の参照情報。編集の判断には使わない） | `duration_s: 14.214` |

`_f` の値は 0 以上です（`offset_smp` だけは負になり得ます）。

:::note[クリップの長さは保存されない]
クリップの `duration_f` は保存されず、`in_f` / `out_f` / `speed` から計算されます
（`duration_f = max(1, round((out_f - in_f) / speed))`、`end_f = start_f + duration_f`）。
ただしテキストクリップ・字幕クリップ・生成クリップは自前の `duration_f` を持ちます。
:::

## 要素の ID

| 種類 | 形 | 例 |
|------|-----|-----|
| 素材 | ファイル名の slug（衝突時は `_2`, `_3`） | `clip_a` |
| クリップ（映像・音声・オーバーレイ） | `c<N>` | `c7` |
| トランジション | `t<N>` | `t3` |
| テキスト（テロップ） | `x<N>` | `x2` |
| 字幕 | `s<N>` | `s1` |
| ダッキング | `d<N>` | `d1` |
| トラック | `V<N>` / `A<N>` / `T<N>` | `V1`, `A2`, `T1` |
| op | `o_<4 桁>` | `o_0042` |
| コミット | `k_<4 桁>` | `k_0007` |

連番のカウンタは `.montash/ids.json` にあり、`project.json` には含まれません。
削除した ID が再利用されないよう、単調増加します。

## `.montash/` の中身

montash の作業領域です。**`assets/` と `project.json` 以外はすべて再生成できます。**

| パス | 役割 |
|------|------|
| `.montash/ids.json` | 要素 ID の採番カウンタ |
| `.montash/history/HEAD` | 現在の op ID |
| `.montash/history/ops.jsonl` | op の追記専用ログ |
| `.montash/history/commits.jsonl` | コミットの追記専用ログ |
| `.montash/history/moves.jsonl` | `checkout` / `undo` / `redo` の移動ログ |
| `.montash/history/tags.json` | タグ |
| `.montash/history/objects/<sha1>.json` | `project.json` のスナップショット（内容アドレスで重複排除） |
| `.montash/cache/<asset_id>/` | 素材の派生物。`probe.json`（ffprobe の生 JSON）、`proxy.mp4`、`thumbs.jpg`、`thumbs.json`、`waveform.json` |
| `.montash/preview/` | プレビュー。`timeline.mp4`、`timeline.json`、`audio.m4a`、`segments/<sha1>.mp4` |
| `.montash/render/` | 直前のレンダー設定と進捗 |
| `.montash/tmp/` | 一時ファイル（生成した `.ass` など） |
| `.montash/logs/` | 実行ログ |

`ops.jsonl` と `commits.jsonl` は**追記専用**です。`history prune` 以外で行が消えることはありません。

### git で管理する場合

プロジェクトを git に入れるなら、次を無視するのが妥当です。

```text
.montash/cache/
.montash/preview/
.montash/tmp/
out/
```

`project.json` と `.montash/history/` は編集内容そのものなので、コミットする価値があります。

## 関連

- [CLI リファレンス](/ja/reference/cli/)
- [用語集](/ja/reference/glossary/)
