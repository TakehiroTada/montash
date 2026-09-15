/**
 * Regenerable per-asset proxies. Source fingerprints live beside the cache.
 *
 * `.montash/cache/<id>/` には proxy.mp4 のほかにサムネイル（thumbs.jpg + thumbs.json）と
 * 波形（waveform.json）を置く（docs/05 §1, §12、docs/07 §10）。
 */
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { errors, MontashError } from "../cli/errors.ts";
import { atomicWrite, projectPaths } from "../core/project.ts";
import type { Asset, Project } from "../core/schema.ts";
import { resolveAssetPath } from "../core/validate.ts";
import type { Binaries } from "./locate.ts";
import { runFfmpeg, runFfprobeJson } from "./run.ts";

export function assetCacheDir(dir: string, id: string): string {
  // IDs imported from hand-edited projects must never become arbitrary paths.
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || Object.hasOwn(Object.prototype, id)) throw errors.usage(`unsafe asset id: ${id}`);
  return join(projectPaths(dir).cacheDir, id);
}

export function proxyEligible(asset: Asset): boolean {
  return asset.type === "video" || asset.type === "audio";
}

async function fingerprint(dir: string, asset: Asset, project: Project, height: number) {
  const path = resolveAssetPath(dir, asset.path);
  const s = await stat(path);
  return {
    path,
    size: s.size,
    mtime_ms: s.mtimeMs,
    fps: project.settings.fps,
    sample_rate: project.settings.sample_rate,
    height,
  };
}

export async function proxyState(
  dir: string,
  asset: Asset,
  project: Project,
  height?: number,
): Promise<"ready" | "missing" | "stale"> {
  const cache = assetCacheDir(dir, asset.id);
  if (!existsSync(join(cache, "proxy.mp4"))) return "missing";
  try {
    const saved = await Bun.file(join(cache, "proxy.json")).json();
    const current = await fingerprint(dir, asset, project, height ?? saved.height);
    return JSON.stringify(saved) === JSON.stringify(current) ? "ready" : "stale";
  } catch {
    return "stale";
  }
}

export async function buildProxy(
  bins: Binaries,
  dir: string,
  project: Project,
  asset: Asset,
  opts: { height: number; force?: boolean; dryRun?: boolean },
) {
  const { height } = opts;
  if (!Number.isSafeInteger(height) || height < 2 || height % 2)
    throw errors.usage("proxy height must be a positive even integer");
  const cache = assetCacheDir(dir, asset.id);
  const path = join(cache, "proxy.mp4");
  const source = await fingerprint(dir, asset, project, height);
  const fps = `${project.settings.fps.num}/${project.settings.fps.den}`;
  const gop = String(Math.round(project.settings.fps.num / project.settings.fps.den));
  const args = ["-i", source.path];
  if (asset.type === "video")
    args.push(
      "-map",
      "0:V:0",
      "-vf",
      `setpts=PTS-STARTPTS,fps=${fps},scale=-2:${height},setsar=1,format=yuv420p`,
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-g",
      gop,
      "-keyint_min",
      gop,
      "-sc_threshold",
      "0",
    );
  else args.push("-vn");
  args.push(
    "-map",
    "0:a:0?",
    "-af",
    "asetpts=PTS-STARTPTS",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-ar",
    String(project.settings.sample_rate),
    "-ac",
    "2",
    "-movflags",
    "+faststart",
  );
  const ready = !opts.force && (await proxyState(dir, asset, project, height)) === "ready";
  if (!opts.dryRun && !ready) {
    await mkdir(cache, { recursive: true });
    const tmp = join(cache, `proxy.${crypto.randomUUID()}.tmp.mp4`);
    try {
      await runFfmpeg(bins, ["-n", ...args, tmp]);
      const after = await fingerprint(dir, asset, project, height);
      if (JSON.stringify(after) !== JSON.stringify(source))
        throw errors.usage(`source changed while building proxy: ${asset.id}`);
      await rename(tmp, path);
      await atomicWrite(join(cache, "proxy.json"), JSON.stringify(source));
    } finally {
      await rm(tmp, { force: true });
    }
  }
  return {
    id: asset.id,
    state: opts.dryRun && !ready ? ("missing" as const) : ("ready" as const),
    path: relative(dir, path),
    skipped: ready,
    args: [...args, path],
  };
}

