/**
 * レンダー（docs/07 §9, docs/04 §14）。グラフの組み立ては `graph/` に任せ、
 * ここはプリセット適用・出力段（reframe / fps / palette）・hwaccel・2 パス・検証だけを持つ。
 */
import { stat } from "node:fs/promises";
import { devNull } from "node:os";
import { MontashError, type Warning, warning } from "../cli/errors.ts";
import { timelineDurationF } from "../core/assets.ts";
import type { Fps, Project, Resolution } from "../core/schema.ts";
import { framesToSeconds } from "../core/time.ts";
import { resolveAssetPath, validateProject } from "../core/validate.ts";
import { buildGraph } from "./graph/builder.ts";
import { serializeGraph } from "./graph/serialize.ts";
import type { FilterGraph, OutputSpec } from "./graph/types.ts";
import type { Binaries } from "./locate.ts";
import type { AudioPasses } from "./loudnorm.ts";
import {
  applyOutputStage,
  BUILTIN_PRESETS,
  type HwaccelChoice,
  type PresetSpec,
  type Reframe,
  selectHwEncoder,
  supportsTwoPass,
  unknownPreset,
} from "./presets.ts";
import { runFfprobeJson } from "./run.ts";
import { prepareText, type TextEngine } from "./text-prepare.ts";

export {
  applyOutputStage,
  BUILTIN_PRESETS,
  type BuiltinPresetName,
  HWACCEL_CHOICES,
  HWACCEL_ORDER,
  type HwaccelChoice,
  PRESET_NAMES,
  type PresetSpec,
  parseReframe,
  type Reframe,
  reframeCrop,
  resolvePresets,
  selectHwEncoder,
  supportsTwoPass,
} from "./presets.ts";

/** docs/07 §9 のプリセット表（互換のための別名） */
export const RENDER_PRESETS = BUILTIN_PRESETS;
export type RenderPreset = keyof typeof BUILTIN_PRESETS;

export interface RenderRange {
  from_f: number;
  to_f: number;
}

export interface RenderOptions {
  /** プリセット名（既定 youtube-1080p） */
  preset?: string;
  /** 解決済みプリセット表（`project.render_presets` 込み）。省略時は組み込みのみ */
  presets?: Record<string, PresetSpec>;
  resolution?: Resolution;
  crf?: number;
  /** `-preset`（x264 の速度） */
  speed?: string;
  threads?: number;
  /** テキストエンジンの検出に使う（libass の有無。docs/07 §6.1） */
  bins?: Binaries;
  /** 検出結果を上書きする（テスト用） */
  textEngine?: TextEngine;
  /** レンダー前に走らせた音声パスの結果（ダッキング解析・loudnorm 測定。docs/07 §8.3, §8.4） */
  audio?: AudioPasses;
  reframe?: Reframe;
  hwaccel?: HwaccelChoice;
  /** 利用可能なエンコーダ（`--hwaccel auto` の判定に使う） */
  encoders?: ReadonlySet<string>;
  vcodec?: string;
  vbitrate?: string;
  acodec?: string;
  abitrate?: string;
  pixFmt?: string;
  fps?: number;
  twoPass?: boolean;
  /** 部分レンダー（still / gif）。映像のみ */
  range?: RenderRange;
  /** 2 パス目のログ接頭辞（既定は出力パス） */
  passLogPrefix?: string;
}

export interface RenderPlan {
  args: string[];
  /** `--two-pass` の 1 パス目（`-f null`） */
  pass1_args: string[] | null;
  filter_complex: string;
  duration_f: number;
  duration: number;
  resolution: Resolution;
  fps: Fps;
  format: string;
  preset: string;
  vcodec: string | null;
  acodec: string | null;
  two_pass: boolean;
  /** `render verify` を自動実行できるか（映像＋音声・全尺・タイムライン fps のときだけ true） */
  verifiable: boolean;
  warnings: Warning[];
}

/**
 * コンテナごとのソフト字幕コーデック（docs/07 §7）。
 * 字幕ストリームを持てないコンテナ（gif / image2 / mp3 / wav …）では null。
 */
