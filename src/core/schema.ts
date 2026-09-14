/**
 * `project.json` の zod スキーマ（docs/05-project-format.md, schema_version 2）。
 *
 * - 時間はすべて整数フレーム `_f`（プロジェクト fps 基準）、音声補正のみ整数サンプル `_smp`（ADR-09）。
 * - 未知フィールドは保持する（`looseObject`）。追加のみの変更では schema_version を上げない（docs/05 §13）。
 * - ffprobe の生 JSON（`probe`）は含めない。`.montash/cache/<id>/probe.json` に置く（ADR-14）。
 */
import { z } from "zod";

export const SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// 基本型
// ---------------------------------------------------------------------------

/** 非負の整数フレーム（`_f`）。`z.int()` は安全整数のみ受理する */
export const FrameSchema = z.int().nonnegative();
/** 整数サンプル（`_smp`）。負も可（同期の前倒し） */
export const SampleSchema = z.int();
const posInt = z.int().positive();
/** px 整数 または "5%" のような文字列 */
const PxOrPercent = z.union([z.int(), z.string().regex(/^-?\d+(\.\d+)?%$/)]);
const Color = z.string();

export const FpsSchema = z.object({ num: posInt, den: posInt });
export type Fps = z.infer<typeof FpsSchema>;

export const ResolutionSchema = z.object({ width: posInt, height: posInt });
export type Resolution = z.infer<typeof ResolutionSchema>;

// ---------------------------------------------------------------------------
// settings（§4）
// ---------------------------------------------------------------------------

