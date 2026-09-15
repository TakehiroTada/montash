/**
 * サムネイル・波形の生成（実 ffmpeg。docs/05 §12、docs/07 §10）。
 *
 * `ensureFixtures` の素材で `buildThumbs` / `buildWaveform` を動かし、
 * スプライトの実寸が `columns × rows` と整合すること、波形の点数が尺 × 100 になること、
 * 無音区間のピークが小さいことを確かめる。
 */
import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, initProjectDir } from "../../../src/core/project.ts";
import { type Asset, AssetSchema, type Project } from "../../../src/core/schema.ts";
import { ensureFixtures } from "../../../src/ffmpeg/fixtures.ts";
import { type Binaries, locateBinaries } from "../../../src/ffmpeg/locate.ts";
import {
  assetCacheDir,
  buildThumbs,
  buildWaveform,
  derivedStateOf,
  thumbLayout,
  thumbsEligible,
  WAVEFORM_POINTS_PER_SECOND,
  waveformEligible,
} from "../../../src/ffmpeg/proxy.ts";
import { runFfmpeg, runFfprobeJson } from "../../../src/ffmpeg/run.ts";

let bins: Binaries;
let fx: Record<string, string>;
let dir: string;
let project: Project;
/** 前半 1 秒が 440Hz、後半 1 秒が無音の mono WAV（このテスト専用に作る） */
let toneSilence: string;

/** ffprobe で映像ストリームの実寸を読む */
async function probeSize(path: string): Promise<{ width: number; height: number }> {
  const probe = (await runFfprobeJson(bins, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    path,
  ])) as { streams?: Array<{ width?: number; height?: number }> };
  return { width: probe.streams?.[0]?.width ?? 0, height: probe.streams?.[0]?.height ?? 0 };
}

function register(id: string, path: string, extra: Record<string, unknown>): Asset {
  const asset = AssetSchema.parse({ id, path, ...extra });
  project.assets[id] = asset;
  return asset;
}

