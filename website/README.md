# website — montash の利用者向けドキュメントサイト

[Astro](https://astro.build/) + [Starlight](https://starlight.astro.build/) で作った、**利用者向け**のドキュメントサイトです。
日本語（既定）と英語の 2 言語に対応しています。

リポジトリ直下の `docs/`（01〜13 章）は**開発者向けの内部仕様書**で、このサイトとは別物です。
このサイトは内部仕様の丸写しではなく、「montash を使う人が読むもの」として書き下ろしています。

## 起動する

```bash
cd website
bun install
bun run dev        # http://localhost:4321
```

| コマンド | 内容 |
|---------|------|
| `bun run dev` | 開発サーバを起動する |
| `bun run build` | `astro check`（型・リンク検査）のあと `dist/` に静的サイトを生成する |
| `bun run preview` | `dist/` をローカルで配信して確認する |
| `bun run gen:cli` | CLI リファレンスを `montash schema --json` から再生成する |

### パッケージマネージャと Node について

依存の管理は **bun**（`bun install`）で行いますが、**Astro 自体は Node で動かします**。
Astro / Vite のツールチェーンは Node を前提にしており、`bunx --bun astro` では動かない部分があるためです。
リポジトリ全体のルール（「ランタイムは Bun に統一する」）に対して、**このサイトだけが例外**です。

そのため `website/` は**ルートの CI（`.github/workflows/ci.yml`）に含めていません**。
ルートの CI は `node` を潰した `PATH` で typecheck と lint を実行するため、このサイトはそこでは動きません。
サイトのビルドを CI に入れるかどうかは、公開先を決めるときに別途判断します（`docs/13-open-issues.md` の C-9）。

`bun run gen:cli` だけは Bun で動きます（`bun scripts/gen-cli-reference.ts`）。

## ディレクトリ構成

```
website/
├── astro.config.mjs               Starlight の設定（i18n・サイドバー・ソーシャルリンク）
├── package.json
├── tsconfig.json
├── scripts/
│   └── gen-cli-reference.ts       CLI リファレンスの生成スクリプト
└── src/
    ├── content.config.ts          docs / i18n コレクションの定義
    ├── assets/                    画像などを置く場所（外部 CDN・フォントは使わない）
    └── content/
        ├── i18n/                  Starlight の UI 文字列の上書き（ja.json / en.json）
        └── docs/
            ├── 404.md             404 ページ（日英併記）
            ├── ja/                日本語のページ
            │   ├── index.mdx      ランディング（template: splash）
            │   ├── guides/        ガイド 10 本
            │   ├── reference/     CLI・プロジェクトファイル・用語集
            │   ├── contributing.md
            │   └── license.md
            └── en/                英語のページ（ja と同じ構成）
```

`ja/` と `en/` は**同じファイル構成**を保ってください。
どちらか片方にしか無いページがあると、言語切り替えのリンクが切れます。

## CLI リファレンスの自動生成

`src/content/docs/{ja,en}/reference/cli.md` は **`montash schema --json` の出力から生成しています**。
手で編集しないでください。

```bash
cd website
bun run gen:cli
```

生成スクリプトは `scripts/gen-cli-reference.ts` です。リポジトリ直下の `bun ../src/cli/index.ts schema --json`
を実行し、全コマンドの引数・オプション・既定値・例を Markdown の表に落とします。

- 出力は決定的です（同じ schema からは必ず同じ Markdown が出る）ので、差分が出たら CLI 側が変わったということです
- **生成物はコミットしてください。** サイトのビルドに CLI の実行環境は不要です
- 日本語ページのコマンド要約は、スクリプト内の `summaryJa` 辞書で翻訳しています。
  未登録の要約は英語のまま出力されるので、CLI 側の文言が変わっても生成は壊れず、古い訳が残ることもありません
- コマンドを追加・変更したら `bun run gen:cli` を実行し、差分をコミットしてください

## i18n の仕組み

`astro.config.mjs` で Starlight の i18n 機能を使っています。

```js
defaultLocale: "ja",
locales: {
  ja: { label: "日本語", lang: "ja" },
  en: { label: "English", lang: "en" },
},
```

- コンテンツは `src/content/docs/<lang>/**` に置きます（`ja/guides/quickstart.mdx` → `/ja/guides/quickstart/`）
- サイドバーの `slug` は**言語プレフィックスを含めずに**書きます（`guides/quickstart`）。Starlight が現在の言語に解決します
- サイドバーのラベルは `translations` で出し分けます

  ```js
  { label: "ガイド", translations: { en: "Guides" }, items: [...] }
  ```

- `label` は既定言語（日本語）の表示、`translations` にそれ以外の言語を書きます
- Starlight 自身の UI 文字列（「目次」「前のページ」など）は Starlight が翻訳を同梱しているので、通常は何もしなくて構いません。
  上書きしたい場合は `src/content/i18n/<lang>.json` に書きます
- 両言語ともプレフィックスを持つ構成なので、`/` は `astro.config.mjs` の `redirects` で `/ja/` へ飛ばしています

### 新しい言語を足す手順

例として韓国語（`ko`）を足す場合。

1. `astro.config.mjs` の `locales` に追加する

   ```js
   locales: {
     ja: { label: "日本語", lang: "ja" },
     en: { label: "English", lang: "en" },
     ko: { label: "한국어", lang: "ko" },
   },
   ```

2. サイドバーの `translations` に追加する

   ```js
   { label: "ガイド", translations: { en: "Guides", ko: "가이드" }, items: [...] }
   ```

3. `src/content/docs/ko/` を作り、`ja/` と**同じファイル構成**でページを用意する

   ```bash
   cd website/src/content/docs
   rsync -a --include='*/' --exclude='*' ja/ ko/     # ディレクトリ構造だけコピー
   ```

   `index.mdx`、`guides/*.mdx`、`reference/*.md`、`contributing.md`、`license.md` をすべて用意します。
   ページ内のリンク（`/ja/guides/...`）も新しい言語のパスに書き換えてください。

4. CLI リファレンスの生成に対応させる

   `scripts/gen-cli-reference.ts` の `Lang` 型と `t` オブジェクトに `ko` を足し、末尾のループの
   `["ja", "en"]` に `"ko"` を加えます。コマンド要約の翻訳辞書を用意する場合は `summaryJa` と同じ形で追加します
   （辞書が無ければ英語にフォールバックします）。

5. 必要なら `src/content/i18n/ko.json` で Starlight の UI 文字列を上書きする

6. `bun run gen:cli && bun run build` で確認する

## 公開先の設定

`astro.config.mjs` には `site` / `base` を設定していません。公開先が決まったら追加してください。

```js
export default defineConfig({
  site: "https://example.com/montash",   // 正規 URL。サイトマップの生成にも必要
  base: "/montash",                      // サブパスに置く場合のみ
  // ...
});
```

`site` が未設定の間、ビルド時に `@astrojs/sitemap` の警告が出ますが、サイト自体は正常に生成されます。

## 書くときの決まりごと

- 本文は日本語版が日本語、英語版が英語
- **コードブロックは実際に動くコマンドにする。** 存在しないオプションを書かないこと。
  不明なら `bun ../src/cli/index.ts <command> --help` か `montash schema --json` で確認する
- 未実装の機能に触れるときは「未実装」であることを明記する
- 外部 CDN・外部フォントは使わない。画像が必要なら `src/assets/` に置く
- 日英どちらか片方だけを更新しない
