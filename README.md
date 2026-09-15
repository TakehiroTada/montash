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

## ドキュメント

利用者向けのドキュメントサイトを `website/` に置いています（Astro + Starlight、日本語・英語）。

```bash
cd website
bun install
bun run dev        # http://localhost:4321
```

| コマンド | 内容 |
|---------|------|
| `bun run dev` | 開発サーバ |
| `bun run build` | `astro check` のあと `dist/` に静的サイトを生成 |
| `bun run preview` | 生成したサイトをローカルで配信 |
| `bun run gen:cli` | CLI リファレンスを `montash schema --json` から再生成 |

CLI リファレンス（`website/src/content/docs/{ja,en}/reference/cli.md`）は `montash schema --json` の出力から
自動生成しています。**コマンドを追加・変更したら `cd website && bun run gen:cli` を実行し、差分をコミットしてください。**

構成と i18n（新しい言語の足し方）は [website/README.md](website/README.md) を参照。
なお `website/` は Astro（Node 前提）のツールチェーンを使うため、**ルートの CI には含めていません**。

下記の `docs/` は**開発者向けの内部仕様書**で、`website/` とは別物です。

## ドキュメント構成（作業手順開発の流れ順）

作業手順開発では「**人間が実際に行う作業手順**」を最初に固定し、その手順の各ステップを満たす最小の機能を逆算して仕様化します。ドキュメントもその順序で並べています。

| 順 | ファイル | 内容 | 手順開発における位置づけ |
|----|----------|------|--------------------------|
| 1 | [docs/01-concept.md](docs/01-concept.md) | 設計思想と「作業手順開発」の進め方 | 考え方の共有 |
| 2 | [docs/02-requirements.md](docs/02-requirements.md) | 前提条件・機能要件・非機能要件・スコープ外 | 制約の確定 |
| 3 | [docs/03-workflows.md](docs/03-workflows.md) | **作業手順カタログ（W-01〜W-17）** | ★ 出発点。ここから全機能を導出 |
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

## 現在実行できる編集（M3 完了）

プロジェクト作成・履歴管理、素材取り込みとプロキシ／サムネイル／波形の生成、カット範囲の指定と映像／音声のリンク配置、クリップ編集、トランジション・フェード、テロップ（ASS + libass）、字幕の焼き込み／多重化、音量調整・ダッキング・ラウドネス正規化、ロゴ／PiP のオーバーレイ、Web プレビューと履歴操作、MP4 書き出しまで実装済みです。

```bash
bun install
bun run dev init ./my-edit --fps 29.97 --resolution 1920x1080
bun run dev -C ./my-edit import ./raw/clip_a.mp4 ./raw/clip_b.mp4 --proxy
bun run dev -C ./my-edit assets list --json
bun run dev -C ./my-edit clip add --asset clip_a --in 1 --duration 3 --at end
bun run dev -C ./my-edit clip add --asset clip_b --in=-2 --at end
bun run dev -C ./my-edit timeline show --json
bun run dev -C ./my-edit commit -m "2本の素材から必要な区間を結合"
bun run dev -C ./my-edit render --preset youtube-1080p -o ./my-edit/out/edit.mp4 --dry-run
bun run dev -C ./my-edit render --preset youtube-1080p -o ./my-edit/out/edit.mp4
bun run dev -C ./my-edit render verify ./my-edit/out/edit.mp4 --json
```

`--in/--out/--duration` は秒・タイムコード・`f:17` 形式を受け付けます。`--in=-2` は素材末尾から2秒。`--dry-run` はプロジェクト・履歴・ID・出力を書き換えません。パスはコマンド実行時のカレントディレクトリ基準です。

現在のレンダーは映像トラックのカット結合とオーバーレイ合成、画像、空白区間、複数音声トラックのミックスに対応します。プリセットは `youtube-1080p` と `web-preview` の2つ。30／29.97／59.94fpsでカット位置・フレーム数をテストし、書き出し時にも映像フレーム数と音声尺を自動検証します。

