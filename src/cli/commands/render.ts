import { existsSync } from "node:fs";
import { link, mkdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { atomicWrite, loadProject, parseResolution, projectPaths } from "../../core/project.ts";
import { resolveAssetPath } from "../../core/validate.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import { buildRenderPlan, RENDER_PRESETS, type RenderPreset, verifyRender } from "../../ffmpeg/render.ts";
import { runFfmpeg, shellQuote } from "../../ffmpeg/run.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError } from "../errors.ts";

/** Resolve existing ancestors too: a new directory may sit below a symlink. */
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw e;
    return join(await canonicalDestination(dirname(path)), basename(path));
  }
}

export const render = defineCommand({
  path: "render",
  summary: "render plain media clips to MP4 and verify exact frame count",
  workflows: ["W-09"],
  options: {
    output: { type: "string", alias: "o", describe: "output MP4 path", required: true },
    preset: {
      type: "string",
      describe: "encoding preset",
      choices: Object.keys(RENDER_PRESETS),
      default: "youtube-1080p",
    },
    resolution: { type: "string", describe: "override output WxH" },
    crf: { type: "number", describe: "H.264 quality (0..51)" },
    "preset-speed": {
      type: "string",
      describe: "x264 encoding speed",
      choices: ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"],
    },
    threads: { type: "number", describe: "encoder threads" },
    overwrite: { type: "boolean", describe: "replace an existing output after successful verification" },
    progress: { type: "string", describe: "progress output", choices: ["text", "jsonl", "none"], default: "text" },
  },
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
    const output = resolve(ctx.cwd, String(args.output));
    const canonicalOutput = await canonicalDestination(output);
    const protectedFiles = [
      projectPaths(dir).projectFile,
      ...Object.values(project.assets).map((a) => resolveAssetPath(dir, a.path)),
    ];
    const outputStat = await stat(output).catch(() => null);
    for (const path of protectedFiles) {
      const canonical = await realpath(path).catch(() => resolve(path));
      const sourceStat = outputStat ? await stat(path).catch(() => null) : null;
      if (
        canonical === canonicalOutput ||
        path === output ||
        (sourceStat && outputStat && sourceStat.dev === outputStat.dev && sourceStat.ino === outputStat.ino)
      )
        throw errors.usage("render output must not overwrite the project or a source asset");
    }
    for (const path of [projectPaths(dir).stateDir, projectPaths(dir).assetsDir]) {
      const rel = relative(await realpath(path).catch(() => path), canonicalOutput);
      if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")))
        throw errors.usage("render output must be outside assets/ and .montash/");
    }
    if (existsSync(output) && !args.overwrite)
      throw new MontashError("E_OUTPUT_EXISTS", `output exists: ${output}`, {
        hint: "Choose a new output path or use --overwrite.",
      });
    if (args.crf !== undefined && (!Number.isFinite(Number(args.crf)) || Number(args.crf) < 0 || Number(args.crf) > 51))
      throw errors.usage("--crf must be between 0 and 51");
    if (args.threads !== undefined && (!Number.isSafeInteger(Number(args.threads)) || Number(args.threads) < 1))
      throw errors.usage("--threads must be a positive integer");
    const options = {
      preset: String(args.preset ?? "youtube-1080p") as RenderPreset,
      ...(args.resolution ? { resolution: parseResolution(String(args.resolution)) } : {}),
      ...(args.crf !== undefined ? { crf: Number(args.crf) } : {}),
      ...(args.presetSpeed ? { speed: String(args.presetSpeed) } : {}),
      ...(args.threads ? { threads: Number(args.threads) } : {}),
    };
    const plan = buildRenderPlan(project, dir, output, options);
    const command = shellQuote([bins.ffmpeg, args.overwrite ? "-y" : "-n", ...plan.args]);
    if (ctx.globals.dryRun)
      return { result: { dry_run: true, ...plan, command }, warnings: plan.warnings, human: command };
    await mkdir(dirname(output), { recursive: true });
    const tmp = join(dirname(output), `.montash-render-${crypto.randomUUID()}.mp4`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      await runFfmpeg(bins, ["-n", ...plan.args.slice(0, -1), tmp], {
        totalFrames: plan.duration_f,
        totalDurationS: plan.duration,
        signal: controller.signal,
        onProgress: (p) => {
          if (args.progress === "jsonl")
            ctx.stdout(
              `${JSON.stringify({ frame: p.frame, fps: p.fps, time: p.out_time_s, percent: p.percent, eta: p.eta_s, speed: p.speed })}\n`,
            );
          else if (args.progress !== "none" && !ctx.globals.json && !ctx.globals.quiet)
            ctx.stderr(`\rrender ${p.percent?.toFixed(1) ?? "0"}%`);
        },
      });
      const verified = await verifyRender(bins, tmp, project, plan.resolution);
      if (controller.signal.aborted)
        throw new MontashError("E_FFMPEG_CANCELLED", "render cancelled", { exitCode: 130 });
      if (args.overwrite) await rename(tmp, output);
      else {
        // Hard-link publication fails atomically if another writer created output.
        try {
          await link(tmp, output);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST")
            throw new MontashError("E_OUTPUT_EXISTS", `output appeared during rendering: ${output}`);
          throw e;
        }
      }
      const result = { ...verified, output: { ...verified.output, path: output } };
      await atomicWrite(
        join(projectPaths(dir).renderDir, "last.json"),
        JSON.stringify(
          { ...options, output, duration_f: plan.duration_f, rendered_at: new Date().toISOString() },
          null,
          2,
        ),
      );
      return { result, warnings: plan.warnings, human: `rendered ${output} (${plan.duration_f} frames; verified)` };
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
      await rm(tmp, { force: true });
      if (args.progress !== "none" && args.progress !== "jsonl" && !ctx.globals.json && !ctx.globals.quiet)
        ctx.stderr("\n");
    }
  },
});

export const renderVerify = defineCommand({
  path: "render verify",
  summary: "verify frame count, FPS, audio duration and stream configuration",
  workflows: ["W-09"],
  positionals: [{ name: "path", describe: "rendered MP4", required: true }],
  async handler(ctx, args) {
    const project = await loadProject(ctx.requireProjectDir());
    const result = await verifyRender(
      locateBinaries({ ...ctx.globals, env: ctx.env }),
      resolve(ctx.cwd, String(args.path)),
      project,
    );
    return { result, human: `verified ${result.actual_frames} frames with audio: ${result.output.path}` };
  },
});

export const renderPresets = defineCommand({
  path: "render presets",
  summary: "list implemented encoding presets",
  noProject: true,
  workflows: ["W-09"],
  handler() {
    return {
      result: {
        presets: Object.entries(RENDER_PRESETS).map(([name, settings]) => ({
          name,
          ...settings,
          vcodec: "libx264",
          acodec: "aac",
          format: "mp4",
        })),
      },
    };
  },
});