export function softSubtitleCodec(format: string): string | null {
  switch (format) {
    case "mp4":
    case "mov":
    case "ipod":
    case "3gp":
      return "mov_text";
    case "matroska":
    case "mkv":
      return "srt";
    case "webm":
      return "webvtt";
    default:
      return null;
  }
}

/** プリセットから出力解像度を決める（`--resolution` > プリセット > タイムライン） */
export function planResolution(project: Project, preset: PresetSpec, override?: Resolution): Resolution {
  if (override) return override;
  if (preset.resolution) return preset.resolution;
  const timeline = project.settings.resolution;
  if (preset.scaleWidth !== undefined) {
    const width = preset.scaleWidth;
    const height = Math.max(2, Math.round((width * timeline.height) / timeline.width / 2) * 2);
    return { width, height };
  }
  return timeline;
}

export async function buildRenderPlan(
  project: Project,
  dir: string,
  output: string,
  opts: RenderOptions,
): Promise<RenderPlan> {
  const validation = validateProject(project, { dir, checkFiles: true });
  if (!validation.ok)
    throw new MontashError("E_VALIDATION_FAILED", "project validation failed before render", {
      detail: { errors: validation.errors },
      hint: "Run `montash validate --deep --json` and fix the reported issues.",
    });
  const table = opts.presets ?? (BUILTIN_PRESETS as Record<string, PresetSpec>);
  const presetName = opts.preset ?? "youtube-1080p";
  const preset = table[presetName];
  if (!preset) throw unknownPreset(presetName, Object.keys(table));

  const warnings: Warning[] = [...validation.warnings.map((w) => warning(w.code, w.message))];
  const fps = project.settings.fps;
  const resolution = planResolution(project, preset, opts.resolution);
  if (resolution.width % 2 || resolution.height % 2)
    throw new MontashError("E_USAGE", `output resolution must be even (got ${resolution.width}x${resolution.height})`);

  // thumbnail 系（`-frames:v 1`）は 1 フレームだけを切り出す
  const stillFrames = preset.video?.frames;
  let range = opts.range;
  if (stillFrames === 1 && !range) range = { from_f: 0, to_f: 1 };

  const wantVideo = preset.video !== null;
  const wantAudio = preset.audio !== null && range === undefined;
  if (preset.audio !== null && range !== undefined)
    warnings.push(
      warning("W_AUDIO_OMITTED", `${presetName}: a partial range is video only, so the output has no audio track`),
    );

  // ASS の生成・書き出し（I/O）はグラフの外で行い、書き出し済みのパスだけを渡す（docs/07 §6）。
  // 映像を持たない出力（audio-only）では焼くものが無いので用意しない。
  const softCodec = softSubtitleCodec(preset.format);
  const text = wantVideo
    ? await prepareText(project, dir, {
        ...(range !== undefined ? { range } : {}),
        ...(opts.bins !== undefined ? { bins: opts.bins } : {}),
        ...(opts.textEngine !== undefined ? { engine: opts.textEngine } : {}),
        ...(softCodec !== null ? { softCodec } : {}),
      })
    : { soft: [], warnings: [] as Warning[], engine: "libass" as TextEngine };
  // ソフト字幕を多重化できないコンテナ（gif / image2 / mp3 / wav …）では落として警告する（docs/07 §7）
  const soft = softCodec === null ? [] : text.soft;
  if (softCodec === null && text.soft.length)
    warnings.push(
      warning(
        "W_SUBTITLE_SKIPPED",
        `${presetName}: the ${preset.format} container cannot carry soft subtitles; ${text.soft.length} track(s) are dropped`,
        { hint: "Use `montash subtitle set <id> --mode burn` to burn them into the picture instead." },
      ),
    );

  // reframe を使うときはタイムライン解像度で組み立ててから crop → scale する。
  // 使わないときは出力解像度で組み立てる（グラフ側が scale+pad でレターボックスする。docs/07 §9）
  const working = opts.reframe !== undefined ? project.settings.resolution : resolution;
  const stageOpts = {
    resolution,
    ...(opts.reframe !== undefined ? { reframe: opts.reframe } : {}),
    ...((opts.fps ?? preset.fps) ? { fps: opts.fps ?? (preset.fps as number) } : {}),
    ...(preset.palette ? { palette: true } : {}),
  };
  const build = (audio: boolean): { graph: FilterGraph; warnings: Warning[] } => {
    const g = buildGraph(project, {
      resolution: working,
      source: (asset) => resolveAssetPath(dir, asset.path),
      ...(range !== undefined ? { range } : {}),
      video: wantVideo,
      audio,
      ...(text.burn !== undefined ? { text: text.burn } : {}),
      ...(opts.audio?.loudnorm ? { loudnorm: opts.audio.loudnorm } : {}),
      ...(opts.audio?.ducking ? { ducking: opts.audio.ducking } : {}),
    });
    return { graph: applyOutputStage(g, stageOpts).graph, warnings: g.warnings.map((w) => warning(w.code, w.message)) };
  };
  const built = build(wantAudio);
  const graph: FilterGraph = built.graph;

  const video = wantVideo ? resolveVideoOutput(preset, opts, resolution, graph.fps, warnings) : undefined;
  const audio = wantAudio
    ? {
        codec: opts.acodec ?? (preset.audio as NonNullable<PresetSpec["audio"]>).codec,
        ...(bitrateOf(preset, opts) !== undefined ? { bitrate: bitrateOf(preset, opts) as string } : {}),
        sampleRate: project.settings.sample_rate,
        channels: project.settings.channels,
      }
    : undefined;

  const twoPass = resolveTwoPass(opts, video, warnings);
  const passLog = opts.passLogPrefix ?? `${output}.passlog`;
  const spec: OutputSpec = {
    path: output,
    format: preset.format,
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
    ...(preset.faststart ? { faststart: true } : {}),
    ...(soft.length ? { subtitles: soft } : {}),
    ...(opts.threads !== undefined ? { threads: opts.threads } : {}),
    extraArgs: [
      ...(video?.extraArgs ?? []),
      ...((preset.audio?.extra ?? []) as string[]),
      ...(twoPass ? ["-pass", "2", "-passlogfile", passLog] : []),
    ],
  };
  const args = serializeGraph(graph, { ...spec, video: video ? stripExtra(video) : undefined });
  // 1 パス目は映像だけ（音声の出力ラベルが未使用のままだと ffmpeg 7 以降が filtergraph の束縛に失敗する）
  const pass1 = twoPass
    ? serializeGraph(build(false).graph, {
        ...spec,
        path: devNull,
        format: "null",
        video: video ? stripExtra(video) : undefined,
        audio: undefined,
        faststart: false,
        extraArgs: [...(video?.extraArgs ?? []), "-pass", "1", "-passlogfile", passLog],
      })
    : null;

  const total = timelineDurationF(project);
  const durationF = graph.totalFrames;
  warnings.push(...built.warnings, ...text.warnings);
  if (project.audio.normalize.enabled && wantAudio && !opts.audio?.loudnorm)
    warnings.push(
      warning(
        "W_NORMALIZE_SKIPPED",
        "loudness normalization is enabled but no measurement was supplied; audio is rendered as is.",
      ),
    );
  if (preset.maxDurationS !== undefined && framesToSeconds(total, fps) > preset.maxDurationS)
    warnings.push(
      warning(
        "W_PRESET_DURATION",
        `${presetName}: the timeline is ${framesToSeconds(total, fps).toFixed(1)}s, longer than the ${preset.maxDurationS}s this preset targets`,
      ),
    );

  const verifiable =
    wantVideo &&
    wantAudio &&
    range === undefined &&
    graph.fps.num === fps.num &&
    graph.fps.den === fps.den &&
    durationF === total;

  return {
    args,
    pass1_args: pass1,
    filter_complex: graph.filterComplex,
    duration_f: durationF,
    duration: framesToSeconds(durationF, graph.fps),
    resolution,
    fps: graph.fps,
    format: preset.format,
    preset: presetName,
    vcodec: video?.codec ?? null,
    acodec: audio?.codec ?? null,
    two_pass: twoPass,
    verifiable,
    warnings,
  };
}

