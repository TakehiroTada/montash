# プラグインアーキテクチャ 実装計画・ドキュメント修正計画（2026-09-15）

決定した方針（会話での合意。ADR-18〜20 として 12 章に記録予定）:

> **小さなカーネル + 固定 6 種の拡張点レジストリ + 宣言優先のプラグイン。**
> プラグインはピクセルを触らず、`defineCommand` と同形の定義オブジェクトで **ffmpeg のグラフ片を返す純関数** を提供する。
> 供給元は `builtin` / `project`（project.json 内の宣言）/ `plugin`（外部 JS モジュール）の 3 種で、信頼度の低い順に段階導入する。
> **組み込み機能も同じレジストリを通す**（契約を実コードで検証し、二重管理を消す）。

本書は「何を・どの順に・どの PR で」を固定するための計画書。仕様そのものは 14 章（新設）と既存章の改訂に書く。

---

## 0. 全体像

```
Phase 0  カーネル整備        プラグイン以前の宿題 6 件。外部ロードなし。schema_version 3
Phase 1  宣言プラグイン      project.json 内でエフェクト／ジェネレータを宣言。コード実行なし
Phase 2  外部プラグイン      ~/.local/share/montash/plugins/ の JS モジュール。マニフェスト・apiVersion・host API
Phase 3  I/O と Web          importer / exporter、Web の spec 駆動フォーム、許可リスト連携
```

- **Phase 0 は v1.0（M5）に含める。** クリップ種別を開く変更は schema_version を上げる破壊的変更なので、v1.0 より前に済ませる。
- Phase 1〜2 を **M6「プラグイン」**、Phase 3 を **M7** とする（09 章を改訂）。
- 各 PR は独立にマージできる粒度にし、依存が無いものはサブエージェントで並行する。
- 検証はローカル `bun run verify`（D-6 の方針どおり CI は自動実行しない）。

サイズ目安: S = 半日以内、M = 1〜2 日、L = 3 日以上（人間換算）。

---

## 1. 実装計画

### Phase 0 — カーネル整備（M5 に含める）

プラグインの有無に関係なく必要な修正。**6 件を D-13〜D-18 として 13 章に起票**し、1 件 = 1 PR で進める。

| PR | 課題 | 内容 | 触る場所 | テスト | 依存 | サイズ |
|----|------|------|----------|--------|------|--------|
| **P0-1** | D-13 | **マイグレーション機構**。`schema_version` を 2→3 に上げるための土台。`core/migrate.ts` を新設し、`loadProject` が旧版を段階的に変換。変換は `actor: system` の op として記録し `pre-migrate-v<N>` タグを打つ（05 章 §13 の設計を実装） | `core/project.ts:185-211`、新 `core/migrate.ts`、`cli/mutate.ts` | 単体: v2 → v3 の往復、タグと op が残る。E2E: 既存 fixtures を v2 のまま読めること | なし | M |
| **P0-2** | D-14 | **クリップ種別を開く**。`type` を全クリップ必須の判別キーにし（media は `type: "media"`）、`TrackClipSchema` を `discriminatedUnion` + 未知種別は `OpaqueClipSchema`（`type`/`id`/`start_f` だけ検証、他は保持）に。`clipKind()` の三重実装（`core/schema.ts:398`、`server/computed.ts:83`、`web/lib/timeline.ts:79`）を `core` の 1 関数に統合し、未知種別は `kind: "opaque"` で 1 フレーム幅にならないよう `duration_f` 必須に。レンダーは opaque を `E_PLUGIN_MISSING`（新設）で拒否、`validate` は `W_UNKNOWN_CLIP_TYPE` 警告 | `core/schema.ts:132-290`、`core/validate.ts:213-234`、`server/computed.ts`、`web/src/lib/timeline.ts`、`ffmpeg/graph/builder.ts:60` | 単体: 未知種別を含む project.json が読める／保存で消えない／レンダーで E_PLUGIN_MISSING。W-01〜W-17 全通し | P0-1（v3 で `type` を付与） | L |
| **P0-3** | D-15 | **エフェクトレジストリと挿入スロット**。`src/registry/effects.ts` を新設し `defineEffect()` を導入。`EffectSchema` を全クリップ種別に持たせる。`graph/video.ts:93` と `builder.ts:72` の `unsupported("clip effects")` を外し、`normalizeVideoClip()` の `format=` 直前でレジストリを展開。**組み込みの色補正（`colorFilter()` の eq）を最初の builtin エフェクトとしてレジストリに載せ替える**。音声側も `normalizeAudioClip()` に同じスロット | `core/schema.ts:191-211`、新 `src/registry/effects.ts`、`ffmpeg/graph/video.ts:79-93`、`ffmpeg/graph/audio.ts:71`、`ffmpeg/graph/types.ts:220` | ゴールデン: eq を effects 経由にしても `filterComplex` が従来と同一。preview キャッシュ指紋が effects 変更で無効化される | P0-2 | M |
| **P0-4** | D-16 | **プリセットの統合**。overlay の `PRESETS`（`graph/overlay.ts:23`）と ASS の `POSITION_PRESETS`（`ffmpeg/ass.ts:87`）を `src/registry/positions.ts` に統合。`text_presets` / `render_presets` の「builtin + project + `source` ラベル」パターンを `registry/` 共通基盤（`createRegistry<T>()`）に昇格させ、3 者をその上に載せる | `graph/overlay.ts`、`ffmpeg/ass.ts`、`core/text-presets.ts:53`、`ffmpeg/presets.ts:220`、新 `src/registry/index.ts` | 既存スナップショット不変。位置名の一覧が overlay と text で一致 | なし（P0-3 と並行可） | S |
| **P0-5** | D-17 | **ID プレフィックスの開放**。`ID_PATTERN` を `^([a-z][a-z0-9]*?)(\d+)$` に、`collectNumberedIds` / `rebuildIds` がレジストリに宣言されたプレフィックスを走査。`existingIds` がプラグイン領域（`project.plugins.*[].id`）も見る | `core/ids.ts:18-136` | 単体: 多文字プレフィックスの発行・再構築・衝突検出 | なし（並行可） | S |
| **P0-6** | D-18 | **コマンド／機能宣言の合成**。`registry.ts` の静的配列を `getCommands()`（builtin + 登録済み）に。`schema.ts:42` / `help.ts:166` の直接 import をそこへ。`locate.ts:20` の `REQUIRED_FILTERS` をレジストリ由来の `requires` と合成し `doctor` が検査。`buildCli()` を async 化 | `cli/commands/registry.ts`、`cli/index.ts:121,250`、`cli/commands/schema.ts`、`cli/commands/help.ts`、`ffmpeg/locate.ts` | 単体: 追加した spec が schema/help/doctor に現れる。既存 help.test の全件通過 | なし（並行可） | S |

