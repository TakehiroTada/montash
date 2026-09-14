/**
 * フロントエンドの本番ビルド（docs/06 §4, docs/08 §2）。
 * `bun build web/index.html --outdir web/dist --minify` と同じことを行う（package.json の build:web と等価）。
 * 成果物: web/dist/index.html + ハッシュ付き JS / CSS。`montash serve`（--dev 無し）はこれを Bun.file で配信する。
 *
 *   bun scripts/build.ts            # web/dist を作り直す
 *   bun scripts/build.ts --no-clean # 既存の dist を消さずに上書き
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "web/dist");
const clean = !process.argv.includes("--no-clean");

if (clean) rmSync(outdir, { recursive: true, force: true });

const started = performance.now();
const proc = Bun.spawn([process.execPath, "build", "web/index.html", "--outdir", "web/dist", "--minify"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const code = await proc.exited;
if (code !== 0) {
  console.error(`build:web failed (exit ${code})`);
  process.exit(code);
}
const index = Bun.file(resolve(outdir, "index.html"));
if (!(await index.exists())) {
  console.error("build:web produced no web/dist/index.html");
  process.exit(1);
}
console.error(`build:web ok → ${outdir} (${Math.round(performance.now() - started)}ms)`);