interface ResolvedVideo {
  codec: string;
  preset?: string;
  crf?: number;
  pixFmt?: string;
  gop?: number;
  extraArgs: string[];
}

function stripExtra(v: ResolvedVideo) {
  const { extraArgs: _extraArgs, ...rest } = v;
  return rest;
}

function bitrateOf(preset: PresetSpec, opts: RenderOptions): string | undefined {
  return opts.abitrate ?? preset.audio?.bitrate;
}

/** codec / crf / bitrate / hwaccel を解決する（docs/07 §9） */
function resolveVideoOutput(
  preset: PresetSpec,
  opts: RenderOptions,
  resolution: Resolution,
  fps: Fps,
  warnings: Warning[],
): ResolvedVideo {
  const base = preset.video as NonNullable<PresetSpec["video"]>;
  let codec = opts.vcodec ?? base.codec;
  let crf = opts.crf ?? base.crf;
  let speed = opts.speed ?? base.speed;
  let bitrate = opts.vbitrate;
  const extraArgs: string[] = [...((base.extra ?? []) as string[])];

  const hwaccel = opts.hwaccel ?? "none";
  if (hwaccel !== "none" && opts.vcodec === undefined) {
    const hw = selectHwEncoder(hwaccel, opts.encoders ?? new Set());
    warnings.push(...hw.warnings);
    if (hw.encoder) {
      codec = hw.encoder;
      // ハードウェアエンコーダは CRF を持たない: ビットレート指定に切り替える（docs/07 §9）
      if (crf !== undefined)
        warnings.push(
          warning(
            "W_CRF_IGNORED",
            `--crf is ignored by ${hw.encoder}; using bitrate ${bitrate ?? base.bitrate ?? defaultBitrate(resolution, fps)} instead`,
            {
              hint: "Pass --vbitrate to control quality, or --hwaccel none to keep CRF encoding.",
            },
          ),
        );
      crf = undefined;
      speed = undefined;
      bitrate = bitrate ?? base.bitrate ?? defaultBitrate(resolution, fps);
      extraArgs.length = 0;
      if (hw.kind === "videotoolbox") extraArgs.push("-allow_sw", "1");
    }
  }
  if (bitrate !== undefined) {
    // ビットレート指定のときは CRF を使わない
    if (crf !== undefined && opts.crf !== undefined)
      warnings.push(warning("W_CRF_IGNORED", `--vbitrate was given, so --crf ${crf} is ignored`));
    crf = undefined;
    extraArgs.push("-b:v", bitrate);
  }
  return {
    codec,
    ...(speed !== undefined ? { preset: speed } : {}),
    ...(crf !== undefined ? { crf } : {}),
    ...((opts.pixFmt ?? base.pixFmt) ? { pixFmt: opts.pixFmt ?? (base.pixFmt as string) } : {}),
    ...(base.gop ? { gop: Math.round((2 * fps.num) / fps.den) } : {}),
    extraArgs,
  };
}