**並行の組み方**: P0-1 → P0-2 → P0-3 が直列の本線。P0-4 / P0-5 / P0-6 は本線と独立なので、3 本を同時にサブエージェントで進められる。

**Phase 0 の完了条件**: `schema_version: 3` の project.json で W-01〜W-17 が全通し、未知種別クリップを含むファイルが「開ける・保存で消えない・レンダーで `E_PLUGIN_MISSING`」になり、色補正が effects レジストリ経由で従来と同一の `filterComplex` を出す。

### Phase 1 — 宣言プラグイン（M6 前半）

コード実行を伴わない拡張。**W-18「クリップに効果を掛ける」** を 03 章に先に書き、コマンドを逆算する（作業手順開発の原則）。

| PR | 内容 | 触る場所 | テスト | 依存 | サイズ |
|----|------|----------|--------|------|--------|
| **P1-1** | **`effect` コマンド群**。`effect add <clip> <name> [--param v]...` / `effect set` / `effect remove` / `effect list` / `effect presets`。パラメータは `defineEffect().params` から yargs オプションを動的生成（`defineCommand` を拡張し、`params` DSL → `OptionSpec` 変換を `define-command.ts` に追加）。`--dry-run` でフィルタ文字列を表示 | 新 `cli/commands/effect.ts`、`cli/define-command.ts`、`core/timeline.ts`（effects の追加・削除・並び） | W-18.sh 新設。単体: params DSL → options 変換、min/max/choices 検証 | P0-3, P0-6 | M |
| **P1-2** | **project.json 内の宣言エフェクト**。`project.effects: { <name>: { target, params, template } }`。`template` は `gblur=sigma={radius}` のようなプレースホルダ付きフィルタ文字列（配列可）。値は `transitions.ts:79` と同じ許可文字で検査し、式インジェクションを防ぐ。`source: "project"` としてレジストリにマージ | `core/schema.ts`（`project.effects`）、`registry/effects.ts`、`core/validate.ts` | 単体: テンプレート展開、不正文字の拒否。ゴールデン: 宣言 glow のレンダー | P1-1 | M |
| **P1-3** | **組み込みエフェクトの拡充**（F-FX-4 の LUT、F-FX-7 のぼかし／モザイク、F-FX-3 の回転／反転）を全て builtin として `defineEffect` で実装。契約の実証 | `registry/effects/builtin/*.ts` | ゴールデン各 1 本。`requires` に `gblur` / `lut3d` 等を宣言し doctor が検出 | P0-3 | M |
| **P1-4** | **ジェネレータ／トランジションの開放**。`GeneratorClipSchema.generator` の enum を外しレジストリ化（`color` / `hold` を builtin に）。トランジションは既に `type` 素通しなので `defineTransition()` で別名・パラメータ検証・`requires` だけ載せる | `core/schema.ts:273`、新 `registry/generators.ts`、`registry/transitions.ts`、`cli/commands/transition.ts:32` | 既存スナップショット不変 | P0-2 | S |

