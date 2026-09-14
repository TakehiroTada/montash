# scripts/spikes — Bun 互換性の再検証

`docs/12-tech-decisions.md` の各 ADR を裏付ける最小スクリプト。Bun のバージョンを上げたときに再実行し、`RESULT ...: OK` が全て出ることを確認する。

```bash
cd scripts/spikes && bun install
bun run all          # まとめて実行
# 個別
bun run watch.ts     # chokidar@4 と Bun 標準 fs.watch の検知比較（期待: chokidar OK / fs.watch は検知漏れの可能性）
bun run serve.ts     # Bun.serve: Range → 206 自動応答、WebSocket echo
bun run yargs.ts     # yargs のネストコマンド・エイリアス・日本語引数
bun run frontend.ts  # HTML import 開発サーバで React/TSX がバンドル配信される
bun build --compile ./compile.ts --outfile ./montash-spike && ./montash-spike   # 単一バイナリ + 埋め込みファイル
```

初回検証: Bun 1.3.14 / macOS arm64 / 2026-09-14（結果は 12 章の表を参照）。
