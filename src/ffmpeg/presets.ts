/**
 * 出力プリセットと出力段の組み立て（docs/07 §9、docs/04 §14）。
 *
 * - `BUILTIN_PRESETS`: docs/07 §9 の表（+ docs/04 §14 の `twitter`）
 * - `resolvePresets()`: `project.render_presets`（`base` 継承）を足したプリセット表
 * - `applyOutputStage()`: `--reframe` の crop / `--fps` / gif のパレットを filter_complex の末尾に足す
 * - `selectHwEncoder()`: `--hwaccel auto` の選択順（videotoolbox → nvenc → vaapi → qsv）
 *
 * `graph/` には手を入れず、`buildGraph()` が返した `FilterGraph` を読み取り専用に扱って
 * 新しいグラフを組み立て直す（出力ラベルとチェーンを足すだけ）。
 */
import { MontashError, type Warning, warning } from "../cli/errors.ts";
import { parseResolution } from "../core/project.ts";
import type { Fps, Project, Resolution } from "../core/schema.ts";
import type { FilterGraph } from "./graph/types.ts";

// ---------------------------------------------------------------------------
// プリセット定義
// ---------------------------------------------------------------------------

export interface PresetVideo {
  codec: string;
  /** `-preset`（x264/x265 の速度） */
  speed?: string;
  crf?: number;
  /** ビットレート指定（hwaccel / 2 パス時の既定） */
  bitrate?: string;
  pixFmt?: string;
  /** `-g`（2 秒 GOP）を付ける */
  gop?: boolean;
  /** `-profile:v high -level 4.2` など、その codec 固有の追加引数 */
  extra?: readonly string[];
  /** `-frames:v` を上書きする（thumbnail = 1） */
  frames?: number;
}

export interface PresetAudio {
  codec: string;
  bitrate?: string;
  /** `-q:a 2` など */
  extra?: readonly string[];
}

export interface PresetSpec {
  /** `-f` に渡すフォーマット名 */
  format: string;
  /** 既定の拡張子 */
  ext: string;
  /** 出力解像度。null ならタイムライン解像度をそのまま使う */
  resolution: Resolution | null;
  /** 幅だけ決めて高さはタイムラインのアスペクトから決める（gif の 480px） */
  scaleWidth?: number;
  /** 出力 fps（省略時はタイムライン fps） */
  fps?: number;
  video: PresetVideo | null;
  audio: PresetAudio | null;
  /** gif のパレット生成（palettegen / paletteuse） */
  palette?: boolean;
  faststart?: boolean;
  /** これを超える尺なら警告する（instagram-reel の 90 秒） */
  maxDurationS?: number;
  /** 人間向けの注記 */
  note?: string;
  /** 由来（`render presets` の表示用） */
  source?: "builtin" | "project";
  base?: string;
}

const X264_HIGH = ["-profile:v", "high"] as const;

