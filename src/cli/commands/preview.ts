/**
 * `montash preview build|status`（docs/04 §13, docs/07 §11）。
 *
 * 生成の中身は ffmpeg/preview.ts（映像セグメントキャッシュ + 音声 1 パス + mux）。
 * ここでは引数の解釈・進捗表示・JSON 整形だけを行う。プレビューは派生物なので project.json を変更せず、
 * 履歴 op も記録しない（docs/04 §1.8）。
 */
import { timelineDurationF } from "../../core/assets.ts";
import { loadProject } from "../../core/project.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import { buildPreview, buildPreviewPlan, readPreviewStatus } from "../../ffmpeg/preview.ts";
import { defineCommand } from "../define-command.ts";
import { errors, type Warning } from "../errors.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";

interface BuildArgs extends Record<string, unknown> {
  from?: string;
  to?: string;
  force?: boolean;
  audioOnly?: boolean;
  height?: number;
}

export const previewStatus = defineCommand({
  path: "preview status",
  summary: "show timeline preview freshness and active build progress",
  workflows: ["W-04"],
  examples: [{ cmd: "montash preview status --json", note: "whether the preview is up to date with project.json" }],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const status = await readPreviewStatus(await loadProject(dir), dir);
    const percent = status.progress?.percent;
    return {
      result: {
        state: status.state,
        project_hash: status.project_hash,
        fingerprint: status.fingerprint,
        built_at: status.built_at ?? null,
        duration_f: status.duration_f ?? null,
        fps: status.fps ?? null,
        resolution: status.resolution ?? null,
        path: status.path ?? null,
        segments: status.manifest?.video_segments.length ?? 0,
        ...(status.progress ? { progress: status.progress } : {}),
      },
      human:
        `preview: ${status.state}` +
        (status.built_at ? `  built_at=${status.built_at}` : "") +
        (percent != null ? `  ${percent.toFixed(1)}%` : ""),
    };
  },
});

export const previewBuild = defineCommand<BuildArgs>({
  path: "preview build",
  summary: "build the timeline preview MP4 (cached video segments + one audio pass)",
  description:
    "Video is split at frame boundaries and cached under .montash/preview/segments/, audio is rendered in one pass to audio.m4a, and both are muxed with -c copy into .montash/preview/timeline.mp4 (docs/07 §11).",
  workflows: ["W-04", "W-06", "W-07"],
  options: {
    from: { type: "string", describe: "rebuild segments from this time", time: true },
    to: { type: "string", describe: "rebuild segments up to this time", time: true },
    force: { type: "boolean", describe: "rebuild even when the preview is up to date" },
    "audio-only": { type: "boolean", describe: "render audio.m4a only (docs/07 §11.2)" },
    height: { type: "number", describe: "even output height (default: project proxy height)" },
  },
  examples: [
    { cmd: "montash preview build", note: "incremental rebuild" },
    { cmd: "montash preview build --from 10 --to 20 --json", note: "regenerate one range" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const fps = project.settings.fps;
    const end = timelineDurationF(project);
    const warnings: Warning[] = [];
    const frameOf = (raw: string | undefined, name: string): number | undefined => {
      if (raw === undefined) return undefined;
      const parsed = parseTimeInput(String(raw), fps, { allowRelative: false });
      if (parsed.warning) warnings.push(parsed.warning);
      const frames = resolveAbsolute(parsed, { fps, end });
      if (frames > end)
        warnings.push({
          code: "W_BEYOND_TIMELINE",
          message: `--${name} ${raw} is past the end of the timeline (${end} frames)`,
        });
      return frames;
    };
    const from_f = frameOf(args.from, "from");
    const to_f = frameOf(args.to, "to");
    if (from_f !== undefined && to_f !== undefined && to_f <= from_f)
      throw errors.usage("--to must be greater than --from");
    const height = args.height === undefined ? undefined : Number(args.height);
    const audioOnly = Boolean(args.audioOnly);

    if (ctx.globals.dryRun) {
      const plan = await buildPreviewPlan(project, dir, { height });
      return {
        result: {
          dry_run: true,
          duration_f: plan.duration_f,
          resolution: plan.resolution,
          segments: plan.segments.map((s) => ({
            from_f: s.from_f,
            to_f: s.to_f,
            hash: s.hash,
            path: s.path,
            clips: s.clips,
          })),
          audio: { hash: plan.audio.hash, path: "audio.m4a" },
        },
        warnings: [...warnings, ...plan.warnings],
      };
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    const interactive = !ctx.globals.json && !ctx.globals.quiet;
    try {
      const built = await buildPreview(project, dir, {
        bins: locateBinaries({ ...ctx.globals, env: ctx.env }),
        height,
        force: Boolean(args.force),
        ...(from_f !== undefined ? { from_f } : {}),
        ...(to_f !== undefined ? { to_f } : {}),
        audioOnly,
        signal: controller.signal,
        onProgress(p) {
          if (interactive) ctx.stderr(`\rpreview ${(p.percent ?? 0).toFixed(1)}%`);
        },
      });
      const s = built.status;
      return {
        result: {
          state: s.state,
          project_hash: s.project_hash,
          built_at: s.built_at ?? null,
          duration_f: s.duration_f ?? null,
          fps: s.fps ?? null,
          resolution: s.resolution ?? null,
          path: s.path ?? null,
          reused: built.reused,
          built_segments: built.built_segments,
          cached_segments: built.cached_segments,
          audio_reused: built.audio_reused,
          ...(built.audio_only ? { audio_only: true } : {}),
        },
        warnings: [...warnings, ...built.warnings],
        human: built.audio_only
          ? `preview audio: ${built.audio_reused ? "cached" : "rebuilt"}`
          : `preview: ${s.state}${built.reused ? " (cached)" : ` (${built.built_segments} segments encoded, ${built.cached_segments} cached)`}`,
      };
    } finally {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
      if (interactive) ctx.stderr("\n");
    }
  },
});