// ---------------------------------------------------------------------------
// 派生データ: サムネイル・波形（docs/05 §12、docs/07 §10）
// ---------------------------------------------------------------------------

/** サムネイル 1 枚の幅（px）。高さは元素材の縦横比から `scale=160:-2` で決まる */
export const THUMB_WIDTH = 160;
/** スプライトの最大列数（これを超える枚数は行を増やす） */
export const THUMB_MAX_COLUMNS = 10;
/** 波形の解像度（docs/05 §12: 100 点/秒） */
export const WAVEFORM_POINTS_PER_SECOND = 100;
/** 波形用に落とす PCM のサンプリングレート（docs/07 §10） */
export const WAVEFORM_SAMPLE_RATE = 8000;
/** 1 点あたりのサンプル数（8000 / 100 = 80） */
export const WAVEFORM_SAMPLES_PER_POINT = WAVEFORM_SAMPLE_RATE / WAVEFORM_POINTS_PER_SECOND;

export type DerivedKind = "thumbs" | "waveform";
export type DerivedState = "ready" | "missing" | "stale";

/** サムネイルを作る対象（動画・画像。音声・字幕・テキストは対象外） */
export function thumbsEligible(asset: Asset): boolean {
  return asset.type === "video" || asset.type === "image";
}

/** 波形を作る対象（音声、および音声を持つ動画） */
export function waveformEligible(asset: Asset): boolean {
  return asset.type === "audio" || (asset.type === "video" && Boolean(asset.audio));
}

export function derivedEligible(asset: Asset, kind: DerivedKind): boolean {
  return kind === "thumbs" ? thumbsEligible(asset) : waveformEligible(asset);
}

/** 派生物の出力ファイル（キャッシュディレクトリ内の相対名） */
const DERIVED_FILES: Record<DerivedKind, readonly string[]> = {
  thumbs: ["thumbs.jpg", "thumbs.json"],
  waveform: ["waveform.json"],
};

/** サムネイル間隔（フレーム）。docs/07 §10 は 1 枚/秒なので fps を丸めた値 */
export function thumbIntervalF(project: Project): number {
  return Math.max(1, Math.round(project.settings.fps.num / project.settings.fps.den));
}

/** スプライトに並べる枚数と列・行（`count` は `interval_f` ごとに 1 枚） */
export function thumbLayout(durationF: number | null | undefined, intervalF: number) {
  const count = durationF && durationF > 0 ? Math.max(1, Math.ceil(durationF / intervalF)) : 1;
  const columns = Math.min(count, THUMB_MAX_COLUMNS);
  return { count, columns, rows: Math.ceil(count / columns) };
}

/**
 * 派生物の指紋。`proxy.json` と同じ考え方で、元ファイルの size / mtime と生成条件を持つ。
 * `thumbs.json` / `waveform.json` は docs/05 §12 の形を保つので、指紋は別ファイル（`<kind>.src.json`）に置く。
 */
async function derivedFingerprint(dir: string, asset: Asset, project: Project, kind: DerivedKind) {
  const path = resolveAssetPath(dir, asset.path);
  const s = await stat(path);
  const base = { path, size: s.size, mtime_ms: s.mtimeMs };
  return kind === "thumbs"
    ? { ...base, interval_f: thumbIntervalF(project), width: THUMB_WIDTH }
    : { ...base, points_per_second: WAVEFORM_POINTS_PER_SECOND, sample_rate: WAVEFORM_SAMPLE_RATE };
}