export const SettingsSchema = z.looseObject({
  fps: FpsSchema,
  resolution: ResolutionSchema,
  sample_rate: posInt.default(48000),
  channels: posInt.default(2),
  background: Color.default("#000000"),
  default_image_duration_f: z.int().positive(),
  default_font: z.string().default("Noto Sans CJK JP"),
  text_engine: z.enum(["libass", "drawtext"]).default("libass"),
  proxy: z
    .looseObject({ height: posInt.default(360), crf: z.int().nonnegative().default(28) })
    .default({ height: 360, crf: 28 }),
  preview: z
    .looseObject({ auto_build: z.boolean().default(true), debounce_ms: z.int().nonnegative().default(1500) })
    .default({ auto_build: true, debounce_ms: 1500 }),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------
// assets（§5）
// ---------------------------------------------------------------------------

export const DerivedStateSchema = z.enum(["ready", "building", "missing", "stale"]);
export const DerivedEntrySchema = z.looseObject({
  state: DerivedStateSchema,
  path: z.string().optional(),
  index: z.string().optional(),
  built_at: z.string().optional(),
});
export const DerivedSchema = z.record(z.string(), DerivedEntrySchema);

export const VideoStreamInfoSchema = z.looseObject({
  codec: z.string().optional(),
  width: posInt.optional(),
  height: posInt.optional(),
  fps: FpsSchema.optional(),
  pix_fmt: z.string().optional(),
  has_alpha: z.boolean().optional(),
  rotation: z.number().optional(),
});
export const AudioStreamInfoSchema = z.looseObject({
  codec: z.string().optional(),
  sample_rate: posInt.optional(),
  channels: posInt.optional(),
});
export const ContainerInfoSchema = z.looseObject({
  format: z.string().optional(),
  bit_rate: z.number().optional(),
});

const AssetBase = z.looseObject({
  id: z.string().min(1),
  path: z.string().min(1),
  owned: z.boolean().default(false),
  label: z.string().optional(),
  tags: z.array(z.string()).default([]),
  color: Color.optional(),
  note: z.string().optional(),
  imported_by: z.enum(["ai", "human", "web", "system"]).optional(),
  imported_at: z.string().optional(),
  size: z.int().nonnegative().optional(),
  mtime: z.string().optional(),
  hash_head: z.string().optional(),
  /** ffprobe の値（参照）。image / text は null */
  duration_s: z.number().nonnegative().nullable().optional(),
  /** floor(duration_s * num / den)。in/out の上限。image / text は null */
  duration_f: z.int().nonnegative().nullable().optional(),
  start_time_s: z.number().optional(),
  derived: DerivedSchema.optional(),
});

export const VideoAssetSchema = AssetBase.extend({
  type: z.literal("video"),
  video: VideoStreamInfoSchema.optional(),
  audio: AudioStreamInfoSchema.nullable().optional(),
  container: ContainerInfoSchema.optional(),
});
export const AudioAssetSchema = AssetBase.extend({
  type: z.literal("audio"),
  audio: AudioStreamInfoSchema.optional(),
  container: ContainerInfoSchema.optional(),
});
export const ImageAssetSchema = AssetBase.extend({
  type: z.literal("image"),
  video: VideoStreamInfoSchema.optional(),
});
export const SubtitleAssetSchema = AssetBase.extend({
  type: z.literal("subtitle"),
  format: z.enum(["srt", "ass", "vtt"]).optional(),
  language: z.string().optional(),
});
export const TextAssetSchema = AssetBase.extend({
  type: z.literal("text"),
  text_preview: z.string().optional(),
  line_count: z.int().nonnegative().optional(),
});

export const AssetSchema = z.discriminatedUnion("type", [
  VideoAssetSchema,
  AudioAssetSchema,
  ImageAssetSchema,
  SubtitleAssetSchema,
  TextAssetSchema,
]);
export type Asset = z.infer<typeof AssetSchema>;
export type AssetType = Asset["type"];

// ---------------------------------------------------------------------------
// clips（§6.1〜6.4）
// ---------------------------------------------------------------------------

export const VideoFadeSchema = z.looseObject({
  in_f: FrameSchema.default(0),
  out_f: FrameSchema.default(0),
  color: Color.default("black"),
});
export const AudioFadeSchema = z.looseObject({
  in_f: FrameSchema.default(0),
  out_f: FrameSchema.default(0),
  curve: z.string().default("tri"),
});

export const TransformSchema = z.looseObject({
  position: z.string().nullable().default(null),
  x: PxOrPercent.nullable().default(null),
  y: PxOrPercent.nullable().default(null),
  margin: PxOrPercent.default(0),
  scale: z.number().positive().default(1),
  rotate: z.number().default(0),
});

export const ClipVideoSchema = z.looseObject({
  opacity: z.number().min(0).max(1).default(1),
  transform: TransformSchema.nullable().default(null),
  crop: z.looseObject({ x: PxOrPercent, y: PxOrPercent, w: PxOrPercent, h: PxOrPercent }).nullable().default(null),
  color: z
    .looseObject({
      brightness: z.number().optional(),
      contrast: z.number().optional(),
      saturation: z.number().optional(),
      gamma: z.number().optional(),
    })
    .nullable()
    .default(null),
  lut: z.string().nullable().default(null),
  keep_alpha: z.boolean().default(false),
  fade: VideoFadeSchema.default({ in_f: 0, out_f: 0, color: "black" }),
});

export const ClipAudioSchema = z.looseObject({
  gain_db: z.number().default(0),
  fade: AudioFadeSchema.default({ in_f: 0, out_f: 0, curve: "tri" }),
  offset_smp: SampleSchema.default(0),
  muted: z.boolean().default(false),
});

export const EffectSchema = z.looseObject({
  type: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  keyframes: z.array(z.unknown()).optional(),
});

/** 映像・音声クリップ（アセット参照）。`duration_f` は保存せず speed から算出する */
export const ClipSchema = z.looseObject({
  id: z.string().min(1),
  asset: z.string().min(1),
  start_f: FrameSchema,
  in_f: FrameSchema,
  out_f: FrameSchema,
  speed: z.number().positive().default(1),
  pitch_keep: z.boolean().default(false),
  loop: z.boolean().default(false),
  link: z.string().nullable().default(null),
  label: z.string().optional(),
  video: ClipVideoSchema.optional(),
  audio: ClipAudioSchema.optional(),
  effects: z.array(EffectSchema).default([]),
});
export type Clip = z.infer<typeof ClipSchema>;

export const TextPositionSchema = z.union([z.string(), z.looseObject({ x: PxOrPercent, y: PxOrPercent })]);

export const TextStyleSchema = z.looseObject({
  preset: z.string().optional(),
  font: z.string().optional(),
  size: z.number().positive().optional(),
  color: Color.optional(),
  alpha: z.number().min(0).max(1).optional(),
  bg: Color.nullable().optional(),
  bg_padding: z.number().nonnegative().optional(),
  position: TextPositionSchema.optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  line_spacing: z.number().optional(),
  wrap: z.boolean().optional(),
  shadow: z.looseObject({ x: z.number(), y: z.number(), color: Color }).nullable().optional(),
  outline: z.looseObject({ width: z.number().nonnegative(), color: Color }).nullable().optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
});

/** テキストクリップ（`kind: text` トラック） */
export const TextClipSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal("text"),
  start_f: FrameSchema,
  duration_f: z.int().positive(),
  text: z.string().default(""),
  asset: z.string().nullable().default(null),
  markup: z.enum(["plain", "ass"]).default("plain"),
  style: TextStyleSchema.default({}),
  fade: z.looseObject({ in_f: FrameSchema.default(0), out_f: FrameSchema.default(0) }).default({ in_f: 0, out_f: 0 }),
});
export type TextClip = z.infer<typeof TextClipSchema>;

