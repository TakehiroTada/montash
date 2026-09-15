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
| `host.commands.define(spec)` | **CLI コマンドを登録**（AviUtl2 の「汎用プラグイン（.aux2）」に相当）。解決された絶対パスを返す |
| `host.importers.define(spec)` | 取り込み形式を登録（AviUtl2 の `.aui2` 相当）※ 配線は後続 |
| `host.exporters.define(name, preset)` | 出力プリセットを登録（`.auo2` 相当）※ 配線は後続 |
| `host.requireFeatures(requires)` | 追加の ffmpeg 機能要求 |
| `host.capabilities` | 宣言した能力（未宣言は `false`） |
| `host.manifest` / `host.apiVersion` | 自分のマニフェスト／ホストの API バージョン |
| `host.log(message)` | `--verbose` のときだけ出る診断ログ |

**project.json を触る API は無い。**

### 3.3a `host.commands.define(spec)` — 汎用プラグイン

効果でもジェネレータでもない「道具そのもの」を足す口。登録された spec は組み込みとまったく同じ
`CommandSpec` として `getCommands()` に合成されるので、**yargs への登録・`montash schema`・`montash help`
の 3 者すべてに同じように載る**（docs/13 D-18 / P0-6 の仕組みにそのまま乗る）。

```js
host.commands.define({
  path: "render",                      // ← 名前空間からの相対パス
  summary: "render with the glow preset",
  mutates: true,                       // 状態を変えるなら宣言する
  positionals: [{ name: "clip", describe: "clip id", required: true }],
  options: { radius: { type: "number", describe: "blur radius", default: 8 } },
  run(ctx, args) {
    ctx.project.meta.tags.push(`glow:${args.clip}`);   // 渡された作業コピーを書き換えるだけ
    return { result: { ok: true }, summary: `glow ${args.clip}` };
  },
});
```

**名前空間は強制**する。プラグイン ID の末尾セグメントがそのプラグインのコマンド名前空間になり、
`path` は**そこからの相対パス**として解決される（`com.example.glow` + `"render"` → `montash glow render`）。
理由は 3 つ:

1. **組み込みの乗っ取りが原理的に起きない。** 「上書きを検出して弾く」だけだと、組み込みが 1 つ増えた日に
   既存のプラグインが突然壊れる。名前空間を切っておけば、組み込みの側が後から増えても衝突しない。
2. **利用者が出自を読める。** `montash glow render` を見れば glow プラグインの機能だと分かる。
   `plugin list` の `registered.commands` から逆も引ける。
3. **書く側の手間が増えない。** 相対パスなので、プラグイン作者は名前空間を書かなくてよい。

**組み込みコマンドの上書きは必ず禁止**する。次のいずれも `E_PLUGIN_COMMAND_CONFLICT` で**登録の時点で**
弾き（`getCommands()` まで持ち越さない）、`detail` に「どのプラグインが」「どのパスを」「今は誰のものか」を出す。
そのプラグインは読み込み失敗として警告になり、**他のプラグインと組み込みには影響しない**（§5 と同じ方針）。

| 状況 | 例 |
|------|-----|
| 名前空間が組み込みの第 1 セグメントと同じ | `com.example.clip` が `clip ...` を名乗る |
| 組み込みと同じ完全パス | 上の結果としての `clip add` |
| 既に別のプラグインが取ったパス | 探索順で**先に読まれた方が勝つ**（同じ `id` の解決と同じ規則） |

末尾セグメントがコマンド名として使えない（数字始まりなど）場合と、`path` の形が不正な場合は
`E_PLUGIN_INVALID`。

**状態変更は必ず `runMutation()` 経由**（§2 の原則 4）。`mutates: true` のコマンドは、ホストが
load → 作業コピーを渡す → 検証 → 保存（tmp→rename）→ op 記録 までを行い、プラグインは
**渡された作業コピーを書き換えて `summary` を返すだけ**。`--dry-run` も `-m` も組み込みと同じに効く。
そのために、ハンドラに渡す文脈（`PluginCommandContext`）は `CommandContext` そのものではなく、次だけに絞ってある:

| メンバ | 中身 |
|--------|------|
| `ctx.project` | `mutates: true` なら作業コピー。読み取り系では**凍結した複製**（書き換えても保存されない） |
| `ctx.fps` / `ctx.cwd` | フレーム換算と、利用者が渡した相対パスの解決に要る値 |
| `ctx.globals` | `json` / `quiet` / `verbose` / `dryRun` / `timeFormat` のみ |
| `ctx.log(msg)` | `--verbose` のときだけ出る診断ログ |

**プロジェクトディレクトリも保存関数も渡さない。** サンドボックスではない（§8）が、`project.json` へ至る
最短経路を API に置かないことで、「うっかり直接書く」実装が生まれないようにしている。`mutates: true` と
`noProject` は併用できず、`summary` を返さない `mutates` コマンドは `E_PLUGIN_INVALID`（op に残せないため）。

**Web からの実行は許可リスト経由のみ。** サーバは `serve --allow/--deny` とマニフェストの `webAllow`
が許したコマンドしか実行しない（P3-3）。プラグインがコマンドを足しただけでは Web からは呼べない。

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

## 4.3 入出力（importer / exporter）

`src/registry/io.ts`（importer）と `src/ffmpeg/presets.ts`（exporter）。

**importer** は「拡張子 → アセットの作り方」。ホストが渡す `ctx` 経由でしか I/O できない。

| `ctx` のメンバ | できること |
|----------------|-----------|
| `ctx.read()` | **取り込もうとしているファイルだけ**を読む（任意のパスは読めない） |
| `ctx.probe()` | そのファイルに ffprobe をかける |
| `ctx.toFrames(sec)` | プロジェクト fps でフレーム化 |

組み込みは `text`（.txt / .md）/ `subtitle`（.srt / .ass / .vtt）/ `media`（ffprobe に任せる既定）の 3 つで、**どれも同じ契約で書かれている**。拡張子を主張する importer が無ければ `media` に落ちる。

**exporter** は出力プリセットの供給元で、`render_presets` の一般化。`registerExporter()` で登録すると `render --preset` / `render presets` から組み込みと区別なく使える（`source` で出自が分かる）。

プロジェクト側の `project.render_presets` は、**供給元が組み込みでもプラグインでも同じ規則**で同名上書きできる（docs/05 §10、docs/13 D-20）。`base` を省略した同名エントリは「登録済みの同名エントリ自身」を継承元にするので、プラグインのプリセットから `crf` だけ差し替える、といった調整がそのまま書ける。

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