beforeAll(async () => {
  bins = locateBinaries({});
  fx = await ensureFixtures(bins, "tests/fixtures", ["a", "tone", "logo"]);
  dir = mkdtempSync(join(tmpdir(), "montash-derived-"));
  project = createProject({ name: "derived", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  await initProjectDir(dir, project);
  toneSilence = join(dir, "tone-silence.wav");
  await runFfmpeg(bins, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=f=440:r=48000:d=2",
    "-af",
    "volume=0:enable='gte(t,1)'",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-t",
    "2",
    toneSilence,
  ]);
}, 120_000);

test("only video and image assets get thumbnails, only sound gets a waveform", () => {
  const video = AssetSchema.parse({ id: "v", path: "v.mp4", type: "video", audio: { channels: 2 } });
  const silentVideo = AssetSchema.parse({ id: "v2", path: "v.mp4", type: "video", audio: null });
  const image = AssetSchema.parse({ id: "i", path: "i.png", type: "image" });
  const audio = AssetSchema.parse({ id: "s", path: "s.wav", type: "audio" });
  const text = AssetSchema.parse({ id: "t", path: "t.txt", type: "text" });
  const subtitle = AssetSchema.parse({ id: "sub", path: "s.srt", type: "subtitle" });
  expect([video, silentVideo, image, audio, text, subtitle].map(thumbsEligible)).toEqual([
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
  expect([video, silentVideo, image, audio, text, subtitle].map(waveformEligible)).toEqual([
    true,
    false,
    false,
    true,
    false,
    false,
  ]);
});

test("thumbLayout puts one thumbnail per interval and wraps at 10 columns", () => {
  expect(thumbLayout(150, 30)).toEqual({ count: 5, columns: 5, rows: 1 });
  // 端数の秒も 1 枚として数える
  expect(thumbLayout(151, 30)).toEqual({ count: 6, columns: 6, rows: 1 });
  expect(thumbLayout(900, 30)).toEqual({ count: 30, columns: 10, rows: 3 });
  // 尺が不明な素材（画像）は 1 枚
  expect(thumbLayout(null, 30)).toEqual({ count: 1, columns: 1, rows: 1 });
});

test("buildThumbs writes a sprite whose size matches columns x rows and an index that matches the duration", async () => {
  const asset = register("a", fx.a!, {
    type: "video",
    duration_s: 5,
    duration_f: 150,
    video: { codec: "h264", width: 640, height: 360, fps: { num: 30, den: 1 } },
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
  });
  const out = await buildThumbs(bins, dir, project, asset);
  expect(out.state).toBe("ready");
  expect(out.skipped).toBe(false);

  const cache = assetCacheDir(dir, "a");
  const index = await Bun.file(join(cache, "thumbs.json")).json();
  // 5 秒 / 30fps → 1 秒ごとに 1 枚で 5 枚、160x90（640x360 の縦横比）
  expect(index).toEqual({ interval_f: 30, width: 160, height: 90, columns: 5, count: 5, sprite: "thumbs.jpg" });

  const size = await probeSize(join(cache, index.sprite));
  const rows = Math.ceil(index.count / index.columns);
  expect(size).toEqual({ width: index.width * index.columns, height: index.height * rows });

  // 2 回目は指紋が一致するので作り直さない
  const again = await buildThumbs(bins, dir, project, asset);
  expect(again.skipped).toBe(true);
  expect(await derivedStateOf(dir, asset, project, "thumbs")).toBe("ready");
}, 120_000);

test("an image asset gets a single-tile sprite", async () => {
  const asset = register("logo", fx.logo!, {
    type: "image",
    duration_s: null,
    duration_f: null,
    video: { codec: "png", width: 256, height: 128, pix_fmt: "rgba" },
  });
  await buildThumbs(bins, dir, project, asset);
  const index = await Bun.file(join(assetCacheDir(dir, "logo"), "thumbs.json")).json();
  expect(index).toMatchObject({ count: 1, columns: 1, width: 160, height: 80 });
  expect(await probeSize(join(assetCacheDir(dir, "logo"), "thumbs.jpg"))).toEqual({ width: 160, height: 80 });
}, 120_000);

test("buildWaveform produces 100 points per second between 0 and 1", async () => {
  const asset = register("tone", fx.tone!, {
    type: "audio",
    duration_s: 10,
    duration_f: 300,
    audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 2 },
  });
  const out = await buildWaveform(bins, dir, project, asset);
  expect(out.state).toBe("ready");

  const wave = await Bun.file(join(assetCacheDir(dir, "tone"), "waveform.json")).json();
  expect(wave.points_per_second).toBe(WAVEFORM_POINTS_PER_SECOND);
  expect(wave.channels).toBe(1);
  // 10 秒 × 100 点（端数で ±2 点のずれは許す）
  expect(Math.abs(wave.peaks.length - 10 * WAVEFORM_POINTS_PER_SECOND)).toBeLessThanOrEqual(2);
  expect(Math.min(...wave.peaks)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...wave.peaks)).toBeLessThanOrEqual(1);
  // 440Hz のトーンなので全区間で無音ではない
  expect(Math.max(...wave.peaks)).toBeGreaterThan(0.01);

  const again = await buildWaveform(bins, dir, project, asset);
  expect(again.skipped).toBe(true);
  expect(await derivedStateOf(dir, asset, project, "waveform")).toBe("ready");
}, 120_000);

test("a silent half of the source shows near-zero peaks", async () => {
  const asset = register("mixed", toneSilence, {
    type: "audio",
    duration_s: 2,
    duration_f: 60,
    audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 1 },
  });
  await buildWaveform(bins, dir, project, asset);
  const wave = await Bun.file(join(assetCacheDir(dir, "mixed"), "waveform.json")).json();
  const loud = wave.peaks.slice(10, 90) as number[];
  const silent = wave.peaks.slice(110, 190) as number[];
  expect(Math.max(...loud)).toBeGreaterThan(0.01);
  expect(Math.max(...silent)).toBeLessThan(0.001);
  expect(Math.max(...loud)).toBeGreaterThan(Math.max(...silent) * 10);
}, 120_000);

test("a missing source leaves no half-written derived files", async () => {
  const asset = register("gone", join(dir, "gone.wav"), { type: "audio", duration_s: 1, duration_f: 30 });
  await expect(buildWaveform(bins, dir, project, asset)).rejects.toThrow();
  expect(existsSync(join(assetCacheDir(dir, "gone"), "waveform.json"))).toBe(false);
  expect(await derivedStateOf(dir, asset, project, "waveform")).toBe("missing");
});