/** docs/07 §9 の出力段プリセット表（+ docs/04 §14 の `twitter`） */
export const BUILTIN_PRESETS: Readonly<Record<string, PresetSpec>> = Object.freeze({
  "youtube-1080p": {
    format: "mp4",
    ext: ".mp4",
    resolution: { width: 1920, height: 1080 },
    video: {
      codec: "libx264",
      speed: "slow",
      crf: 18,
      bitrate: "8M",
      pixFmt: "yuv420p",
      gop: true,
      extra: [...X264_HIGH, "-level", "4.2"],
    },
    audio: { codec: "aac", bitrate: "192k" },
    faststart: true,
    note: "YouTube 1080p (H.264 high@4.2)",
  },
  "youtube-4k": {
    format: "mp4",
    ext: ".mp4",
    resolution: { width: 3840, height: 2160 },
    video: {
      codec: "libx264",
      speed: "slow",
      crf: 17,
      bitrate: "35M",
      pixFmt: "yuv420p",
      gop: true,
      extra: [...X264_HIGH, "-level", "5.1"],
    },
    audio: { codec: "aac", bitrate: "192k" },
    faststart: true,
    note: "YouTube 2160p (H.264 high@5.1)",
  },
  "instagram-reel": {
    format: "mp4",
    ext: ".mp4",
    resolution: { width: 1080, height: 1920 },
    video: { codec: "libx264", speed: "medium", crf: 20, bitrate: "6M", pixFmt: "yuv420p", gop: true },
    audio: { codec: "aac", bitrate: "128k" },
    faststart: true,
    maxDurationS: 90,
    note: "vertical 9:16; use --reframe to crop instead of letterboxing",
  },
  twitter: {
    format: "mp4",
    ext: ".mp4",
    resolution: { width: 1280, height: 720 },
    video: { codec: "libx264", speed: "medium", crf: 23, bitrate: "5M", pixFmt: "yuv420p", gop: true },
    audio: { codec: "aac", bitrate: "128k" },
    faststart: true,
    note: "720p, conservative bitrate",
  },
  "web-preview": {
    format: "mp4",
    ext: ".mp4",
    resolution: { width: 1280, height: 720 },
    video: { codec: "libx264", speed: "veryfast", crf: 28, bitrate: "2M", pixFmt: "yuv420p", gop: true },
    audio: { codec: "aac", bitrate: "96k" },
    faststart: true,
    note: "fast, small check render",
  },
  "prores-422": {
    format: "mov",
    ext: ".mov",
    resolution: null,
    video: { codec: "prores_ks", pixFmt: "yuv422p10le", extra: ["-profile:v", "3"] },
    audio: { codec: "pcm_s16le" },
    note: "editing master (ProRes 422 HQ + PCM)",
  },
  "archive-h265": {
    format: "mp4",
    ext: ".mp4",
    resolution: null,
    video: {
      codec: "libx265",
      speed: "medium",
      crf: 22,
      bitrate: "4M",
      pixFmt: "yuv420p",
      gop: true,
      extra: ["-tag:v", "hvc1"],
    },
    audio: { codec: "aac", bitrate: "192k" },
    faststart: true,
    note: "long-term archive (HEVC)",
  },
  "audio-only-mp3": {
    format: "mp3",
    ext: ".mp3",
    resolution: null,
    video: null,
    audio: { codec: "libmp3lame", extra: ["-q:a", "2"] },
    note: "audio only (VBR q2)",
  },
  gif: {
    format: "gif",
    ext: ".gif",
    resolution: null,
    scaleWidth: 480,
    fps: 15,
    video: { codec: "gif" },
    audio: null,
    palette: true,
    note: "480px wide, 15 fps, palettegen/paletteuse",
  },
  thumbnail: {
    format: "image2",
    ext: ".png",
    resolution: null,
    video: { codec: "png", frames: 1 },
    audio: null,
    note: "one still frame",
  },
});

export type BuiltinPresetName = keyof typeof BUILTIN_PRESETS;

export const PRESET_NAMES: readonly string[] = Object.keys(BUILTIN_PRESETS);

// ---------------------------------------------------------------------------
// project.render_presets（`base` 継承）
// ---------------------------------------------------------------------------

/** ユーザー定義プリセットで受け取るキー（docs/05 §9） */
const USER_KEYS = [
  "base",
  "format",
  "ext",
  "resolution",
  "fps",
  "vcodec",
  "crf",
  "vbitrate",
  "preset_speed",
  "pix_fmt",
  "acodec",
  "abitrate",
  "note",
  "faststart",
] as const;

/**
 * 組み込み + `project.render_presets` を解決した表を返す。
 * ユーザー定義は `base`（省略時 `youtube-1080p`）を継承し、指定したキーだけ上書きする。
 * `base` の循環は `E_USAGE`。
 */
