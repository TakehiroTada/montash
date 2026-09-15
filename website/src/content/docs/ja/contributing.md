---
title: 開発に参加する
description: montash の開発に参加するための手引き
---

montash は [TakehiroTada/montash](https://github.com/TakehiroTada/montash) で開発しています。

## 開発環境

```bash
git clone https://github.com/TakehiroTada/montash.git
cd montash
bash scripts/install-deps.sh --with-fonts     # ffmpeg / Bun / 日本語フォント
bun install
bun run doctor                                # 環境の確認
```

CLI はコンパイルせずにそのまま動かせます。

```bash
bun run dev -C ./my-edit timeline show        # montash timeline show と同じ
bun run dev -C ./my-edit serve --dev          # Web UI を HMR 付きで開発する
```

## 検査を通す

**PR を出す前に `bun run check` を通してください。** CI と同じ内容（typecheck + lint + テスト）です。

```bash
bun run check         # = typecheck + lint + test
bun run typecheck     # tsc --noEmit
bun run lint          # Biome（lint + format チェック）
bun run lint:fix      # 自動修正
bun test              # 単体テスト
```

### E2E テスト

```bash
bunx playwright install --with-deps chromium   # 初回のみ
bash tests/workflows/run-all.sh                # 実装済みの作業手順（W-01〜）を検証する
bun run e2e:preview                            # プレビューの E2E
```

## 技術的な前提

- **ランタイムは Bun に統一しています。** CI は `node` を潰した `PATH` で typecheck と lint を実行し、Node が混ざったら落ちるようになっています
- TypeScript は strict。lint / format は [Biome](https://biomejs.dev/)
- 依存: yargs（CLI）、zod（スキーマ）、chokidar（ファイル監視）、React 19 + zustand + canvas（Web UI）
- 選定理由と実機検証の記録は `docs/12-tech-decisions.md` にあります

:::note[ドキュメントサイトだけは例外]
`website/` の Astro + Starlight は Node 前提のツールチェーンです。
パッケージ管理は bun（`bun install`）で行いますが、Astro 自体は Node で動かします。
このサイトは **CI に含めていません**。
:::

## リポジトリの構成

| ディレクトリ | 内容 |
|-------------|------|
| `src/cli/` | CLI のコマンド実装。1 コマンド 1 ファイルで、`src/cli/commands/registry.ts` に登録する |
| `src/` | コア（プロジェクトモデル、履歴、ffmpeg 連携） |
| `web/` | ブラウザ UI（React 19 + canvas） |
| `tests/` | 単体テストと作業手順の E2E |
| `scripts/` | 依存導入、フィクスチャ生成、E2E スクリプト |
| `docs/` | **開発者向けの内部仕様書**（01〜13 章） |
| `website/` | **利用者向けのドキュメントサイト**（このサイト） |

内部仕様書（`docs/`）はこのサイトとは別物です。設計の経緯や ffmpeg への対応表など、
実装するときに必要な情報はそちらにあります。

## 新しいコマンドを足す

1. `src/cli/commands/` にファイルを作り、`defineCommand()` でコマンドを定義する
2. `src/cli/commands/registry.ts` に 1 行追加する（`docs/04-cli-spec.md` の順に並べる）
3. `montash schema --json` に出ることを確認する
4. このサイトの CLI リファレンスを再生成する

```bash
cd website && bun run gen:cli
```

CLI リファレンスは `montash schema --json` から自動生成しているので、**手で書き足す必要はありません**。
生成物（`website/src/content/docs/{ja,en}/reference/cli.md`）はコミットしてください。

## PR の出し方

1. `main` からブランチを切る
2. レビューできる単位にまとめる（1 PR に詰め込みすぎない）
3. `bun run check` を通す
4. PR を出し、CI が緑になったことを確認する
5. セルフレビューして、気付いた点は自分で直す

コミットメッセージのトレーラーなど、リポジトリ固有の作業ルールは `AGENTS.md` にあります。

## ドキュメントサイトに手を入れる

```bash
cd website
bun install
bun run dev              # http://localhost:4321
bun run build            # astro check + astro build
bun run preview
bun run gen:cli          # CLI リファレンスを再生成する
```

**日本語版と英語版の両方を更新してください。** 構成と翻訳の追加方法は `website/README.md` にあります。