**Phase 1 の完了条件**: `montash effect add c1 blur --radius 12` が W-18.sh で通り、同じ操作を project.json の宣言だけで再現でき、`montash schema` に effect のパラメータが型付きで載る。

### Phase 2 — 外部プラグイン（M6 後半）

| PR | 内容 | 触る場所 | テスト | 依存 | サイズ |
|----|------|----------|--------|------|--------|
| **P2-1** | **プラグインホスト**。`src/plugins/` 新設: `manifest.ts`（`montash-plugin.json` の zod）、`loader.ts`（探索順 `.montash/plugins/` → `~/.local/share/montash/plugins/`、`await import()`、`apiVersion` 受理範囲）、`host.ts`（プラグインに渡す API: 時間変換・ID 採番・ログ・ffmpeg 機能問い合わせ・各レジストリの register）。`definePlugin()` / `defineEffect()` の型を `src/plugin-api/` に切り出し、プラグイン作者が import する公開面を明確化 | 新 `src/plugins/*`、`src/plugin-api/*`、`cli/index.ts`（起動時ロード） | 単体: fixtures のプラグインをロードし effect が登録される。apiVersion 不一致で `E_PLUGIN_INCOMPATIBLE` | P0-6, P1-1 | L |
| **P2-2** | **`plugin` コマンド群と `requires`**。`plugin list` / `plugin install <dir|tgz>` / `plugin remove` / `plugin doctor`。`project.plugins.requires[]` に `{ id, apiVersion, version }` を記録し、`validate` / `doctor` が不足を `E_PLUGIN_MISSING` で報告。**W-19「プラグインを導入して使う」** を 03 章に先に書く | 新 `cli/commands/plugin.ts`、`core/schema.ts`（`project.plugins`）、`core/validate.ts` | W-19.sh 新設（fixtures の glow プラグインを入れて effect add → render） | P2-1 | M |
| **P2-3** | **単一バイナリとの両立検証**（B-2 と統合）。`bun build --compile` 後のバイナリから外部プラグインを `import()` できるか、`import.meta.dir` / `process.execPath` の解決、プラグイン側が `montash/plugin-api` を解決できるか（グローバル注入 or 自己完結の判断）。結果を 12 章 ADR-18 の実機検証欄に記録 | `scripts/build.ts`、`src/plugins/loader.ts` | `scripts/spikes/plugin-compile.ts` | P2-1 | M |
| **P2-4** | **Level C（解析・プロセス）の権限**。マニフェストの `capabilities: ["analyze", "process"]`。`analyze()` は `GraphOptions` への値注入（ducking と同型）、`process` は `run.ts` 経由でのみ起動。`plugin install` 時に capabilities を表示し `--yes` 無しでは確認 | `src/plugins/host.ts`、`ffmpeg/graph/types.ts:37`、`ffmpeg/run.ts` | 単体: 権限未宣言で analyze を呼ぶと拒否 | P2-2 | M |

**Phase 2 の完了条件**: fixtures のプラグイン 1 本を `plugin install` し、W-19.sh が通る。プラグインを外した環境で同じ project.json を開けて、レンダー時にだけ `E_PLUGIN_MISSING` と `hint: montash plugin install ...` が出る。

### Phase 3 — I/O と Web（M7）

