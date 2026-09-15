---
title: ライセンス
description: montash のライセンス
---

:::caution[未確定]
montash の `package.json` は `"license": "MIT"` と宣言していますが、
**リポジトリ直下に `LICENSE` ファイルがまだありません**。

現時点では **MIT License を予定**、という状態です。
著作権者名と年を確定して `LICENSE` を追加することは、内部の課題一覧（`docs/13-open-issues.md` の C-8）に
起票してあります。`LICENSE` が追加されたら、このページもその内容に合わせて更新されます。
:::

## いま分かっていること

| 項目 | 内容 |
|------|------|
| 宣言 | `package.json` の `"license": "MIT"` |
| `LICENSE` ファイル | **無し**（追加予定） |
| リポジトリ | [TakehiroTada/montash](https://github.com/TakehiroTada/montash) |

商用利用や再配布など、ライセンスの条件が重要になる使い方をお考えの場合は、
`LICENSE` ファイルが追加されるまでお待ちいただくか、リポジトリの Issue でご確認ください。

## 依存しているソフトウェア

montash 自体のライセンスとは別に、次のソフトウェアに依存しています。

| ソフトウェア | 役割 | 注意 |
|-------------|------|------|
| [ffmpeg / ffprobe](https://ffmpeg.org/) | エンコード・デコード・フィルタ処理 | **montash には同梱されません。** 利用者が自分で導入します。ffmpeg 自体のライセンス（LGPL / GPL、ビルドに含まれるライブラリによって変わります）は、お使いのビルドの条件に従ってください |
| [Bun](https://bun.sh/) | ランタイム・パッケージマネージャ | MIT |

`scripts/install-deps.sh` が Linux / WSL に導入する static ビルドは **GPL ビルド**（libx264 / libx265 / libass を含む）です。
成果物の再配布を伴う用途では、お使いの ffmpeg ビルドのライセンス条件をご確認ください。