/** 字幕クリップ（`kind: text` トラック） */
export const SubtitleClipSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal("subtitle"),
  asset: z.string().min(1),
  mode: z.enum(["burn", "soft"]).default("burn"),
  start_f: FrameSchema,
  offset_f: z.int().default(0),
  style: z
    .looseObject({
      font: z.string().optional(),
      size: z.number().positive().optional(),
      margin_bottom: z.number().optional(),
    })
    .default({}),
  lang: z.string().optional(),
});
export type SubtitleClip = z.infer<typeof SubtitleClipSchema>;

/** 生成クリップ（`asset` の代わりに `generator`） */
export const GeneratorClipSchema = z.looseObject({
  id: z.string().min(1),
  generator: z.enum(["color", "hold"]),
  params: z.record(z.string(), z.unknown()).default({}),
  start_f: FrameSchema,
  duration_f: z.int().positive(),
  label: z.string().optional(),
});
export type GeneratorClip = z.infer<typeof GeneratorClipSchema>;

/** トラック上に置けるクリップの総和型。判別は clipKind() */
export const TrackClipSchema = z.union([TextClipSchema, SubtitleClipSchema, GeneratorClipSchema, ClipSchema]);
export type TrackClip = z.infer<typeof TrackClipSchema>;

// ---------------------------------------------------------------------------
// tracks（§6）
// ---------------------------------------------------------------------------

export const TrackKindSchema = z.enum(["video", "audio", "text"]);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const TrackSchema = z.looseObject({
  id: z.string().min(1),
  kind: TrackKindSchema,
  name: z.string().optional(),
  muted: z.boolean().default(false),
  locked: z.boolean().default(false),
  fade: VideoFadeSchema.default({ in_f: 0, out_f: 0, color: "black" }),
  clips: z.array(TrackClipSchema).default([]),
});
export type Track = z.infer<typeof TrackSchema>;

// ---------------------------------------------------------------------------
// transitions（§7）
// ---------------------------------------------------------------------------