| PR | 内容 | 依存 | サイズ |
|----|------|------|--------|
| **P3-1** | importer / exporter レジストリ（`io`）。`import` の probe 分岐と `render` のプリセット解決をレジストリ経由に。exporter は `render_presets` の一般化 | P2-4 | L |
| **P3-2** | Web の **spec 駆動フォーム**。`GET /api/specs`（06 章 §3.6 の `/api/cli-examples` を置き換え、`schema` と同じ内容 + effect params）。Inspector を固定 `<dl>` から spec 駆動へ。未知種別（opaque）は「プラグイン不足」バッジ | P0-2, P1-1 | M |
| **P3-3** | **許可リスト連携**。`serve --allow/--deny` を配線（`cli-exec.ts:93` の `allowlist` は既に受け口あり）。プラグインがマニフェストで `webAllow: ["effect set"]` を宣言すると許可リストに合成 | P2-1 | S |
| **P3-4** | commands プラグイン（汎用）。`definePlugin().commands[]` を `getCommands()` に合成。Web からは P3-3 経由でのみ実行 | P0-6, P2-1 | S |

### やらないこと（計画外として明記）

- ピクセル単位の加工 API（ffmpeg 委譲の原則を崩す）
- プラグインからの project.json 直接書き込み（履歴の完全性を崩す）
- Web への UI プラグインコード投入（`web/` は 1 バンドルのまま。フォームは spec 駆動のみ）
- 独自トラック種別（`TrackKindSchema` は当面閉じたまま）
- プラグインの署名・サンドボックス（単一ユーザー・localhost 前提。導入は人間が明示的に行う）

---

## 2. ドキュメント修正計画

作業手順開発の順序（手順 → コマンド → データ → ffmpeg → ロードマップ → テスト）に従って改訂する。**先に書くべき順**に並べる。各行は対応する実装 PR と同じ PR で改訂する（仕様と実装を同時に動かす）。

