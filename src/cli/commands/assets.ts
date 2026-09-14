import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assetUsage } from "../../core/assets.ts";
import { atomicWrite, loadProject } from "../../core/project.ts";
import type { Asset, Project } from "../../core/schema.ts";
import { resolveAssetPath } from "../../core/validate.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import { probeFile } from "../../ffmpeg/probe.ts";
import { assetCacheDir, proxyEligible, proxyState } from "../../ffmpeg/proxy.ts";
import { defineCommand } from "../define-command.ts";
import { MontashError } from "../errors.ts";

export function requireAsset(project: Project, id: string): Asset {
  const asset = Object.hasOwn(project.assets, id) ? project.assets[id] : undefined;
  if (!asset)
    throw new MontashError("E_ASSET_NOT_FOUND", `asset "${id}" not found`, {
      hint: "Use `montash assets list --json` to find an asset ID.",
    });
  return asset;
}

async function describeAsset(dir: string, project: Project, asset: Asset) {
  return {
    ...asset,
    missing: !existsSync(resolveAssetPath(dir, asset.path)),
    usage: assetUsage(project, asset.id),
    proxy: proxyEligible(asset) ? await proxyState(dir, asset, project) : null,
  };
}

export const assetsList = defineCommand({
  path: "assets list",
  summary: "list imported assets with metadata, usage and proxy state",
  workflows: ["W-02"],
  options: {
    type: { type: "string", describe: "asset type", choices: ["video", "audio", "image", "subtitle", "text"] },
    tag: { type: "string", describe: "filter by tag" },
    unused: { type: "boolean", describe: "only unused assets" },
    missing: { type: "boolean", describe: "only missing source files" },
    search: { type: "string", describe: "search ID, label and path" },
  },
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const assets = (await Promise.all(Object.values(project.assets).map((a) => describeAsset(dir, project, a)))).filter(
      (a) =>
        (!args.type || a.type === args.type) &&
        (!args.tag || a.tags.includes(String(args.tag))) &&
        (!args.unused || a.usage.clips.length === 0) &&
        (!args.missing || a.missing) &&
        (!args.search ||
          `${a.id} ${a.label ?? ""} ${a.path}`.toLowerCase().includes(String(args.search).toLowerCase())),
    );
    return {
      result: { assets },
      human:
        assets
          .map(
            (a) =>
              `${a.id}  ${a.type}  ${a.duration_f ?? "-"} frames  proxy:${a.proxy ?? "n/a"}  clips:${a.usage.clips.length}  ${a.path}`,
          )
          .join("\n") || "no assets",
    };
  },
});

export const assetsShow = defineCommand({
  path: "assets show",
  summary: "show asset metadata, usage and optionally raw ffprobe data",
  workflows: ["W-02"],
  positionals: [{ name: "id", describe: "asset ID", required: true }],
  options: { probe: { type: "boolean", describe: "include raw ffprobe JSON" } },
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const asset = requireAsset(project, String(args.id));
    let probe: unknown;
    if (args.probe && ["video", "audio", "image"].includes(asset.type)) {
      const cache = join(assetCacheDir(dir, asset.id), "probe.json");
      try {
        probe = await Bun.file(cache).json();
      } catch {
        probe = (await probeFile(locateBinaries({ ...ctx.globals, env: ctx.env }), resolveAssetPath(dir, asset.path)))
          .raw;
        if (!ctx.globals.dryRun) {
          await mkdir(assetCacheDir(dir, asset.id), { recursive: true });
          await atomicWrite(cache, JSON.stringify(probe));
        }
      }
    }
    const text = asset.type === "text" ? await Bun.file(resolveAssetPath(dir, asset.path)).text() : undefined;
    return {
      result: {
        asset: await describeAsset(dir, project, asset),
        ...(probe === undefined ? {} : { probe }),
        ...(text === undefined ? {} : { text }),
      },
    };
  },
});
