import { constants } from "node:fs";
import { copyFile, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { assertIdAvailable, existingIds, slugAssetId } from "../../core/ids.ts";
import { atomicWrite } from "../../core/project.ts";
import { type Asset, AssetSchema } from "../../core/schema.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import { durationFrames, probeFile } from "../../ffmpeg/probe.ts";
import { assetCacheDir, buildProxy, proxyEligible } from "../../ffmpeg/proxy.ts";
import { defineCommand } from "../define-command.ts";
import { ExitCode, errors, MontashError, toMontashError, warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";

const extensions = new Set(
  "mp4 mov mkv webm avi mts m2ts mp3 wav aac flac m4a ogg png jpg jpeg webp srt ass vtt txt md".split(" "),
);
const extension = (path: string) => extname(path).slice(1).toLowerCase();

async function expand(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];
  const paths: string[] = [];
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(path, entry.name);
    // Do not recurse through directory symlinks (cycles and duplicate imports).
    if (entry.isDirectory()) paths.push(...(await expand(child)));
    else if (entry.isFile() && extensions.has(extension(child))) paths.push(child);
  }
  return paths;
}

export const importAssets = defineCommand({
  path: "import",
  summary: "import media, subtitle or text files and optionally build proxies",
  workflows: ["W-02"],
  mutates: true,
  positionals: [{ name: "paths", describe: "files or directories (recursive)", required: true, variadic: true }],
  options: {
    id: { type: "string", describe: "explicit ID (one file only)" },
    copy: { type: "boolean", describe: "copy into project assets/", default: false },
    proxy: { type: "boolean", describe: "build video/audio proxies", default: false },
    strict: { type: "boolean", describe: "abort without importing if any input fails", default: false },
  },
  examples: [
    {
      cmd: "montash import ./raw/clip_a.mp4 ./raw/clip_b.mp4 --proxy",
      note: "import two files and build preview proxies",
    },
    { cmd: "montash import ./raw/bgm.mp3 --id bgm", note: "give the asset a stable ID instead of a generated one" },
  ],
  async handler(ctx, args) {
    const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
    const failed: Array<{ path: string; error: ReturnType<MontashError["toJSON"]> }> = [];
    const paths: string[] = [];
    for (const input of args.paths as string[]) {
      const path = resolve(ctx.cwd, input);
      try {
        paths.push(...(await expand(path)));
      } catch (e) {
        failed.push({ path, error: new MontashError("E_ASSET_MISSING", `cannot read ${path}`, { cause: e }).toJSON() });
      }
    }
    if (args.id && (paths.length !== 1 || failed.length)) throw errors.usage("--id requires exactly one input file");
    const result = await runMutation(ctx, async ({ project, dir, fps }) => {
      const imported: Asset[] = [];
      const staged: Array<{ asset: Asset; source: string; raw?: unknown }> = [];
      const used = existingIds(project);
      for (const source of [...new Set(paths)]) {
        try {
          const id = args.id ? String(args.id) : slugAssetId(source, used);
          assetCacheDir(dir, id);
          assertIdAvailable(project, id);
          const s = await stat(source);
          if (!s.isFile()) throw errors.usage(`not a regular file: ${source}`);
          const file = await open(source, "r");
          const head = Buffer.alloc(Math.min(s.size, 1024 * 1024));
          try {
            await file.read(head, 0, head.length, 0);
          } finally {
            await file.close();
          }
          const base = {
            id,
            path: source,
            owned: Boolean(args.copy),
            imported_by: ctx.actor,
            imported_at: new Date().toISOString(),
            size: s.size,
            mtime: s.mtime.toISOString(),
            hash_head: `sha256:${new Bun.CryptoHasher("sha256").update(head).digest("hex")}`,
            tags: [],
          };
          const ext = extension(source);
          let asset: Asset;
          let raw: unknown;
          if (ext === "txt" || ext === "md") {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(await Bun.file(source).arrayBuffer());
            asset = AssetSchema.parse({
              ...base,
              type: "text",
              duration_s: null,
              duration_f: null,
              text_preview: text.slice(0, 200),
              line_count: text.split(/\r?\n/).length,
            });
          } else if (["srt", "ass", "vtt"].includes(ext)) {
            asset = AssetSchema.parse({ ...base, type: "subtitle", format: ext });
          } else {
            const probe = await probeFile(bins, source);
            raw = probe.raw;
            const { container, ...summary } = probe.summary;
            asset = AssetSchema.parse({
              ...base,
              ...summary,
              container: {
                format: container.format,
                ...(container.bit_rate === null ? {} : { bit_rate: container.bit_rate }),
              },
              duration_f: summary.duration_s === null ? null : durationFrames(summary.duration_s, fps),
            });
          }
          if (args.copy) asset.path = join("assets", `${id}-${crypto.randomUUID()}${extname(basename(source))}`);
          staged.push({ asset, source, raw });
          used.add(id);
        } catch (e) {
          failed.push({ path: source, error: toMontashError(e).toJSON() });
        }
      }
      if (failed.length && args.strict)
        throw new MontashError("E_IMPORT_FAILED", "strict import failed; no assets imported", {
          exitCode: ExitCode.IO,
          detail: { failed },
        });
      const copied: string[] = [];
      for (const { asset, source, raw } of staged) {
        try {
          if (!ctx.globals.dryRun) {
            const cache = assetCacheDir(dir, asset.id);
            await mkdir(cache, { recursive: true });
            if (args.copy) {
              await mkdir(join(dir, "assets"), { recursive: true });
              await copyFile(source, resolve(dir, asset.path), constants.COPYFILE_EXCL);
              copied.push(resolve(dir, asset.path));
            }
            if (raw !== undefined) await atomicWrite(join(cache, "probe.json"), JSON.stringify(raw));
          }
          // Dry runs probe original inputs without copying them.
          if (args.proxy && proxyEligible(asset) && !ctx.globals.dryRun) {
            const proxy = await buildProxy(bins, dir, project, asset, { height: project.settings.proxy.height });
            asset.derived = { proxy: { state: proxy.state, path: proxy.path, built_at: new Date().toISOString() } };
          }
          project.assets[asset.id] = asset;
          imported.push(asset);
        } catch (e) {
          failed.push({ path: source, error: toMontashError(e).toJSON() });
        }
      }
      if (failed.length && args.strict) {
        await Promise.all(copied.map((path) => rm(path, { force: true })));
        throw new MontashError("E_IMPORT_FAILED", "strict import failed; no assets registered", {
          exitCode: ExitCode.IO,
          detail: { failed },
        });
      }
      return {
        result: { imported, failed },
        summary: `import ${imported.length} assets`,
        changed: imported.length > 0,
        warnings: failed.map((f) => warning("W_IMPORT_FAILED", `${f.path}: ${f.error.message}`)),
        human: `${ctx.globals.dryRun ? "would import" : "imported"} ${imported.length} assets${failed.length ? `; ${failed.length} failed` : ""}\n${imported.map((a) => `  ${a.id}  ${a.type}  ${a.path}`).join("\n")}`,
      };
    });
    return { ...result, exitCode: failed.length ? ExitCode.IO : ExitCode.OK };
  },
});
