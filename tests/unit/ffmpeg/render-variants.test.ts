/**
 * 実 ffmpeg での書き出し派生（`render still` / `render audio` / `--reframe` / `render gif`）。
 * 素材は 320x180 の小さなものを使い、x264 は `-preset ultrafast`（テスト全体を短く保つため）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { locateBinaries } from "../../../src/ffmpeg/locate.ts";
import { runFfmpeg, runFfprobeJson } from "../../../src/ffmpeg/run.ts";

const cli = resolve(import.meta.dir, "../../../src/cli/index.ts");
const bins = locateBinaries();
let fixtures: string;
let dir: string;

// biome-ignore lint/suspicious/noExplicitAny: CLI の JSON エンベロープをそのまま読む
type Envelope = any;

async function run(...args: string[]): Promise<Envelope> {
  const proc = Bun.spawn([process.execPath, cli, "-C", dir, "--json", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  try {
    return { ...JSON.parse(out), code, stderr };
  } catch {
    throw new Error(`${args.join(" ")}: invalid JSON ${out}\n${stderr}`);
  }
}

async function ok(...args: string[]): Promise<Envelope> {
  const result = await run(...args);
  if (result.code !== 0 || !result.ok) throw new Error(`${args.join(" ")}: ${JSON.stringify(result)}`);
  return result;
}

async function probe(path: string): Promise<Envelope> {
  return runFfprobeJson(bins, [
    "-v",
    "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    "-i",
    path,
  ]);
}

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "montash-variants-fixtures-"));
  // 320x180 / 30fps / 2 秒、音付き（testsrc2 はフレームごとに絵が変わる）
  await runFfmpeg(bins, [
    "-n",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=f=440:r=48000:d=2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-frames:v",
    "60",
    "-t",
    "2",
    join(fixtures, "src.mp4"),
  ]);
  dir = await mkdtemp(join(tmpdir(), "montash-variants-"));
  await ok("init", dir, "--fps", "30", "--resolution", "320x180");
  await ok("import", join(fixtures, "src.mp4"));
  await ok("clip", "add", "--asset", "src", "--in", "f:0", "--duration", "f:30");
}, 60_000);

afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

test("render still は 1 枚の PNG を書く", async () => {
  const out = join(dir, "out", "still.png");
  const r = await ok("render", "still", "--at", "f:10", "-o", out);
  expect(r.result.output.path).toBe(out);
  const info = await probe(out);
  const video = info.streams.find((s: Envelope) => s.codec_type === "video");
  expect(video.codec_name).toBe("png");
  expect(video.width).toBe(320);
  expect(video.height).toBe(180);
  expect(info.streams.filter((s: Envelope) => s.codec_type === "audio")).toHaveLength(0);
}, 30_000);

test("render audio は音声のみのファイルを書く", async () => {
  const out = join(dir, "out", "mix.wav");
  await ok("render", "audio", "-o", out);
  const info = await probe(out);
  expect(info.streams.filter((s: Envelope) => s.codec_type === "video")).toHaveLength(0);
  const audio = info.streams.find((s: Envelope) => s.codec_type === "audio");
  expect(audio.sample_rate).toBe("48000");
  expect(audio.channels).toBe(2);
  // 30 フレーム @30fps = 1.0 秒（± 1 フレーム）
  expect(Math.abs(Number(audio.duration) - 1)).toBeLessThan(1 / 30);
}, 30_000);

test("render --reframe center は 9:16 の出力になり、フレーム数が一致する", async () => {
  const out = join(dir, "out", "reel.mp4");
  const r = await ok(
    "render",
    "--preset",
    "instagram-reel",
    "--reframe",
    "center",
    "--resolution",
    "90x160",
    "--preset-speed",
    "ultrafast",
    "-o",
    out,
    "--progress",
    "none",
  );
  expect(r.result.valid).toBe(true);
  expect(r.result.actual_frames).toBe(30);
  expect(r.result.resolution).toEqual({ width: 90, height: 160 });
  const video = (await probe(out)).streams.find((s: Envelope) => s.codec_type === "video");
  expect(video.width).toBe(90);
  expect(video.height).toBe(160);
  // レターボックス（--reframe なし）は上下に黒帯が入るだけで解像度は同じ
  const letterboxed = await ok(
    "render",
    "--preset",
    "instagram-reel",
    "--resolution",
    "90x160",
    "--preset-speed",
    "ultrafast",
    "-o",
    join(dir, "out", "reel-pad.mp4"),
    "--progress",
    "none",
  );
  expect(letterboxed.result.actual_frames).toBe(30);
}, 60_000);

test("render gif は短い範囲を 15fps の GIF にする", async () => {
  const out = join(dir, "out", "loop.gif");
  await ok("render", "gif", "--from", "f:0", "--to", "f:6", "-o", out);
  const info = await probe(out);
  const video = info.streams.find((s: Envelope) => s.codec_type === "video");
  expect(video.codec_name).toBe("gif");
  expect(Number(video.nb_read_frames)).toBe(3); // 6 フレーム @30fps → 3 フレーム @15fps
}, 30_000);

test("--last は前回のオプションを復元する", async () => {
  await ok(
    "render",
    "--preset",
    "web-preview",
    "--resolution",
    "160x90",
    "--preset-speed",
    "ultrafast",
    "-o",
    join(dir, "out", "v1.mp4"),
    "--progress",
    "none",
  );
  const again = await ok("render", "--last", "-o", join(dir, "out", "v2.mp4"), "--progress", "none");
  expect(again.result.preset).toBe("web-preview");
  expect(again.result.resolution).toEqual({ width: 160, height: 90 });
}, 60_000);

test("render batch はプリセット名を付けた複数ファイルを作る", async () => {
  const outDir = join(dir, "batch");
  const r = await ok(
    "render",
    "batch",
    "--preset",
    "web-preview:--resolution=160x90,--preset-speed=ultrafast",
    "--preset",
    "instagram-reel:--reframe=center,--resolution=90x160,--preset-speed=ultrafast",
    "-o",
    outDir,
    "--progress",
    "none",
  );
  expect(r.result.count).toBe(2);
  const names = (r.result.outputs as Envelope[]).map((o) => String(o.output).split("/").pop() as string);
  // <project>_<preset>.<ext>（プロジェクト名は init したディレクトリ名）
  expect(names.map((n) => n.slice(n.indexOf("_")))).toEqual(["_web-preview.mp4", "_instagram-reel.mp4"]);
  for (const n of names) expect(n.startsWith("_")).toBe(false);
  for (const o of r.result.outputs as Envelope[]) expect(o.verified.valid).toBe(true);
}, 90_000);
