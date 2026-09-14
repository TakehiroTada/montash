// ファイル監視の Bun 互換性検証（docs/12-tech-decisions.md ADR-05）
//   A) chokidar@4 — project.json の上書き / tmp→rename の原子的保存 / サブディレクトリへの追加 を検知できるか
//   B) Bun 標準 fs.watch({ recursive: true }) — 同じ操作をどこまで検知できるか（比較用）
// 期待: A が OK。B は Bun 1.3.14 / macOS で検知漏れ（rename のみ）だったため不採用。

import { mkdirSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import chokidar from "chokidar";

const base = import.meta.dir;

// ---- A) chokidar@4 ----
{
	const dir = `${base}/watched`;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const target = `${dir}/project.json`;
	writeFileSync(target, "{}");
	const events: string[] = [];
	const w = chokidar.watch(dir, {
		ignoreInitial: true,
		awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
	});
	w.on("all", (ev, p) => events.push(`${ev}:${p.split("/").pop()}`));
	await new Promise<void>((r) => w.on("ready", () => r()));
	await Bun.sleep(100);
	writeFileSync(target, JSON.stringify({ a: 1 })); // 上書き
	await Bun.sleep(200);
	writeFileSync(`${target}.tmp`, JSON.stringify({ b: 2 }));
	renameSync(`${target}.tmp`, target); // 原子的保存（vedit の保存方式）
	await Bun.sleep(200);
	mkdirSync(`${dir}/.vedit/history`, { recursive: true });
	writeFileSync(`${dir}/.vedit/history/ops.jsonl`, "line\n"); // サブディレクトリへの追加
	await Bun.sleep(300);
	await w.close();
	const okA =
		events.some((e) => e.startsWith("change:project.json")) &&
		events.some((e) => e.startsWith("add:ops.jsonl"));
	console.log("chokidar@4 events:", JSON.stringify(events));
	console.log("RESULT chokidar:", okA ? "OK" : "FAIL");
}

// ---- B) Bun native fs.watch (recursive) — comparison ----
{
	const root = `${base}/watched2`;
	rmSync(root, { recursive: true, force: true });
	mkdirSync(`${root}/.vedit/history`, { recursive: true });
	const events: string[] = [];
	const w = watch(root, { recursive: true }, (ev, f) =>
		events.push(`${ev}:${f}`),
	);
	await Bun.sleep(100);
	writeFileSync(`${root}/project.json`, "{}");
	writeFileSync(`${root}/p.tmp`, "{}");
	renameSync(`${root}/p.tmp`, `${root}/project.json`);
	writeFileSync(`${root}/.vedit/history/ops.jsonl`, "x\n");
	await Bun.sleep(300);
	w.close();
	const okB =
		events.some((e) => e.includes("project.json")) &&
		events.some((e) => e.includes("ops.jsonl"));
	console.log("fs.watch recursive events:", JSON.stringify(events));
	console.log(
		"RESULT fs.watch (informational, not required):",
		okB ? "OK" : "FAIL",
	);
}