export const TransitionSchema = z.looseObject({
  id: z.string().min(1),
  track: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.string().default("fade"),
  duration_f: z.int().positive(),
  mode: z.enum(["handle", "overlap"]).default("handle"),
  audio: z.enum(["crossfade", "cut"]).default("crossfade"),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type Transition = z.infer<typeof TransitionSchema>;

// ---------------------------------------------------------------------------
// audio（§8）
// ---------------------------------------------------------------------------

export const DuckingSchema = z.looseObject({
  id: z.string().min(1),
  target: z.string().min(1),
  sidechain: z.string().min(1),
  threshold_db: z.number().default(-30),
  ratio: z.number().positive().default(8),
  attack_ms: z.number().nonnegative().default(20),
  release_ms: z.number().nonnegative().default(500),
  makeup_db: z.number().default(0),
});
export type Ducking = z.infer<typeof DuckingSchema>;

export const AudioSettingsSchema = z.looseObject({
  master_gain_db: z.number().default(0),
  normalize: z
    .looseObject({
      enabled: z.boolean().default(true),
      i: z.number().default(-14),
      tp: z.number().default(-1),
      lra: z.number().default(11),
    })
    .default({ enabled: true, i: -14, tp: -1, lra: 11 }),
  ducking: z.array(DuckingSchema).default([]),
  track_gain_db: z.record(z.string(), z.number()).default({}),
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

// ---------------------------------------------------------------------------
// text_presets / render_presets / meta（§9, §10）
// ---------------------------------------------------------------------------

export const TextPresetSchema = TextStyleSchema.extend({
  fade: z.looseObject({ in_f: FrameSchema.default(0), out_f: FrameSchema.default(0) }).optional(),
});
export const RenderPresetSchema = z.looseObject({ base: z.string().optional() });
export const MetaSchema = z.looseObject({
  last_render: z.unknown().optional(),
  tags: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// project（§3）
// ---------------------------------------------------------------------------

export const ProjectSchema = z.looseObject({
  schema_version: z.literal(SCHEMA_VERSION),
  name: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  settings: SettingsSchema,
  assets: z.record(z.string(), AssetSchema).default({}),
  tracks: z.array(TrackSchema).default([]),
  transitions: z.array(TransitionSchema).default([]),
  audio: AudioSettingsSchema.default({
    master_gain_db: 0,
    normalize: { enabled: true, i: -14, tp: -1, lra: 11 },
    ducking: [],
    track_gain_db: {},
  }),
  text_presets: z.record(z.string(), TextPresetSchema).default({}),
  render_presets: z.record(z.string(), RenderPresetSchema).default({}),
  meta: MetaSchema.default({ tags: [] }),
});
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectInput = z.input<typeof ProjectSchema>;

// ---------------------------------------------------------------------------
// 派生値ヘルパ（保存しない値を算出する。docs/05 §6.1）
// ---------------------------------------------------------------------------

export type ClipKind = "media" | "text" | "subtitle" | "generator";

/** トラック上のクリップの種別を判定する */
export function clipKind(clip: TrackClip): ClipKind {
  if ("type" in clip && clip.type === "text") return "text";
  if ("type" in clip && clip.type === "subtitle") return "subtitle";
  if ("generator" in clip) return "generator";
  return "media";
}

export function isMediaClip(clip: TrackClip): clip is Clip {
  return clipKind(clip) === "media";
}
export function isTextClip(clip: TrackClip): clip is TextClip {
  return clipKind(clip) === "text";
}
export function isSubtitleClip(clip: TrackClip): clip is SubtitleClip {
  return clipKind(clip) === "subtitle";
}
export function isGeneratorClip(clip: TrackClip): clip is GeneratorClip {
  return clipKind(clip) === "generator";
}

/**
 * クリップのタイムライン上の長さ（フレーム）。
 * 映像・音声: `max(1, round((out_f - in_f) / speed))`。テキスト・生成: `duration_f`。
 * 字幕: 長さを持たない（字幕ファイル全体）ため 0 を返す。
 */
export function clipDurationF(clip: TrackClip): number {
  if (isMediaClip(clip)) {
    const speed = clip.speed > 0 ? clip.speed : 1;
    return Math.max(1, Math.round((clip.out_f - clip.in_f) / speed));
  }
  if (isSubtitleClip(clip)) return 0;
  return clip.duration_f;
}

/** クリップの終了フレーム（exclusive） */
export function clipEndF(clip: TrackClip): number {
  return clip.start_f + clipDurationF(clip);
}
