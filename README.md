# montash — CLI 動画編集ソフト

**montash** = **montage**（モンタージュ: 素材を繋いで意味を作る、編集の本質）+ **sh**（シェル）。
AI（LLM）が人間のプロンプト指示を受けて **CLI コマンドだけで動画編集を完結させる** ための動画編集ソフトです（GitHub: [TakehiroTada/montash](https://github.com/TakehiroTada/montash)）。
編集状態はプロジェクトファイル（JSON）として宣言的に保持し、最終的なエンコードは ffmpeg に委譲します。
プレビュー・シークバー・タイムラインの可視化、作業履歴（History）の閲覧と移動、素材の管理はローカル Web アプリが担います。Web からの操作もすべて `montash` コマンドの発行として実行・記録されます。

```
人間 ──(自然言語)──▶ AI ──(montash コマンド)──▶ project.json ──(montash render)──▶ ffmpeg ──▶ 成果物.mp4
                                                   │
                                                   └──(montash serve)──▶ Web プレビュー（ブラウザで確認）
```

## 基本方針

| # | 方針 | 意味 |
|---|------|------|
| 1 | **CLI ファースト** | すべての編集操作は `montash <subcommand>` で行う。GUI からの編集操作は提供しない |
| 2 | **AI が操作主体** | 出力は人間可読と機械可読（`--json`）の両方を備え、AI がエラーから自己修正できる |
| 3 | **宣言的・非破壊** | 元素材は一切書き換えない。`project.json` を編集状態の唯一の正とする |
| 4 | **ffmpeg に委譲** | エンコード／デコード／フィルタ処理はすべて ffmpeg / ffprobe |
| 5 | **bash 互換** | Windows WSL / Linux / macOS の bash で同じコマンドが動く |
| 6 | **Web の操作も CLI の発行** | Web UI からの操作（履歴の移動、素材管理）は例外なく対応する `montash` コマンドを発行して実行し、履歴に `actor: web` で記録される。タイムライン編集（ドラッグ等）は Web に持たず CLI で行う |
| 7 | **履歴は git のように** | すべての操作を op として自動記録し、AI が `montash commit -m "00:12〜00:15 をカット"` と意味付けする。任意時点へ `checkout` で即時に戻る／進む |

## ドキュメント構成（作業手順開発の流れ順）

作業手順開発では「**人間が実際に行う作業手順**」を最初に固定し、その手順の各ステップを満たす最小の機能を逆算して仕様化します。ドキュメントもその順序で並べています。

| 順 | ファイル | 内容 | 手順開発における位置づけ |
|----|----------|------|--------------------------|
| 1 | [docs/01-concept.md](docs/01-concept.md) | 設計思想と「作業手順開発」の進め方 | 考え方の共有 |
| 2 | [docs/02-requirements.md](docs/02-requirements.md) | 前提条件・機能要件・非機能要件・スコープ外 | 制約の確定 |
| 3 | [docs/03-workflows.md](docs/03-workflows.md) | **作業手順カタログ（W-01〜W-12）** | ★ 出発点。ここから全機能を導出 |
| 4 | [docs/04-cli-spec.md](docs/04-cli-spec.md) | CLI コマンド仕様（引数・出力・終了コード） | 手順のステップ → コマンド |
| 5 | [docs/05-project-format.md](docs/05-project-format.md) | `project.json` スキーマ・時間表記・履歴 | コマンドが操作する状態 |
| 6 | [docs/06-web-preview.md](docs/06-web-preview.md) | Web プレビューアプリ仕様（画面・API・WS） | 「確認する」ステップの実装 |
| 7 | [docs/07-ffmpeg-mapping.md](docs/07-ffmpeg-mapping.md) | 編集操作 → ffmpeg コマンド／フィルタ対応表 | 「書き出す」ステップの実装 |
| 8 | [docs/08-architecture.md](docs/08-architecture.md) | 技術構成・ディレクトリ・モジュール分割 | 実装の骨格 |
| 9 | [docs/09-roadmap.md](docs/09-roadmap.md) | マイルストーン・手順⇄コマンド⇄実装のトレーサビリティ | 開発順序 |
| 10 | [docs/10-ai-operation-guide.md](docs/10-ai-operation-guide.md) | AI がこの CLI を操作するときの指針・プロンプト例 | 運用 |
| 11 | [docs/11-history-model.md](docs/11-history-model.md) | git ライクな履歴モデル（op / commit / checkout / tag）と Web の History タイムライン | トレーサビリティ |
| 12 | [docs/12-tech-decisions.md](docs/12-tech-decisions.md) | 技術選定の決定記録（Bun / yargs / chokidar / React+canvas / 整数フレーム / libass）と実機検証結果 | 実装の前提 |
| 13 | [docs/13-open-issues.md](docs/13-open-issues.md) | 未解決の懸念一覧（要決定事項・技術リスク・進め方）と推奨対応 | 着手前の合意 |

## クイックスタート（想定される利用イメージ）

```bash
# 人間: 「この2本の動画をつなげて、間にクロスフェード入れて、冒頭にタイトル出して YouTube 用に書き出して」
# AI が組み立てるコマンド列:
montash init my-vlog --fps 30 --resolution 1920x1080
montash import ./raw/clip_a.mp4 ./raw/clip_b.mp4 --proxy
montash clip add --asset clip_a --track V1 --in 00:00:02.000 --out 00:00:14.500
montash clip add --asset clip_b --track V1 --at end
montash transition add --between c1 c2 --type crossfade --duration 0.8
montash text add --track V2 --text "Summer Trip 2026" --at 0 --duration 3 --preset title-center
montash audio fade --clip c2 --out 1.5
montash commit -m "clip_a/clip_b を結合し 0.8s クロスフェード、冒頭 3s にタイトル"   # 作業を意味のある単位で記録
montash serve --open           # ブラウザでプレビュー・タイムライン・History・素材を確認（人間が目視）
# 人間: 「さっきのタイトル無い方がいいな」→ Web の History で 1 つ前のコミットをクリック（即時に戻る）
montash render --preset youtube-1080p -o ./out/my-vlog.mp4
```

## 対象環境

- OS: Windows 10/11 (WSL2 上の Ubuntu 等) / Linux / macOS 12+
- シェル: bash 4+（fish / zsh からも実行可能だが、ドキュメント上は bash を前提）
- 依存: `ffmpeg` / `ffprobe`（4.4 以上で libx264・xfade・loudnorm 等を持つビルド。6.0 以上・libass 入り推奨。`montash doctor` が機能検出で判定）、**Bun 1.2+**（ランタイム・パッケージマネージャ・テスト・ビルド。詳細は 08 / 12 章）
- ブラウザ: Chromium 系 / Firefox / Safari の最新版（Web プレビュー）

## セットアップ

```bash
# 1. npm 管理外の依存（ffmpeg / Bun / 日本語フォント / WSL ツール）を確認・導入
bash scripts/install-deps.sh --check        # 確認のみ（終了コード 0=充足）。ffmpeg は機能検出で判定
bash scripts/install-deps.sh --with-fonts   # 不足分を確認プロンプト付きで導入（macOS: brew / Linux・WSL: sudo 不要の static ビルドを ~/.local へ）
bash scripts/install-deps.sh --static       # Linux・WSL でディストリ版が古い場合に最新 static ビルドを強制

# 2. パッケージ導入と環境診断
bun install
bun run doctor                              # = montash doctor

# 3. 開発
bun run dev                                 # CLI を bun で直接実行（bun src/cli/index.ts ...）
bun run dev:web                             # Bun.serve + HTML import（HMR）で Web UI を開発
bun test                                    # 単体テスト
bun run lint                                # Biome（lint + format チェック）。bun run lint:fix で自動修正
bun run check                               # typecheck + lint + test（CI と同じ）
bun run build && bun run compile            # web/dist を生成し、OS 別の単一バイナリ dist/montash-<os>-<arch> を作成
```

技術スタック: TypeScript（strict）/ Bun / yargs / zod / `Bun.serve` / chokidar 4 / React 19 + zustand + canvas / ffmpeg / Biome（lint・format）。選定理由と実機検証は [docs/12-tech-decisions.md](docs/12-tech-decisions.md)。

## 用語

| 用語 | 定義 |
|------|------|
| アセット (asset) | インポートした元素材（動画・音声・画像・字幕ファイル）。読み取り専用 |
| クリップ (clip) | アセットの一部区間（in/out）をタイムライン上の位置（start）に置いたもの |
| トラック (track) | クリップを時間軸に並べるレーン。`V1..Vn`（映像）、`A1..An`（音声） |
| タイムライン | トラックの集合。プロジェクトの編集結果そのもの |
| プロキシ (proxy) | プレビュー用の低解像度・軽量トランスコード |
| レンダー (render) | タイムラインを ffmpeg で 1 本の動画に書き出すこと |
| 作業手順 (workflow) | 人間が動画編集で行う一連の作業単位。`W-xx` で識別 |
| op（操作） | 状態を変えた CLI コマンド 1 回分の自動記録。`o_0042` |
| コミット (commit) | 連続する op にメッセージを付けてまとめた作業単位。`k_0007`。git のコミットに相当 |
| HEAD / checkout | 現在展開されている履歴上の位置／そこへ移動する操作。移動は即時 |
| tag | 履歴上の位置に付ける名前（旧スナップショット） |
