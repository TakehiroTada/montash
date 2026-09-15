/**
 * レンダー（docs/07 §9）。グラフの組み立ては `graph/` に任せ、ここは検証・プリセット・出力設定だけを持つ。
 */
import { stat } from "node:fs/promises";
import { MontashError } from "../cli/errors.ts";
import { timelineDurationF } from "../core/assets.ts";
import type { Project, Resolution } from "../core/schema.ts";
import { framesToSeconds } from "../core/time.ts";
import { resolveAssetPath, validateProject } from "../core/validate.ts";
import { buildGraph } from "./graph/builder.ts";
import { serializeGraph } from "./graph/serialize.ts";
import type { OutputSpec } from "./graph/types.ts";
import type { Binaries } from "./locate.ts";
import { runFfprobeJson } from "./run.ts";

export const RENDER_PRESETS = {
  "youtube-1080p": { resolution: { width: 1920, height: 1080 }, crf: 18, speed: "slow", abitrate: "192k" },
  "web-preview": { resolution: { width: 1280, height: 720 }, crf: 28, speed: "veryfast", abitrate: "96k" },
} as const;
export type RenderPreset = keyof typeof RENDER_PRESETS;

export interface RenderOptions {
  preset: RenderPreset;
  resolution?: Resolution;
  crf?: number;
  speed?: string;
  threads?: number;
}
export interface RenderPlan {
  args: string[];
  filter_complex: string;
  duration_f: number;
  duration: number;
  resolution: Resolution;
  warnings: Array<{ code: string; message: string }>;
}

export function buildRenderPlan(project: Project, dir: string, output: string, opts: RenderOptions): RenderPlan {
  const validation = validateProject(project, { dir, checkFiles: true });
  if (!validation.ok)
    throw new MontashError("E_VALIDATION_FAILED", "project validation failed before render", {
      detail: { errors: validation.errors },
      hint: "Run `montash validate --deep --json` and fix the reported issues.",
    });
  const preset = RENDER_PRESETS[opts.preset];
  const resolution = opts.resolution ?? preset.resolution;
  const fps = project.settings.fps;
  const graph = buildGraph(project, {
    resolution,
    source: (asset) => resolveAssetPath(dir, asset.path),
  });
  const spec: OutputSpec = {
    path: output,
    format: "mp4",
    video: {
      codec: "libx264",
      preset: opts.speed ?? preset.speed,
      crf: opts.crf ?? preset.crf,
      pixFmt: "yuv420p",
      gop: Math.round((2 * fps.num) / fps.den),
    },
    audio: {
      codec: "aac",
      bitrate: preset.abitrate,
      sampleRate: project.settings.sample_rate,
      channels: project.settings.channels,
    },
    faststart: true,
    ...(opts.threads !== undefined ? { threads: opts.threads } : {}),
  };
  const total = timelineDurationF(project);
  const warnings = [
    ...validation.warnings.map((w) => ({ code: w.code, message: w.message })),
    ...graph.warnings.map((w) => ({ code: w.code, message: w.message })),
  ];
  if (project.audio.normalize.enabled)
    warnings.push({
      code: "W_NORMALIZE_DEFERRED",
      message: "render preserves audio levels; loudness normalization is planned for a later milestone.",
    });
  return {
    args: serializeGraph(graph, spec),
    filter_complex: graph.filterComplex,
    duration_f: total,
    duration: framesToSeconds(total, fps),
    resolution,
    warnings,
  };
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  nb_read_frames?: string;
  duration?: string;
  avg_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
}

export async function verifyRender(bins: Binaries, path: string, project: Project, resolution?: Resolution) {
  const raw = (await runFfprobeJson(bins, [
    "-v",
    "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    "-i",
    path,
  ])) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = raw.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const total = timelineDurationF(project);
  const duration = framesToSeconds(total, project.settings.fps);
  const expectedFps = project.settings.fps.num / project.settings.fps.den;
  const ratio = video?.avg_frame_rate?.split("/").map(Number);
  const actualFps = ratio?.length === 2 ? ratio[0]! / ratio[1]! : NaN;
  const errors: string[] = [];
  if (Number(video?.nb_read_frames) !== total)
    errors.push(`video frame count ${video?.nb_read_frames ?? "missing"} != ${total}`);
  if (Math.abs(actualFps - expectedFps) > 1e-6 || !Number.isFinite(actualFps))
    errors.push("video FPS differs from project");
  if (
    !audio ||
    !Number.isFinite(Number(audio.duration)) ||
    Math.abs(Number(audio.duration) - duration) > 1 / expectedFps + 1 / project.settings.sample_rate
  )
    errors.push("audio duration differs by more than one frame");
  if (Number(audio?.sample_rate) !== project.settings.sample_rate || audio?.channels !== project.settings.channels)
    errors.push("audio sample rate/channel count differs from project");
  if (
    streams.filter((s) => s.codec_type === "video").length !== 1 ||
    streams.filter((s) => s.codec_type === "audio").length !== 1
  )
    errors.push("expected one video and one audio stream");
  if (resolution && (video?.width !== resolution.width || video?.height !== resolution.height))
    errors.push("video resolution differs from render plan");
  const result = {
    valid: errors.length === 0,
    expected_frames: total,
    actual_frames: Number(video?.nb_read_frames) || 0,
    errors,
    output: { path, size: (await stat(path)).size, duration: Number(raw.format?.duration), streams },
  };
  if (errors.length)
    throw new MontashError("E_RENDER_VERIFY", errors.join("; "), {
      exitCode: 5,
      hint: "Re-render the current timeline and verify again.",
      detail: result,
    });
  return result;
}
