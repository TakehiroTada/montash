/**
 * OS 別の単一バイナリをまとめて作る（docs/09 M5、docs/08 §2）。
 *
 *   bun scripts/release-build.ts              # 4 ターゲットぶん dist/ へ
 *   bun scripts/release-build.ts --target=bun-linux-x64
 *   bun scripts/release-build.ts --skip-web   # web/dist を作り直さない
 *
 * `bun build --compile --target=...` は **ホストと違う OS/アーキテクチャでも作れる**
 * （実測: macOS arm64 から linux-x64 / linux-arm64 / darwin-x64 を生成できた）。
 * 初回はターゲットの Bun ランタイムをダウンロードするので少し待つ。
 *
 * web の本番アセットは `--compile` がバンドルに埋め込むので、**バイナリを作る前に
 * `web/dist` を用意しておく必要がある**（`scripts/build.ts` と同じことを先に行う）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

/** WSL は linux バイナリを使う（docs/09 M5） */
export const RELEASE_TARGETS = [
  { target: "bun-linux-x64", suffix: "linux-x64" },
  { target: "bun-linux-arm64", suffix: "linux-arm64" },
  { target: "bun-darwin-x64", suffix: "darwin-x64" },
  { target: "bun-darwin-arm64", suffix: "darwin-arm64" },
] as const;

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "dist");

async function run(args: string[], label: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`${label} failed (exit ${code})`);
    process.exit(code);
  }
}

if (import.meta.main) {
  const only = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
  const targets = only ? RELEASE_TARGETS.filter((t) => t.target === only) : RELEASE_TARGETS;
  if (targets.length === 0) {
    console.error(`unknown target: ${only}\nknown: ${RELEASE_TARGETS.map((t) => t.target).join(", ")}`);
    process.exit(2);
  }

  // web/dist はバイナリに埋め込まれるので先に作る
  if (!process.argv.includes("--skip-web")) {
    await run(["scripts/build.ts"], "build:web");
  }

  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const built: Array<{ name: string; bytes: number; ms: number }> = [];
  for (const { target, suffix } of targets) {
    const name = `montash-${suffix}`;
    const started = performance.now();
    await run(["build", "--compile", `--target=${target}`, "src/cli/index.ts", "--outfile", `dist/${name}`], name);
    const file = Bun.file(resolve(outdir, name));
    built.push({ name, bytes: file.size, ms: performance.now() - started });
  }

  console.log("");
  for (const b of built)
    console.log(`  ${b.name.padEnd(24)} ${(b.bytes / 1024 / 1024).toFixed(0)} MB  ${(b.ms / 1000).toFixed(1)}s`);
  console.log(`\n${built.length} binaries in dist/`);
}
