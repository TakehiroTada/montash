# 14. プラグインアーキテクチャ

montash 本体は「**タイムラインの意味論と履歴の一貫性**」を守るカーネルに絞り、「**素材をどう見せるか・どう加工するか**」は拡張点レジストリ経由で差し替え可能にする。AviUtl / AviUtl2 のプラグイン方式を、montash の事情（ffmpeg への委譲、CLI と AI が操作主体、全操作が op として残る）に合わせて翻訳したもの。

計画: `docs/plans/2026-09-15-plugin-architecture.md`。手順: **W-18**（効果を掛ける）/ **W-19**（プラグインを導入して使う）。

## 1. 全体像

```
┌──────────────────────────────────────────────────────────────┐
│ カーネル（交換不可）                                            │
│  core/      時間・スキーマ・不変条件・タイムライン操作・履歴・ID  │
│  ffmpeg/    探索・機能検出・起動・進捗・検証・キャッシュ指紋       │
│  graph/     入力→正規化→連結→合成→出力段 の「順序」               │
│  cli/       defineCommand・出力・エラー・schema/help             │
│  server/web サーバ・許可リスト・WS・タイムライン描画の骨格        │
├──────────────────────────────────────────────────────────────┤
│ 拡張点レジストリ（カーネルが所有。種類は固定）                    │
│  effects  transitions  generators  positions/presets           │
│  commands  requirements                                        │
│  各エントリに source: builtin | project | plugin                │
├──────────────────────────────────────────────────────────────┤
│ 供給元（信頼度順）                                               │
│  builtin  本体同梱。**レジストリ経由でしか呼ばれない**             │
│  project  project.json 内の宣言。コード実行なし                   │
│  plugin   ~/.local/share/montash/plugins/ の JS / TS モジュール  │
└──────────────────────────────────────────────────────────────┘
```

**組み込み機能も同じレジストリを通す。** こうしておくと契約が常に実コードで検証され、「組み込みだけができること」が生まれない。

## 2. 基本原則

| # | 原則 | 理由 |
|---|------|------|
| 1 | **プラグインはピクセルを触らない** | 加工は ffmpeg に委譲するという montash の原則を崩さない。プラグインは「ffmpeg に何をさせるか」を記述する |
| 2 | **`build()` は純関数** | `graph/` の純粋性を保ち、`preview` のキャッシュ指紋（`filterComplex` 由来）が自動的に正しく無効化される |
| 3 | **プラグインは montash を import しない** | 単一バイナリ（`bun build --compile`）の中のモジュールは外から解決できない（§6 の実測）。ホストが `register(host)` で API を渡す |
| 4 | **project.json を直接書き換えない** | 変更は必ず op 経由（N-13 / N-15）。プラグインは値を返すだけ |
| 5 | **プラグインが無くてもプロジェクトは開ける** | 未知の種別・効果は保持し、**レンダー時にだけ** `E_PLUGIN_MISSING`（F-EXT-4） |
| 6 | **導入は人間が行う** | プラグインは任意コードを実行する。AI は `plugin install` を自律実行しない（docs/10） |

## 3. プラグインの形

1 ディレクトリ = 1 プラグイン。直下に `montash-plugin.json` を置く。

```
com.example.glow/
├── montash-plugin.json
└── index.js        (または index.ts / main で指定したファイル)
```

### 3.1 マニフェスト（`montash-plugin.json`）

| キー | 必須 | 意味 |
|------|------|------|
| `id` | ✔ | 逆ドメイン形式（`com.example.glow`）。ディレクトリ名にもなる |
| `apiVersion` | ✔ | 要求するプラグイン API のバージョン（整数） |
| `name` / `version` / `description` | | 表示用。`version` は `project.plugins.requires` に記録される |
| `main` | | エントリ（既定: `index.js` → `index.ts` → `index.mjs`）。**プラグインディレクトリの外は指せない** |
| `requires` | | 必要な ffmpeg 機能（`filters` / `encoders` / `recommendedFilters`）。`doctor` が検査する |
| `capabilities` | | `analyze` / `process`。**宣言しない限りホストは何も許可しない** |
| `webAllow` | | Web から実行を許可したいコマンド（Phase 3） |

### 3.2 エントリ

```js
// montash を import しない。API は register(host) で受け取る
export default {
  register(host) {
    host.effects.define({
      name: "glow",
      target: "video",
      summary: "soft glow",
      requires: ["gblur", "blend"],
      params: {
        radius: { type: "number", describe: "blur radius", default: 8, min: 0, max: 64 },
      },
      build: (p) => [`split[a][b];[b]gblur=sigma=${p.radius}[g];[a][g]blend=all_mode=screen`],
    });
  },
};
```

**パラメータ定義 1 つから、CLI オプション・`schema`・`help` が生える**（AviUtl の「トラックバーを登録すると UI が出る」に相当）。上の例なら `montash effect add c1 glow --radius 12` がそのまま通り、`montash help effect add` に `--radius` が出る。

### 3.3 `host` API

| メンバ | 用途 |
|--------|------|
| `host.effects.define(spec)` | エフェクトを登録（`source: "plugin"`） |
| `host.generators.define(spec)` | ジェネレータを登録 |
| `host.transitions.define(spec)` | トランジションを登録 |
| `host.requireFeatures(requires)` | 追加の ffmpeg 機能要求 |
| `host.capabilities` | 宣言した能力（未宣言は `false`） |
| `host.manifest` / `host.apiVersion` | 自分のマニフェスト／ホストの API バージョン |
| `host.log(message)` | `--verbose` のときだけ出る診断ログ |