/** `thumbs` / `waveform` の状態（ファイルの有無 + 指紋一致で stale を判定する） */
export async function derivedStateOf(
  dir: string,
  asset: Asset,
  project: Project,
  kind: DerivedKind,
): Promise<DerivedState> {
  const cache = assetCacheDir(dir, asset.id);
  if (DERIVED_FILES[kind].some((f) => !existsSync(join(cache, f)))) return "missing";
  try {
    const saved = await Bun.file(join(cache, `${kind}.src.json`)).json();
    const current = await derivedFingerprint(dir, asset, project, kind);
    return JSON.stringify(saved) === JSON.stringify(current) ? "ready" : "stale";
  } catch {
    return "stale";
  }
}

export interface DerivedResult {
  id: string;
  kind: DerivedKind;
  state: "ready" | "missing";
  /** プロジェクトからの相対パス（スプライト or waveform.json） */
  path: string;
  /** thumbs のみ: インデックス JSON の相対パス */
  index?: string;
  skipped: boolean;
  args: string[];
}

/** `thumbs.json`（docs/05 §12） */
export interface ThumbsIndex {
  interval_f: number;
  width: number;
  height: number;
  columns: number;
  count: number;
  sprite: string;
}

/** `waveform.json`（docs/05 §12） */
export interface WaveformIndex {
  points_per_second: number;
  channels: number;
  peaks: number[];
}

/** 生成した JPEG の実寸を読む（1 枚あたりの width / height を出すため） */
async function spriteSize(bins: Binaries, path: string): Promise<{ width: number; height: number }> {
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
  const s = probe.streams?.[0];
  if (!s?.width || !s?.height) throw errors.usage(`cannot read the generated sprite: ${path}`);
  return { width: s.width, height: s.height };
}

