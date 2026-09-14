/** M1 renderer: frame-accurate cuts, concat, gaps and linked audio. */
import { stat } from "node:fs/promises";
import { MontashError } from "../cli/errors.ts";
import { timelineDurationF } from "../core/assets.ts";
import { type Clip, clipDurationF, clipEndF, isMediaClip, type Project, type Resolution } from "../core/schema.ts";
import { framesToSamples, framesToSeconds, framesToSecString } from "../core/time.ts";
import { resolveAssetPath, validateProject } from "../core/validate.ts";
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

function unsupported(what: string): never {
  throw new MontashError("E_NOT_IMPLEMENTED", `M1 render does not support ${what}`, {
    hint: "Use plain media clips with speed 1; transitions, text and effects arrive in later milestones.",
  });
}

export function buildRenderPlan(project: Project, dir: string, output: string, opts: RenderOptions): RenderPlan {
  const validation = validateProject(project, { dir, checkFiles: true });
  if (!validation.ok)
    throw new MontashError("E_VALIDATION_FAILED", "project validation failed before render", {
      detail: { errors: validation.errors },
      hint: "Run `montash validate --deep --json` and fix the reported issues.",
    });
  const total = timelineDurationF(project);
  if (!total)
    throw new MontashError("E_EMPTY_TIMELINE", "cannot render an empty timeline", {
      hint: "Use `montash clip add` first.",
    });
  if (project.transitions.length) unsupported("transitions");
  if (project.audio.ducking.length) unsupported("audio ducking");
  if (![1, 2].includes(project.settings.channels)) unsupported("more than two audio channels");
  const active = project.tracks.filter((t) => !t.muted && t.clips.length);
  const videos = active.filter((t) => t.kind === "video");
  if (videos.length > 1) unsupported("multiple video layers");
  for (const track of active) {
    if (track.kind === "text") unsupported("text tracks");
    if (track.fade.in_f || track.fade.out_f) unsupported("track fades");
    for (const clip of track.clips) {
      if (!isMediaClip(clip)) unsupported("text, subtitle or generator clips");
      if (clip.speed !== 1 || clip.loop || clip.effects.length) unsupported("speed, loops or effects");
      const v = clip.video;
      if (v && (v.opacity !== 1 || v.transform || v.crop || v.color || v.lut || v.fade.in_f || v.fade.out_f))
        unsupported("video transforms or fades");
      const a = clip.audio;
      if (a && (a.fade.in_f || a.fade.out_f || a.offset_smp)) unsupported("audio fades or offsets");
    }
  }
  const preset = RENDER_PRESETS[opts.preset];
  const res = opts.resolution ?? preset.resolution;
  if (res.width % 2 || res.height % 2) throw new MontashError("E_USAGE", "H.264 output width and height must be even");
  const fps = project.settings.fps;
  const rate = `${fps.num}/${fps.den}`;
  const sr = project.settings.sample_rate;
  const layout = project.settings.channels === 1 ? "mono" : "stereo";
  const samples = framesToSamples(total, fps, sr);
  const duration = framesToSeconds(total, fps);
  const args: string[] = [];
  const graph: string[] = [];
  let inputIndex = 0;
  const input = (clip: Clip) => {
    const asset = project.assets[clip.asset]!;
    if (asset.type === "image") args.push("-loop", "1", "-framerate", rate);
    args.push("-i", resolveAssetPath(dir, asset.path));
    return inputIndex++;
  };
  const labels: string[] = [];
  const tb = `settb=expr=${fps.den}/${fps.num},setpts=N`;
  const background = project.settings.background;
  if (!/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|[a-zA-Z]+)$/.test(background))
    throw new MontashError("E_USAGE", "unsupported background color");
  const blank = (frames: number) => {
    if (frames <= 0) return;
    const label = `v${labels.length}`;
    graph.push(`color=c=${background}:s=${res.width}x${res.height}:r=${rate},trim=end_frame=${frames},${tb}[${label}]`);
    labels.push(label);
  };
  let cursor = 0;
  for (const c of [...(videos[0]?.clips ?? [])].sort((a, b) => a.start_f - b.start_f)) {
    const clip = c as Clip;
    blank(clip.start_f - cursor);
    const index = input(clip);
    const label = `v${labels.length}`;
    // Normalize timestamps and FPS before selecting project-frame boundaries.
    graph.push(
      `[${index}:V:0]setpts=PTS-STARTPTS,fps=${rate},trim=start_frame=${clip.in_f}:end_frame=${clip.out_f},${tb},scale=${res.width}:${res.height}:force_original_aspect_ratio=decrease,pad=${res.width}:${res.height}:(ow-iw)/2:(oh-ih)/2:color=${background},setsar=1,format=yuv420p[${label}]`,
    );
    labels.push(label);
    cursor = clipEndF(clip);
  }
  blank(total - cursor);
  graph.push(
    `${labels.map((l) => `[${l}]`).join("")}concat=n=${labels.length}:v=1:a=0,fps=${rate},trim=end_frame=${total},${tb}[Vout]`,
  );

  const audioLabels: string[] = [];
  for (const track of active.filter((t) => t.kind === "audio")) {
    for (const c of track.clips) {
      const clip = c as Clip;
      if (clip.audio?.muted) continue;
      const index = input(clip);
      const label = `a${audioLabels.length}`;
      const start = framesToSamples(clip.in_f, fps, sr);
      const length = framesToSamples(clipDurationF(clip), fps, sr);
      const delay = framesToSamples(clip.start_f, fps, sr);
      const gain = (clip.audio?.gain_db ?? 0) + (project.audio.track_gain_db[track.id] ?? 0);
      graph.push(
        `[${index}:a:0]asetpts=PTS-STARTPTS,aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=${layout},atrim=start_sample=${start}:end_sample=${start + length},asetpts=PTS-STARTPTS,apad=whole_len=${length},atrim=end_sample=${length},volume=${gain}dB,adelay=${delay}S:all=1[${label}]`,
      );
      audioLabels.push(label);
    }
  }
  if (audioLabels.length)
    graph.push(
      `${audioLabels.map((l) => `[${l}]`).join("")}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0[Amix]`,
    );
  else graph.push(`anullsrc=r=${sr}:cl=${layout},atrim=end_sample=${samples}[Amix]`);
  graph.push(
    `[Amix]volume=${project.audio.master_gain_db}dB,apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=PTS-STARTPTS[Aout]`,
  );
  const filter = graph.join(";");
  args.push(
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    filter,
    "-map",
    "[Vout]",
    "-map",
    "[Aout]",
    "-c:v",
    "libx264",
    "-preset",
    opts.speed ?? preset.speed,
    "-crf",
    String(opts.crf ?? preset.crf),
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(Math.round((2 * fps.num) / fps.den)),
    "-r",
    rate,
    "-frames:v",
    String(total),
    "-c:a",
    "aac",
    "-b:a",
    preset.abitrate,
    "-ar",
    String(sr),
    "-ac",
    String(project.settings.channels),
  );
  if (opts.threads !== undefined) args.push("-threads", String(opts.threads));
  args.push("-t", framesToSecString(total, fps), "-movflags", "+faststart", "-f", "mp4", output);
  const warnings = [...validation.warnings.map((w) => ({ code: w.code, message: w.message }))];
  if (project.audio.normalize.enabled)
    warnings.push({
      code: "W_NORMALIZE_DEFERRED",
      message: "M1 render preserves audio levels; loudness normalization is planned for M3.",
    });
  return { args, filter_complex: filter, duration_f: total, duration, resolution: res, warnings };
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