**project.json を触る API は無い。**

## 4. 能力（capabilities）の 3 段階

| 段階 | できること | 宣言 |
|------|-----------|------|
| **A. 宣言** | project.json 内にフィルタテンプレートを書く。コード実行なし | 不要 |
| **B. 純関数** | `build()` でグラフ片を返す。I/O 禁止 | 不要（既定） |
| **C. 解析・プロセス** | レンダー前の測定パス、外部プロセスの起動 | `capabilities: ["analyze"]` / `["process"]` |

Level C は `plugin install` 時に人間へ提示される。

### 4.1 `analyze`（実装済み）

レンダーの前に 1 度だけ走る測定パス。**loudnorm / ducking とまったく同じ「解析は外で実行し、結果を値で注入する」形**にしてあるので、`build()` の純粋性と `preview` のキャッシュ整合が保たれる。

```js
host.effects.define({
  name: "autolevel",
  target: "video",
  async analyze(params, ctx) {
    // ffmpeg の起動は**ホストが仲介する**。プラグインが渡せるのはフィルタ文字列だけで、
    // 任意のコマンドを実行することはできない
    const stderr = await ctx.probe("signalstats,metadata=print");
    return { avg: parseAverage(stderr) };
  },
  build(params, ctx) {
    if (!ctx.analysis) return [];          // 解析が無ければ既定の挙動に落とす
    return [`eq=brightness=${correction(ctx.analysis)}`];
  },
});
```

- **`capabilities: ["analyze"]` を宣言していないプラグインは、`analyze()` を持つ効果を登録できない**（`E_PLUGIN_CAPABILITY_REQUIRED`）。黙って無視すると原因が分からなくなるため、登録の時点で弾く。
- `ctx.probe(filter)` の ffmpeg 引数は**ホストが組み立てる**（入力・切り出し範囲・`-f null -`）。プラグインはフィルタ文字列しか渡せない。
- **解析が要る効果が 1 つも無ければ、ffmpeg は 1 度も起動しない。**
- クリップ内で同じ効果を 2 度掛けても解析は 1 回（結果を共有）。

### 4.2 `process`（未実装）

外部プロセスの起動。importer / exporter（Phase 3）で使う予定で、現状は宣言だけを受け付ける。

## 5. 探索と読み込み

```
1. <project>/.montash/plugins/          そのプロジェクト専用（優先）
2. ~/.local/share/montash/plugins/      ユーザー共通（MONTASH_PLUGIN_PATH で変更可）
```

- 同じ `id` は先に見つかった方が勝つ（プロジェクト側が優先）。
- 読み込みは **コマンド定義より前**（プラグインの効果が `effect add` のオプションと `schema` に載るため）。
- **1 つのプラグインが壊れていても montash 全体は止めない。** 失敗は stderr の警告として出し、残りを読み続ける。

## 6. API バージョンの互換（docs/13 C-10）

- ホストは `MIN_PLUGIN_API_VERSION`〜`PLUGIN_API_VERSION` を受け入れる（現在はどちらも **1**）。
- 範囲外は `E_PLUGIN_INCOMPATIBLE` で**読み込まず**、他のプラグインには影響しない。
- 破壊的変更のときだけ `PLUGIN_API_VERSION` を上げる。

### 単一バイナリとの両立（P2-3 の実測）

`bun build --compile` で作ったバイナリで検証した結果:

| 検証 | 結果 |
|------|------|
| バイナリから外部 JS を実行時 `import()` | **動く** |
| 同じく外部 **TypeScript** を直接 `import()` | **動く**（Bun の TS ローダー） |
| プラグインが `import "montash/plugin-api"` | **解決できない** |

3 つ目が、原則 3「プラグインは montash を import しない」の根拠。型定義だけは npm で配れる（型は実行時に不要）。

## 7. プラグインが無い環境での挙動（F-EXT-4）

| 操作 | 挙動 |
|------|------|
| `clip list` / `timeline show` など | **通る**。未知の効果・種別は保持される |
| `effect list` | 通る。該当の効果に `missing: true` が付く |
| `validate` | `W_UNKNOWN_CLIP_TYPE` の**警告のみ** |
| `render` / `preview build` | **`E_PLUGIN_MISSING` で失敗**。不足している名前を出す |
| `plugin doctor` | 不足プラグインと解釈できない効果を一覧し、終了コード 1 |

`effect add` でプラグイン由来の効果を使うと、`project.plugins.requires[]` にその ID とバージョンが記録される（記録するだけで自動導入はしない）。

## 8. やらないこと

- **ピクセル単位の加工 API**（ffmpeg 委譲の原則を崩す）
- **プラグインからの project.json 直接書き込み**（履歴の完全性を崩す）
- **Web への UI プラグインコード投入**（`web/` は 1 バンドルのまま。フォームは spec 駆動のみ）
- **独自トラック種別**（タイムラインの意味論に触る）
- **プラグインの署名・サンドボックス**（単一ユーザー・localhost 前提。導入は人間が明示的に行う）
- **プラグインの自動ダウンロード**（montash はネットワークから何も取得しない）