/** 一時ファイルに書いてから rename する（途中で落ちた中途半端な派生物を残さない） */
async function writeAtomic(cache: string, name: string, produce: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = join(cache, `${name}.${crypto.randomUUID()}.tmp`);
  try {
    await produce(tmp);
    await rename(tmp, join(cache, name));
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * サムネイルのスプライト（docs/07 §10）。
 * `fps=1/{interval},scale=160:-2,tile={cols}x{rows}` で 1 枚の JPEG にまとめ、`thumbs.json` を書く。
 * 画像素材は 1 枚だけ（`fps` / `tile` は不要）。
 */
export async function buildThumbs(
  bins: Binaries,
  dir: string,
  project: Project,
  asset: Asset,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<DerivedResult> {
  if (!thumbsEligible(asset)) throw errors.usage(`thumbnails are not supported for ${asset.type} assets`);
  const cache = assetCacheDir(dir, asset.id);
  const sprite = join(cache, "thumbs.jpg");
  const source = await derivedFingerprint(dir, asset, project, "thumbs");
  const intervalF = thumbIntervalF(project);
  const { num, den } = project.settings.fps;
  const { count, columns, rows } = thumbLayout(asset.type === "image" ? 1 : asset.duration_f, intervalF);
  // rate = 1 / (interval_f * den/num) = num / (den * interval_f)。有理数のまま渡して丸め誤差を避ける
  const filters =
    asset.type === "image"
      ? [`scale=${THUMB_WIDTH}:-2`]
      : [`fps=${num}/${den * intervalF}`, `scale=${THUMB_WIDTH}:-2`, `tile=${columns}x${rows}`];
  const args = ["-i", source.path, "-map", "0:V:0", "-an", "-vf", filters.join(","), "-frames:v", "1", "-q:v", "3"];
  const ready = !opts.force && (await derivedStateOf(dir, asset, project, "thumbs")) === "ready";
  if (!opts.dryRun && !ready) {
    await mkdir(cache, { recursive: true });
    await writeAtomic(cache, "thumbs.jpg", async (tmp) => {
      // tmp の拡張子で muxer が決まらないよう明示する
      await runFfmpeg(bins, ["-n", ...args, "-f", "image2", tmp]);
    });
    const size = await spriteSize(bins, sprite);
    const index: ThumbsIndex = {
      interval_f: intervalF,
      width: Math.round(size.width / columns),
      height: Math.round(size.height / rows),
      columns,
      count,
      sprite: "thumbs.jpg",
    };
    await atomicWrite(join(cache, "thumbs.json"), JSON.stringify(index));
    await atomicWrite(join(cache, "thumbs.src.json"), JSON.stringify(source));
  }
  return {
    id: asset.id,
    kind: "thumbs",
    state: opts.dryRun && !ready ? "missing" : "ready",
    path: relative(dir, sprite),
    index: relative(dir, join(cache, "thumbs.json")),
    skipped: ready,
    args: [...args, sprite],
  };
}

/**
 * `-ac 1 -ar 8000 -f s16le -` の PCM を 80 サンプル単位のピーク（0..1）に集約する（docs/07 §10）。
 * `runFfmpeg` は stdout を `-progress` に使うので、ここは Bun.spawn を直接使って stdout を読む。
 */
export async function pcmPeaks(bins: Binaries, source: string, samplesPerPoint: number): Promise<number[]> {
  const args = [
    "-hide_banner",
    "-nostats",
    "-v",
    "error",
    "-i",
    source,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(WAVEFORM_SAMPLE_RATE),
    "-f",
    "s16le",
    "-",
  ];
  const proc = Bun.spawn([bins.ffmpeg, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const peaks: number[] = [];
  let peak = 0;
  let filled = 0;
  /** 16bit LE がチャンク境界で割れたときの下位バイト */
  let pending = -1;
  const take = (sample: number) => {
    const magnitude = Math.abs(sample >= 0x8000 ? sample - 0x10000 : sample) / 32768;
    if (magnitude > peak) peak = magnitude;
    if (++filled === samplesPerPoint) {
      peaks.push(Math.round(peak * 1000) / 1000);
      peak = 0;
      filled = 0;
    }
  };
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let i = 0;
      if (pending >= 0 && value.length > 0) {
        take(pending | (value[0]! << 8));
        pending = -1;
        i = 1;
      }
      for (; i + 1 < value.length; i += 2) take(value[i]! | (value[i + 1]! << 8));
      if (i < value.length) pending = value[i]!;
    }
  })();
  const stderr = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
  const [, tail, exitCode] = await Promise.all([readAll, stderr, proc.exited]);
  if (exitCode !== 0) {
    const lines = tail.split("\n").filter((l) => l.trim() !== "");
    throw new MontashError("E_FFMPEG_FAILED", `ffmpeg failed (exit ${exitCode}): ${lines.at(-1) ?? "(no stderr)"}`, {
      hint: "See detail.stderr_tail for the ffmpeg error output.",
      detail: { exit_code: exitCode, args, stderr_tail: lines.slice(-20) },
    });
  }
  // 端数のサンプルも 1 点として残す（尺 × 100 点に足りない分を作らない）
  if (filled > 0) peaks.push(Math.round(peak * 1000) / 1000);
  return peaks;
}

/** 波形（docs/05 §12: `{ points_per_second: 100, channels, peaks }`） */
export async function buildWaveform(
  bins: Binaries,
  dir: string,
  project: Project,
  asset: Asset,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<DerivedResult> {
  if (!waveformEligible(asset)) throw errors.usage(`waveforms are not supported for ${asset.type} assets`);
  const cache = assetCacheDir(dir, asset.id);
  const path = join(cache, "waveform.json");
  const source = await derivedFingerprint(dir, asset, project, "waveform");
  const ready = !opts.force && (await derivedStateOf(dir, asset, project, "waveform")) === "ready";
  if (!opts.dryRun && !ready) {
    await mkdir(cache, { recursive: true });
    const peaks = await pcmPeaks(bins, source.path, WAVEFORM_SAMPLES_PER_POINT);
    const index: WaveformIndex = { points_per_second: WAVEFORM_POINTS_PER_SECOND, channels: 1, peaks };
    await atomicWrite(path, JSON.stringify(index));
    await atomicWrite(join(cache, "waveform.src.json"), JSON.stringify(source));
  }
  return {
    id: asset.id,
    kind: "waveform",
    state: opts.dryRun && !ready ? "missing" : "ready",
    path: relative(dir, path),
    skipped: ready,
    args: ["-i", source.path, "-ac", "1", "-ar", String(WAVEFORM_SAMPLE_RATE), "-f", "s16le", "-"],
  };
}