export function resolvePresets(project?: Pick<Project, "render_presets"> | null): Record<string, PresetSpec> {
  const out: Record<string, PresetSpec> = {};
  for (const [name, spec] of Object.entries(BUILTIN_PRESETS)) out[name] = { ...spec, source: "builtin" };
  const user = project?.render_presets ?? {};
  const resolving = new Set<string>();
  const resolve = (name: string): PresetSpec => {
    const existing = out[name];
    if (existing && !Object.hasOwn(user, name)) return existing;
    if (existing?.source === "project") return existing;
    const raw = user[name] as Record<string, unknown> | undefined;
    if (!raw) {
      if (existing) return existing;
      throw unknownPreset(name, [...Object.keys(out), ...Object.keys(user)]);
    }
    if (resolving.has(name))
      throw new MontashError("E_USAGE", `render preset '${name}' inherits from itself (base loop)`, {
        hint: "Fix project.render_presets so that every `base` chain ends at a built-in preset.",
        detail: { preset: name },
      });
    resolving.add(name);
    const baseName = typeof raw.base === "string" ? raw.base : "youtube-1080p";
    const base = resolve(baseName);
    resolving.delete(name);
    const merged = applyUserOverrides(name, base, raw);
    out[name] = { ...merged, source: "project", base: baseName };
    return out[name] as PresetSpec;
  };
  for (const name of Object.keys(user)) resolve(name);
  return out;
}

function applyUserOverrides(name: string, base: PresetSpec, raw: Record<string, unknown>): PresetSpec {
  const unknownKeys = Object.keys(raw).filter((k) => !(USER_KEYS as readonly string[]).includes(k));
  if (unknownKeys.length > 0)
    throw new MontashError("E_USAGE", `render preset '${name}' has unknown key(s): ${unknownKeys.join(", ")}`, {
      hint: `Supported keys: ${USER_KEYS.join(", ")}.`,
      detail: { preset: name, unknown: unknownKeys },
    });
  const spec: PresetSpec = {
    ...base,
    video: base.video ? { ...base.video } : null,
    audio: base.audio ? { ...base.audio } : null,
  };
  if (typeof raw.format === "string") spec.format = raw.format;
  if (typeof raw.ext === "string") spec.ext = raw.ext.startsWith(".") ? raw.ext : `.${raw.ext}`;
  if (typeof raw.note === "string") spec.note = raw.note;
  if (typeof raw.faststart === "boolean") spec.faststart = raw.faststart;
  if (raw.resolution !== undefined) spec.resolution = toResolution(name, raw.resolution);
  if (raw.fps !== undefined) spec.fps = positiveNumber(name, "fps", raw.fps);
  if (spec.video) {
    if (typeof raw.vcodec === "string") spec.video.codec = raw.vcodec;
    if (typeof raw.preset_speed === "string") spec.video.speed = raw.preset_speed;
    if (raw.crf !== undefined) spec.video.crf = positiveNumber(name, "crf", raw.crf, 0);
    if (typeof raw.vbitrate === "string") spec.video.bitrate = raw.vbitrate;
    if (typeof raw.pix_fmt === "string") spec.video.pixFmt = raw.pix_fmt;
  }
  if (spec.audio) {
    if (typeof raw.acodec === "string") spec.audio.codec = raw.acodec;
    if (typeof raw.abitrate === "string") spec.audio.bitrate = raw.abitrate;
  }
  return spec;
}

function toResolution(preset: string, value: unknown): Resolution {
  if (typeof value === "string") return parseResolution(value);
  if (value !== null && typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (typeof r.width === "number" && typeof r.height === "number")
      return { width: r.width, height: r.height } as Resolution;
  }
  throw new MontashError("E_USAGE", `render preset '${preset}' has an invalid resolution`, {
    hint: 'Use "1920x1080" or { "width": 1920, "height": 1080 }.',
    detail: { preset, value },
  });
}

function positiveNumber(preset: string, key: string, value: unknown, min = 0.0001): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min)
    throw new MontashError("E_USAGE", `render preset '${preset}' has an invalid ${key}: ${String(value)}`, {
      detail: { preset, key, value },
    });
  return n;
}

export function unknownPreset(name: string, known: readonly string[]): MontashError {
  return new MontashError("E_PRESET_NOT_FOUND", `unknown render preset '${name}'`, {
    hint: `See \`montash render presets\`. Known presets: ${[...new Set(known)].join(", ")}.`,
    detail: { preset: name, presets: [...new Set(known)] },
  });
}

// ---------------------------------------------------------------------------
// --reframe（docs/07 §9）
// ---------------------------------------------------------------------------

