#!/usr/bin/env bun
/**
 * Bun を上げたのに `scripts/spikes/` を再実行し忘れていないかを検知する（docs/13 C-7）。
 *
 * spikes は「ADR の前提（chokidar が Bun で動く、`Bun.serve` の Range、yargs のネスト、
 * HTML import、`--compile` の埋め込み）がこの Bun でも成り立つか」を確かめる最小スクリプト群。
 * 実行自体は 2 秒ほどだが、**Bun を上げたときに走らせるのを忘れる**のが問題だった。
 *
 * そこで最後に検証した Bun のバージョンを記録し、いま使っている Bun と違えば知らせる。
 * **失敗にはしない**（開発を止める種類の問題ではないため）。`bun run spikes` が記録を更新する。
 */
import { dirname, join } from "node:path";

const STAMP = join(dirname(import.meta.dir), "scripts", "spikes", ".verified-bun");
const current = Bun.version;

const mode = process.argv[2] ?? "check";
if (mode === "update") {
  await Bun.write(STAMP, `${current}\n`);
  console.log(`spikes verified with bun ${current}`);
  process.exit(0);
}

const file = Bun.file(STAMP);
if (!(await file.exists())) {
  console.warn(
    `note: scripts/spikes はまだこの環境で検証されていません（bun ${current}）。\`bun run spikes\` で確認できます。`,
  );
  process.exit(0);
}
const verified = (await file.text()).trim();
if (verified === current) {
  console.log(`spikes: verified with bun ${current}`);
  process.exit(0);
}
console.warn(
  `note: scripts/spikes の検証は bun ${verified} のときのものです（いまは ${current}）。\n` +
    "      ADR の前提が崩れていないか `bun run spikes` で確認してください（2 秒ほどで終わります）。",
);
process.exit(0);