クリップ編集は `clip move|trim|split|delete|set` とトラック操作（`track add|list|remove|mute|lock|move`）、ギャップ操作（`timeline gaps [--fill close|black]`）に対応します。`--ripple`（既定で全トラック、`--ripple=track` で当該トラックのみ、`locked` トラックは対象外）で編集点以降を詰め／押し出し、`clip split` は前半が元の ID を維持します。`clip move` は `--on-overlap error|overwrite|push` を受け付けます。

プレビューは `preview build` で `.montash/preview/timeline.mp4` を作ります。映像はカット点で切ったセグメントを `.montash/preview/segments/<hash>.mp4` にキャッシュして `concat`、音声はタイムライン全体を毎回1パスで `audio.m4a` に生成し、最後に `-c copy` で mux します（AACのpriming由来の継ぎ目クリックを避けるため。12章 ADR-11）。編集で位置だけが動いたセグメントはそのまま再利用されるので、2回目以降は concat と音声だけで済みます。`--from/--to` で部分再生成、`--audio-only` で音声のみ、`--height` で解像度を指定できます。状態は `preview status`（`ready` / `building` / `stale` / `missing`）。

`serve` は `project.json` の変更を1.5秒デバウンスしてから `preview build` を自動実行し、WebSocketで `preview.state` を通知します。ビルド中にさらに編集があればキャンセルして作り直します。自動生成を止めるには `serve --no-auto-preview`。`GET /preview/timeline.mp4` はRange対応・`ETag` はproject_hashで、ブラウザは再生成後も再生位置を保ったまま新しい版に差し替えます。Webの履歴表示はHEAD・pending・コミット・タグに追従し、ノードのクリックと `[` / `]` で移動できます。

トランジションは `transition add|set|remove|list`（`--between` / `--track --all-cuts` / `--at-cut`、`handle` / `overlap` モード、リンク音声の `acrossfade`）と `fade`（トラック／クリップ、`--with-audio`）に対応します。

テロップは `text add|set|remove|list|presets` と `fonts list`。ASS を生成して libass（`subtitles` フィルタ）で焼き込み、libass の無い環境では `drawtext` にフォールバックします（`W_TEXT_ENGINE_LIMITED`）。字幕ファイルは `subtitle add --mode burn|soft` で焼き込みまたは多重化。

音声は `audio gain|fade|duck|normalize|analyze|show|offset`。`duck` は `sidechaincompress`、`normalize` は 2 パス `loudnorm`、`offset` はサンプル単位の同期補正です。オーバーレイ（ロゴ・PiP）は `overlay add|set|remove|list`、速度変更は `clip set --speed`（`setpts` + `atempo`）。

`proxy build --thumbs --waveform` でサムネイル（スプライト JPEG + JSON）と波形（100 点/秒）を生成し、Web の編集タイムラインに表示します。

今後の実装（M4 以降）: `render` のコーデック個別指定・部分レンダー（`--from/--to`）・`--last`・`--hwaccel`・`--reframe`・`render batch`、`revert` / `blame` / `reset --hard` / `commit --amend`、`clip add --loop`、`clip show` / `clip link|unlink`、`batch` / `explain`、LUT、キーフレームアニメーション。コマンドごとの実装状況は [docs/04-cli-spec.md](docs/04-cli-spec.md) §1.9 と `montash schema --json` が正です。

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
bun run dev -C ./my-edit serve --dev         # 作成済みプロジェクトで Web UI を開発（HMR）
bun test                                    # 単体テスト
bunx playwright install --with-deps chromium # ブラウザE2E用（初回）
bash tests/workflows/run-all.sh              # 実装済み手順（W-01〜W-10, W-13〜W-17）を検証
bun run lint                                # Biome（lint + format チェック）。bun run lint:fix で自動修正
bun run check                               # typecheck + lint + test（CI と同じ）
bun run build:web                           # Web UI を web/dist に生成
bun run compile                             # 現在の OS 向け CLI を dist/montash にコンパイル
```

技術スタック: TypeScript（strict）/ Bun / yargs / zod / `Bun.serve` / chokidar 4 / React 19 + zustand + canvas / ffmpeg / Biome（lint・format）。選定理由と実機検証は [docs/12-tech-decisions.md](docs/12-tech-decisions.md)。

コンパイル版にWeb資産を埋め込む配布ビルドは未実装です。Web UI の開発・確認には上記の `bun run dev ... serve` を使用してください。

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
