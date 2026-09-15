# サードパーティのライセンス表記 / Third-party notices

montash 本体は [MIT License](./LICENSE) です。以下は montash が利用しているソフトウェアの表記です。

> **要点**: npm 依存はすべて MIT / ISC / Apache-2.0 の許諾的ライセンスです。**ffmpeg だけは別扱い**で、montash は ffmpeg を同梱せず外部プロセスとして呼び出します。導入するビルドによってライセンスが変わるため、[ffmpeg](#ffmpeg) の節を必ず読んでください。

## ffmpeg

montash はエンコード・デコードのすべてを **ffmpeg / ffprobe** に委ねます。ffmpeg は montash に**同梱されておらず**、実行時に外部プロセスとして起動されるだけです（`Bun.spawn` による別プロセス実行。ライブラリとしてリンクしていません）。

- ffmpeg 本体: **LGPL-2.1 以降**。ただしビルド構成によっては **GPL-2.0 以降**（`--enable-gpl` でのみ使える `libx264` / `libx265` などを含む場合）
- 公式サイト: https://ffmpeg.org/ ／ ライセンスの説明: https://ffmpeg.org/legal.html

**`scripts/install-deps.sh` が導入するもの**:

| プラットフォーム | 導入されるビルド | ライセンス |
|---|---|---|
| macOS | Homebrew の `ffmpeg-full`（libass / libfreetype / libx264 入り） | Homebrew の formula に従う。`libx264` を含むため実質 **GPL** |
| Linux / WSL | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) の **GPL** static ビルド（取得不可なら [johnvansickle.com](https://johnvansickle.com/ffmpeg/) の static ビルド） | **GPL-3.0 以降**（ビルドの表記に従う） |

montash は MIT のままですが、**GPL ビルドの ffmpeg を使って作業する場合、その ffmpeg バイナリの再配布には GPL の条件が及びます**。ffmpeg を自分で用意したい場合は `--ffmpeg-path` / `MONTASH_FFMPEG` で任意のバイナリを指定できます（`montash doctor` が必要な機能の有無を確認します）。

ffmpeg が内部で使う主なライブラリ:

| ライブラリ | 用途 | ライセンス |
|---|---|---|
| libx264 | H.264 エンコード | GPL-2.0-or-later |
| libx265 | H.265 エンコード | GPL-2.0-or-later |
| libass | 字幕・テロップの描画（ASS） | ISC |
| FreeType | フォントのラスタライズ | FTL または GPL-2.0 |
| fontconfig | フォント検索 | MIT 系 |

## ランタイム

| 名前 | 用途 | ライセンス |
|---|---|---|
| [Bun](https://bun.sh/) | ランタイム / パッケージマネージャ / テストランナー / バンドラ | MIT（同梱する JavaScriptCore は LGPL-2.1、その他の構成要素の表記は Bun の LICENSE.md を参照） |

Bun も montash には同梱されず、利用者の環境にインストールされたものを使います。

## npm 依存（直接依存）

| パッケージ | バージョン | ライセンス | 用途 |
|---|---|---|---|
| [yargs](https://github.com/yargs/yargs) | 17.7.3 | MIT | CLI の引数解析 |
| [zod](https://github.com/colinhacks/zod) | 4.6.5 | MIT | `project.json` とコマンド引数のスキーマ検証 |
| [chokidar](https://github.com/paulmillr/chokidar) | 4.0.3 | MIT | `project.json` と履歴の変更監視 |
| [react](https://github.com/facebook/react) | 19.3.0 | MIT | Web プレビュー UI |
| [react-dom](https://github.com/facebook/react) | 19.3.0 | MIT | 同上 |
| [zustand](https://github.com/pmndrs/zustand) | 5.0.15 | MIT | Web の状態管理 |
| [@biomejs/biome](https://github.com/biomejs/biome) | 2.5.13 | MIT OR Apache-2.0 | lint / format（開発時のみ） |
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 | 型検査（開発時のみ） |
| [playwright](https://github.com/microsoft/playwright) | 1.63.0 | Apache-2.0 | ブラウザ E2E（開発時のみ） |
| [@types/bun](https://github.com/DefinitelyTyped/DefinitelyTyped) | 1.4.2 | MIT | 型定義（開発時のみ） |
| [@types/react](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.3.0 | MIT | 型定義（開発時のみ） |
| [@types/react-dom](https://github.com/DefinitelyTyped/DefinitelyTyped) | 19.3.0 | MIT | 型定義（開発時のみ） |
| [@types/yargs](https://github.com/DefinitelyTyped/DefinitelyTyped) | 17.0.35 | MIT | 型定義（開発時のみ） |

推移的依存を含めた全 37 パッケージの内訳: **MIT 28 / ISC 4 / Apache-2.0 3 / MIT OR Apache-2.0 2**。GPL・LGPL・AGPL の npm 依存はありません。

## ドキュメントサイト（`website/`）

| パッケージ | ライセンス | 用途 |
|---|---|---|
| [Astro](https://github.com/withastro/astro) | MIT | 静的サイト生成 |
| [@astrojs/starlight](https://github.com/withastro/starlight) | MIT | ドキュメントテーマ（i18n を含む） |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 | 画像最適化（libvips は LGPL-3.0、別プロセス／動的リンク） |

## 表記の更新

依存を追加・更新したら、次で一覧を取り直してこのファイルを更新してください。

```bash
bun run licenses
```
