/** Regenerable per-asset proxies. Source fingerprints live beside the cache. */
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { errors } from "../cli/errors.ts";
import { atomicWrite, projectPaths } from "../core/project.ts";
import type { Asset, Project } from "../core/schema.ts";
import { resolveAssetPath } from "../core/validate.ts";
import type { Binaries } from "./locate.ts";
import { runFfmpeg } from "./run.ts";

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