export type Reframe = "center" | "left" | "right" | { percent: number };

/** `center` / `left` / `right` / `37%` を解釈する */
export function parseReframe(input: string): Reframe {
  const v = input.trim().toLowerCase();
  if (v === "center" || v === "left" || v === "right") return v;
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(v);
  if (!m)
    throw new MontashError("E_USAGE", `invalid --reframe value ${JSON.stringify(input)}`, {
      hint: "Use center, left, right or a percentage such as 40% (0% = left/top, 100% = right/bottom).",
    });
  const percent = Number(m[1]);
  if (percent < 0 || percent > 100)
    throw new MontashError("E_USAGE", `--reframe percentage must be between 0% and 100% (got ${input})`);
  return { percent };
}

function reframeFraction(reframe: Reframe): number {
  if (reframe === "left") return 0;
  if (reframe === "right") return 1;
  if (reframe === "center") return 0.5;
  return reframe.percent / 100;
}

/** 偶数に丸める（yuv420p は偶数サイズを要求する） */
function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** オフセットを偶数に切り下げる（0 も許す） */
function evenOffset(n: number): number {
  return Math.max(0, Math.floor(n / 2) * 2);
}

export interface CropBox {
  w: number;
  h: number;
  x: number;
  y: number;
}

/**
 * `from` のフレームを `to` のアスペクトに合わせて切り出す矩形（docs/07 §9 `crop=ih*9/16:ih:(iw-ow)/2:0`）。
 * アスペクトが同じなら null。
 */
export function reframeCrop(from: Resolution, to: Resolution, reframe: Reframe): CropBox | null {
  const srcAr = from.width / from.height;
  const dstAr = to.width / to.height;
  if (Math.abs(srcAr - dstAr) < 1e-6) return null;
  const f = reframeFraction(reframe);
  if (srcAr > dstAr) {
    // 横が余る → 幅を切る
    const w = Math.min(from.width, even((from.height * to.width) / to.height));
    return { w, h: from.height, x: evenOffset((from.width - w) * f), y: 0 };
  }
  const h = Math.min(from.height, even((from.width * to.height) / to.width));
  return { w: from.width, h, x: 0, y: evenOffset((from.height - h) * f) };
}

// ---------------------------------------------------------------------------
// 出力段（filter_complex の末尾に足す）
// ---------------------------------------------------------------------------

export interface OutputStageOptions {
  /** 最終的な出力解像度 */
  resolution: Resolution;
  /** クロップ基準（省略時はレターボックス。グラフ側で pad 済みなので何もしない） */
  reframe?: Reframe;
  /** 出力 fps（省略時はグラフの fps） */
  fps?: number;
  /** gif のパレット（palettegen / paletteuse） */
  palette?: boolean;
}

export interface OutputStageResult {
  graph: FilterGraph;
  /** 実際に足したフィルタ（テスト・デバッグ用） */
  filters: string[];
}

/**
 * `buildGraph()` の結果に出力段のフィルタを足した新しいグラフを返す（元のグラフは変更しない）。
 * 映像が無い（`-vn`）グラフには何もしない。
 */