/** 解像度と fps からの目安ビットレート（hwaccel で CRF が使えないときの既定） */
export function defaultBitrate(resolution: Resolution, fps: Fps): string {
  const pixelsPerSecond = resolution.width * resolution.height * (fps.num / fps.den);
  const mbps = Math.max(1, Math.round((pixelsPerSecond * 0.09) / 1_000_000));
  return `${mbps}M`;
}

function resolveTwoPass(opts: RenderOptions, video: ResolvedVideo | undefined, warnings: Warning[]): boolean {
  if (!opts.twoPass) return false;
  if (!video) {
    warnings.push(warning("W_TWO_PASS_IGNORED", "--two-pass needs a video stream; ignored"));
    return false;
  }
  if (!supportsTwoPass(video.codec)) {
    warnings.push(
      warning("W_TWO_PASS_IGNORED", `--two-pass is only supported by libx264 / libx265 (codec is ${video.codec})`, {
        hint: "Drop --two-pass, or use --hwaccel none with the default codec.",
      }),
    );
    return false;
  }
  if (!video.extraArgs.includes("-b:v")) {
    warnings.push(
      warning(
        "W_TWO_PASS_IGNORED",
        "--two-pass needs a target bitrate; ignored (CRF encoding is already single-pass)",
        {
          hint: "Pass --vbitrate 8M to use two-pass encoding.",
        },
      ),
    );
    return false;
  }
  return true;
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