| 順 | 文書 | 修正内容 | 対応 PR |
|----|------|----------|---------|
| 1 | **`docs/03-workflows.md`** | **W-18「クリップに効果を掛ける」**（ぼかし・色補正・LUT を掛け、プレビューで確認し、パラメータを調整して確定する手順。失敗手順: 未対応フィルタ→doctor 案内）、**W-19「プラグインを導入して使う」**（`plugin install` → `doctor` → `effect add` → プラグイン無し環境で開いたときの挙動）を追加 | P1-1, P2-2 |
| 2 | **`docs/04-cli-spec.md`** | §effect（add/set/remove/list/presets、params 由来オプションの規則、`--dry-run` 出力）、§plugin（list/install/remove/doctor）、§generator の種別開放、`serve --allow/--deny` を未実装から実装へ、§1.9 実装状況の更新、エラーコード表に `E_PLUGIN_MISSING` / `E_PLUGIN_INCOMPATIBLE` / `W_UNKNOWN_CLIP_TYPE` | P1-1, P2-2, P3-3 |
| 3 | **`docs/05-project-format.md`** | §3 `schema_version: 3`、§6 全クリップに `type` 必須（判別キー表）と `OpaqueClip`、`effects` を全種別へ、**§9a `effects`（宣言エフェクト: template とプレースホルダ、許可文字）**、**§10a `plugins`（`requires[]`）**、ID プレフィックス規約（多文字・レジストリ宣言）、§13 に v2→v3 の変換規則と `pre-migrate-v2` タグ、§14 不変条件に「未知種別は保持し警告」 | P0-1, P0-2, P0-3, P0-5, P1-2, P2-2 |
| 4 | **`docs/07-ffmpeg-mapping.md`** | §3 に **エフェクト挿入位置**（`normalizeVideoClip` の `format=` 直前、順序は `effects[]` の配列順）と §8 音声の同スロット、**§3a エフェクトレジストリ ⇄ ffmpeg フィルタ対応表**（builtin: eq / gblur / lut3d / hflip / transpose…）、`requires` と `doctor` 検出の関係、§11 プレビューのキャッシュ指紋が `filterComplex` 経由で追随すること・外部ファイル参照時の指紋追加 | P0-3, P1-3 |
| 5 | **`docs/14-plugin-architecture.md`（新設）** | 契約仕様の正: 供給元 3 種と信頼モデル、拡張点 6 種、`definePlugin` / `defineEffect` / `defineGenerator` / `defineTransition` の型、params DSL、能力 3 段階（A 宣言 / B 純関数 / C 解析・プロセス）と capabilities、host API の全メソッド、`montash-plugin.json` マニフェスト、探索順と優先規則、`apiVersion` 互換規則（ホストの受理範囲、非互換時の挙動）、プラグイン不在時の挙動（保持・警告・`E_PLUGIN_MISSING`）、やらないこと | P2-1（骨格は P0-3 で先行起こし） |
| 6 | **`docs/06-web-preview.md`** | §3.2 に `GET /api/specs`（§3.6 `/api/cli-examples` を置き換え）、§3.3 許可リストに `effect *` とプラグイン宣言の合成、§2 Inspector の spec 駆動フォームと opaque クリップの表示、`serve --allow/--deny` | P3-2, P3-3 |
| 7 | **`docs/08-architecture.md`** | §2 に `src/registry/`、`src/plugins/`、`src/plugin-api/` を追加、依存方向図に `registry/`（core と ffmpeg の間）と `plugins/`（cli からのみ）を追加、§3 に「起動時プラグインロード」「effect 展開」のフロー、§4.5 セキュリティにプラグインの信頼モデル | P0-3, P2-1 |
| 8 | **`docs/11-history-model.md`** | プラグイン領域（`project.plugins`、`project.effects`、opaque クリップ）の変更も汎用 `diffJson` で op になること、`extractAffects` を `effects` パスに拡張、checkout 先にプラグイン不足がある場合の挙動（展開はする・レンダーで失敗） | P0-2, P2-2 |
| 9 | **`docs/12-tech-decisions.md`** | **ADR-18 プラグイン方式**（AviUtl2 方式の翻訳、ピクセル API を持たない理由、実機検証: 単一バイナリからの `import()`）、**ADR-19 クリップ種別の開放**（閉じた union → discriminatedUnion + opaque、v3 移行）、**ADR-20 供給元 3 種と信頼モデル**（宣言優先、capabilities、署名をしない判断） | P0-2, P2-1, P2-3 |
| 10 | **`docs/13-open-issues.md`** | **D-13〜D-18** を起票（Phase 0 の 6 件。各行に本計画の PR 番号）、B-2 を P2-3 に紐付け、C-10「プラグイン API の互換性維持方針（semver / 非推奨期間）」、決定ログに 2026-09-15 の方針決定 | PR-0 |
| 11 | **`docs/09-roadmap.md`** | M5 に Phase 0 を追加、**M6「プラグイン」（Phase 1〜2）**、**M7（Phase 3）** を新設、「以降（Could）」の F-FX-7 / F-FX-8 を M6 に前倒し、トレーサビリティ表に W-18 / W-19 行 | PR-0（骨子）、各 PR で状態更新 |
| 12 | **`docs/02-requirements.md`** | 機能要件に **F-EXT-1〜4**（宣言エフェクト、外部プラグイン、プラグイン不在時の保持、`doctor` による依存検査）、非機能に「プラグインは純関数。I/O は宣言した capabilities の範囲」 | PR-0 |
| 13 | **`docs/10-ai-operation-guide.md`** | AI 向け: `effect` の使い方（`schema` にパラメータが載る → そのまま引数に）、`E_PLUGIN_MISSING` を受けたときの手順（`plugin doctor` → 人間に導入を依頼。AI は `plugin install` を自律実行しない）、`--dry-run` でフィルタを確認する習慣 | P1-1, P2-2 |
| 14 | **`docs/01-concept.md`** | §2 の役割図に「プラグイン（外部）」を 1 行、§3 設計原則に **3.6 拡張はレジストリ経由**（組み込みも同じ経路を通す） | PR-0 |
| 15 | **`README.md`** | 基本方針に **8「拡張はプラグイン、加工は ffmpeg」**、ドキュメント一覧に 14 章、用語に「エフェクト」「プラグイン」「レジストリ」 | PR-0 |
| 16 | **`website/`（ja / en）** | `guides/effects`（W-18 に対応）、`guides/plugins`（W-19 と導入手順）、`reference/plugin-api`（14 章の利用者向け要約）、`reference/cli` の再生成（`effect` / `plugin` 追加） | P1-1, P2-2 |

**準備 PR（PR-0）で先に改訂するもの**（実装に着手する前に合意を固定する分。本計画書の承認後に出す）: 10（13 章の起票）、11（09 章の骨子）、12（02 章の要件）、14（01 章の原則）、15（README）。それ以外は対応する実装 PR に同梱する。

---

## 3. 進め方の確認事項

- **1 PR = 1 課題**。実装 PR は対応する仕様章の改訂を同梱し、`bun run verify` をローカルで通してからマージする。
- **Phase 0 の P0-4 / P0-5 / P0-6 は本線（P0-1→2→3）と並行**してサブエージェントで進める。Phase 1 の P1-3 / P1-4 も P1-1 と並行可。
- **schema_version 3 への移行は P0-1 と P0-2 を続けてマージ**し、その間は main を v3 未完成の状態に置かない（P0-1 は機構だけで v3 は宣言しない）。
- 手順（W-18 / W-19）は対応する実装 PR の**冒頭コミット**で 03 章に書き、コマンドを逆算する。