export function applyOutputStage(graph: FilterGraph, opts: OutputStageOptions): OutputStageResult {
  if (!graph.mapVideo) return { graph, filters: [] };
  const filters: string[] = [];
  const crop = opts.reframe !== undefined ? reframeCrop(graph.resolution, opts.resolution, opts.reframe) : null;
  if (crop) filters.push(`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`);
  if (crop || graph.resolution.width !== opts.resolution.width || graph.resolution.height !== opts.resolution.height) {
    filters.push(`scale=${opts.resolution.width}:${opts.resolution.height}:flags=bicubic`, "setsar=1");
  }
  let totalFrames = graph.totalFrames;
  let fps = graph.fps;
  if (opts.fps !== undefined && Math.abs(opts.fps - graph.fps.num / graph.fps.den) > 1e-9) {
    filters.push(`fps=${opts.fps}`);
    totalFrames = Math.max(1, Math.round((graph.totalFrames * opts.fps) / (graph.fps.num / graph.fps.den)));
    fps = { num: opts.fps, den: 1 } as Fps;
  }
  if (filters.length === 0 && !opts.palette) return { graph, filters: [] };

  const label = (suffix: string) => `montash_out_${suffix}`;
  const chains: string[] = [];
  let input = graph.mapVideo;
  if (filters.length > 0) {
    chains.push(`${input}${filters.join(",")}[${label("v")}]`);
    input = `[${label("v")}]`;
  }
  let mapVideo = input;
  if (opts.palette) {
    // docs/07 §9: split[a][b];[a]palettegen[p];[b][p]paletteuse
    chains.push(`${input}split[${label("a")}][${label("b")}]`);
    chains.push(`[${label("a")}]palettegen=stats_mode=diff[${label("p")}]`);
    chains.push(`[${label("b")}][${label("p")}]paletteuse=dither=bayer:bayer_scale=3[${label("g")}]`);
    mapVideo = `[${label("g")}]`;
    filters.push("split", "palettegen", "paletteuse");
  }
  return {
    graph: {
      ...graph,
      filterComplex: [graph.filterComplex, ...chains].join(";"),
      mapVideo,
      totalFrames,
      fps,
      resolution: opts.resolution,
    },
    filters,
  };
}

// ---------------------------------------------------------------------------
// --hwaccel（docs/07 §9）
// ---------------------------------------------------------------------------

export const HWACCEL_CHOICES = ["auto", "none", "videotoolbox", "nvenc", "vaapi", "qsv"] as const;
export type HwaccelChoice = (typeof HWACCEL_CHOICES)[number];

/** `auto` の選択順（docs/07 §9） */
export const HWACCEL_ORDER: ReadonlyArray<{ kind: HwaccelChoice; encoder: string }> = [
  { kind: "videotoolbox", encoder: "h264_videotoolbox" },
  { kind: "nvenc", encoder: "h264_nvenc" },
  { kind: "vaapi", encoder: "h264_vaapi" },
  { kind: "qsv", encoder: "h264_qsv" },
];

export interface HwSelection {
  encoder: string | null;
  kind: HwaccelChoice;
  warnings: Warning[];
}

/**
 * 利用可能なエンコーダから hwaccel を選ぶ。
 * `auto` は上の順で最初に見つかったもの（1 つも無ければソフトウェアのまま `W_HWACCEL_UNAVAILABLE`）。
 * 明示指定が使えない場合は `E_FFMPEG_FEATURE_MISSING`。
 */
export function selectHwEncoder(requested: HwaccelChoice, encoders: ReadonlySet<string>): HwSelection {
  if (requested === "none") return { encoder: null, kind: "none", warnings: [] };
  if (requested === "auto") {
    const hit = HWACCEL_ORDER.find((h) => encoders.has(h.encoder));
    if (hit) return { encoder: hit.encoder, kind: hit.kind, warnings: [] };
    return {
      encoder: null,
      kind: "none",
      warnings: [
        warning("W_HWACCEL_UNAVAILABLE", "no hardware H.264 encoder was found; falling back to libx264", {
          hint: `Looked for: ${HWACCEL_ORDER.map((h) => h.encoder).join(", ")}. Run \`montash doctor\` to see what this ffmpeg build has.`,
        }),
      ],
    };
  }
  const entry = HWACCEL_ORDER.find((h) => h.kind === requested);
  if (!entry) throw new MontashError("E_USAGE", `unknown --hwaccel ${requested}`);
  if (!encoders.has(entry.encoder))
    throw new MontashError("E_FFMPEG_FEATURE_MISSING", `this ffmpeg build has no ${entry.encoder} encoder`, {
      hint: "Use --hwaccel auto (falls back to libx264) or --hwaccel none. `montash doctor` lists the available encoders.",
      detail: { requested, encoder: entry.encoder },
    });
  return { encoder: entry.encoder, kind: entry.kind, warnings: [] };
}

/** 2 パスが使える codec か（docs/07 §9: libx264 / libx265 でビットレート指定時のみ） */
export function supportsTwoPass(codec: string): boolean {
  return codec === "libx264" || codec === "libx265";
}
