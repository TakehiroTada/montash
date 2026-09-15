---
title: ライセンス
description: montash のライセンスと、依存しているソフトウェアの表記
---

montash は **MIT License** です。

- [LICENSE](https://github.com/TakehiroTada/montash/blob/main/LICENSE) — Copyright (c) 2026 Takehiro Tada
- [THIRD-PARTY-NOTICES.md](https://github.com/TakehiroTada/montash/blob/main/THIRD-PARTY-NOTICES.md) — 依存しているソフトウェアの一覧

## ffmpeg の扱い（重要）

montash はエンコード・デコードのすべてを **ffmpeg / ffprobe** に委ねますが、**ffmpeg を同梱していません**。実行時に外部プロセスとして起動するだけで、ライブラリとしてリンクしていません。そのため montash 本体は MIT のままです。

ただし、**利用者が導入する ffmpeg のビルドにはそれぞれのライセンスが適用されます**。

| 導入方法 | 入るビルド | ライセンス |
|---|---|---|
| `scripts/install-deps.sh`（macOS） | Homebrew の `ffmpeg-full` | libx264 を含むため実質 **GPL** |
| `scripts/install-deps.sh`（Linux / WSL） | [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) の GPL static ビルド | **GPL-3.0 以降** |
| 自分で用意する | 任意 | そのビルドの条件に従う |

**その ffmpeg バイナリを再配布する場合は GPL の条件が及びます。**自分で用意した ffmpeg を使いたい場合は `--ffmpeg-path` または環境変数 `MONTASH_FFMPEG` で指定できます（`montash doctor` が必要な機能の有無を確認します）。

ffmpeg のライセンスについては [ffmpeg.org/legal.html](https://ffmpeg.org/legal.html) を参照してください。

## ランタイムと依存

| ソフトウェア | 役割 | ライセンス |
|---|---|---|
| [Bun](https://bun.sh/) | ランタイム / パッケージマネージャ / テスト / バンドラ | MIT（同梱されず、利用者の環境のものを使う） |
| yargs / zod / chokidar / react / react-dom / zustand | CLI と Web の実装 | MIT |
| TypeScript / Playwright | 型検査・ブラウザ E2E（開発時のみ） | Apache-2.0 |
| Biome | lint / format（開発時のみ） | MIT OR Apache-2.0 |

推移的依存を含めた npm パッケージ 37 個の内訳は **MIT 28 / ISC 4 / Apache-2.0 3 / MIT OR Apache-2.0 2** で、コピーレフト（GPL / LGPL / AGPL）のものはありません。一覧は [THIRD-PARTY-NOTICES.md](https://github.com/TakehiroTada/montash/blob/main/THIRD-PARTY-NOTICES.md) にあり、`bun run licenses` で再生成できます。

## このサイト

[Astro](https://astro.build/)（MIT）と [Starlight](https://starlight.astro.build/)（MIT）で作られています。
