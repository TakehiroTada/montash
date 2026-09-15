/**
 * オーバーレイ（docs/04 §10、docs/05 §6.1、docs/07 §5、W-08）。
 *
 * オーバーレイは独立した要素ではなく「`video.transform` が設定された映像クリップ」に過ぎない
 * （docs/05 §6.1）。したがって `overlay add` は `clip add` と同じ置き方をしたうえで
 * `video.transform` / `opacity` / `fade` / `keep_alpha` を書くだけの糖衣で、描画側
 * （`src/ffmpeg/graph/overlay.ts`）はそれを見て `overlay=x=..:y=..:enable=between(n,..)` を組む。
 *
 * 音声はリンクしない（PiP の映像を重ねるコマンドなので、音を足したいときは `clip add --audio-only`）。
 */

import { timelineDurationF } from "../../core/assets.ts";
import { findClip, removeClips, sortClips } from "../../core/clip-editing.ts";
import { assertIdAvailable, existingIds, nextId, readIds } from "../../core/ids.ts";
import { loadProject } from "../../core/project.ts";
import {
  type Clip,
  ClipSchema,
  clipDurationF,
  clipEndF,
  isMediaClip,
  type Project,
  type Resolution,
  type Track,
  TrackSchema,
} from "../../core/schema.ts";
import { framesToSeconds } from "../../core/time.ts";
import { assertPlacement, nextTrackId, requireTrack } from "../../core/timeline.ts";
import { overlayPosition } from "../../ffmpeg/graph/overlay.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning, warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";
import { requireAsset } from "./assets.ts";

// ---------------------------------------------------------------------------
// 引数の解釈
// ---------------------------------------------------------------------------

/** px 整数、または `12%` のような割合（docs/05 §2 の PxOrPercent） */
const PX_OR_PERCENT = /^-?\d+(?:\.\d+)?%$|^-?\d+$/;

function pxOrPercent(raw: string, option: string): number | string {
  const text = raw.trim();
  if (!PX_OR_PERCENT.test(text))
    throw errors.usage(`${option} must be an integer in px or a percentage like "5%"`, `Got ${JSON.stringify(raw)}.`);
  return text.endsWith("%") ? text : Number(text);
}

export interface ParsedPosition {
  position: string | null;
  x: number | string | null;
  y: number | string | null;
}

/**
 * `--position` の解釈。`top-right` のようなプリセット名、または `x,y` / `x%,y%` の座標。
 * プリセット名の妥当性はグラフ側（`overlayPosition`）に判定させ、hint も流用する。
 */
export function parsePosition(raw: string, res: Resolution): ParsedPosition {
  const text = raw.trim();
  if (text.includes(",")) {
    const parts = text.split(",");
    if (parts.length !== 2) throw errors.usage(`--position accepts "x,y" with exactly two values`);
    return { position: null, x: pxOrPercent(parts[0]!, "--position x"), y: pxOrPercent(parts[1]!, "--position y") };
  }
  // プリセット名の検査はプリセット表を持っているグラフ側に任せる（E_USAGE + 候補一覧）
  overlayPosition({ position: text, x: null, y: null, margin: 0, scale: 1, rotate: 0 }, res);
  return { position: text, x: null, y: null };
}

/**
 * `--scale` の解釈。`0.12` のような倍率、または `320x180`（元素材の縦横比を保って収める枠）。
 * 枠指定はグラフ側が倍率しか持たないので、`force_original_aspect_ratio=decrease` と同じ
 * `min(W/iw, H/ih)` に畳んで倍率にする（docs/07 §5）。
 */
export function parseScale(raw: string, source: { width?: number; height?: number } | undefined): number {
  const text = raw.trim();
  const box = /^(\d+)x(\d+)$/.exec(text);
  if (box) {
    const [w, h] = [Number(box[1]), Number(box[2])];
    if (!source?.width || !source?.height)
      throw errors.usage(
        `--scale ${text} needs the source resolution, which is unknown for this asset`,
        "Pass a ratio like --scale 0.3 instead.",
      );
    return Math.min(w / source.width, h / source.height);
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0)
    throw errors.usage(`--scale must be a positive ratio (0.12) or a box (320x180)`, `Got ${JSON.stringify(raw)}.`);
  return value;
}

function parseOpacity(value: unknown): number {
  const opacity = Number(value);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw errors.usage("--opacity must be between 0 and 1");
  return opacity;
}

/** 映像として重ねられる素材か（テキスト・字幕・音声は対象外） */
function requireOverlayAsset(project: Project, id: string) {
  const asset = requireAsset(project, id);
  if (asset.type !== "video" && asset.type !== "image")
    throw new MontashError("E_ASSET_TYPE_MISMATCH", `asset "${asset.id}" is a ${asset.type} asset`, {
      hint: "Overlays are video or image assets. Use `text add` for captions and `clip add --audio-only` for sound.",
      detail: { asset: asset.id, type: asset.type },
    });
  return asset;
}

/**
 * 置き先の映像トラック。無ければ作る（`--track V2` で V2 が無ければ映像トラックとして追加）。
 * `--track` 省略時は最上位の映像トラックの 1 つ上（`V1` しか無ければ `V2`）。
 */
export function resolveOverlayTrack(project: Project, requested: string | undefined): { track: Track; added: boolean } {
  const id = requested ?? nextTrackId(project, "video");
  const found = project.tracks.find((t) => t.id === id);
  if (found) {
    if (found.kind !== "video") throw errors.usage(`track ${found.id} has incompatible kind ${found.kind}`);
    return { track: found, added: false };
  }
  const track = TrackSchema.parse({ id, kind: "video", name: id });
  // 映像トラック群の最後（＝合成順で一番上）に差し込む
  const lastVideo = project.tracks.map((t) => t.kind).lastIndexOf("video");
  project.tracks.splice(lastVideo < 0 ? project.tracks.length : lastVideo + 1, 0, track);
  return { track, added: true };
}

/** `overlay add` / `overlay set` が共有するスタイル系オプション */
const styleOptions = {
  position: { type: "string", describe: "preset (top-right ...), or x,y / x%,y% coordinates" },
  margin: { type: "string", describe: "margin from the edge in px or % (presets only)" },
  scale: { type: "string", describe: "size as a ratio (0.12) or a box (320x180)" },
  opacity: { type: "number", describe: "opacity, 0..1" },
  "fade-in": { type: "string", describe: "fade in duration", time: true },
  "fade-out": { type: "string", describe: "fade out duration", time: true },
  "keep-alpha": { type: "boolean", describe: "keep the source alpha channel (alpha PNG / ProRes 4444)" },
} as const;

interface StyleArgs {
  position?: unknown;
  margin?: unknown;
  scale?: unknown;
  opacity?: unknown;
  fadeIn?: unknown;
  fadeOut?: unknown;
  keepAlpha?: unknown;
}

const STYLE_KEYS = ["position", "margin", "scale", "opacity", "fadeIn", "fadeOut", "keepAlpha"] as const;

/**
 * スタイル系オプションをクリップの `video` ブロックへ適用する。
 * `transform` は「オーバーレイである」ことの印なので、`overlay add` では常に作る。
 */
function applyStyle(
  clip: Clip,
  args: StyleArgs,
  ctx: { res: Resolution; source: { width?: number; height?: number } | undefined; frames: (input: string) => number },
): string[] {
  const video = clip.video;
  if (!video) throw errors.usage(`clip "${clip.id}" is not a video clip`);
  const touched: string[] = [];
  const transform = video.transform ?? { position: null, x: null, y: null, margin: 0, scale: 1, rotate: 0 };
  if (args.position !== undefined) {
    Object.assign(transform, parsePosition(String(args.position), ctx.res));
    touched.push("position");
  }
  if (args.margin !== undefined) {
    transform.margin = pxOrPercent(String(args.margin), "--margin");
    touched.push("margin");
  }
  if (args.scale !== undefined) {
    transform.scale = parseScale(String(args.scale), ctx.source);
    touched.push("scale");
  }
  video.transform = transform;
  if (args.opacity !== undefined) {
    video.opacity = parseOpacity(args.opacity);
    touched.push("opacity");
  }
  if (args.keepAlpha !== undefined) {
    video.keep_alpha = Boolean(args.keepAlpha);
    touched.push("keep_alpha");
  }
  const duration = clipDurationF(clip);
  if (args.fadeIn !== undefined) {
    video.fade.in_f = Math.min(ctx.frames(String(args.fadeIn)), duration);
    touched.push("fade_in");
  }
  if (args.fadeOut !== undefined) {
    video.fade.out_f = Math.min(ctx.frames(String(args.fadeOut)), duration);
    touched.push("fade_out");
  }
  if (video.fade.in_f + video.fade.out_f > duration)
    throw errors.usage(`--fade-in and --fade-out are longer than the overlay (f:${duration})`);
  return touched;
}

// ---------------------------------------------------------------------------
// overlay add
// ---------------------------------------------------------------------------

export const overlayAdd = defineCommand({
  path: "overlay add",
  summary: "place an image or video on an upper video track as an overlay",
  workflows: ["W-08"],
  mutates: true,
  options: {
    asset: { type: "string", describe: "asset ID (video or image)", required: true },
    track: { type: "string", describe: "target video track; created if missing (default: one above the top one)" },
    at: { type: "string", describe: "timeline position (default: 0)", time: true },
    duration: { type: "string", describe: "overlay duration (`timeline` for the whole timeline)", time: true },
    until: { type: "string", describe: "timeline position to stop at, instead of --duration", time: true },
    in: { type: "string", describe: "source in point", time: true },
    ...styleOptions,
    id: { type: "string", describe: "explicit clip ID" },
    label: { type: "string", describe: "clip label" },
  },
  examples: [
    {
      cmd: "montash overlay add --asset logo --track V2 --at 0 --duration timeline --position top-right --scale 0.12 --opacity 0.9",
      note: "W-08: put a logo in the top-right corner for the whole timeline",
    },
  ],
  async handler(ctx, args) {
    if (args.duration !== undefined && args.until !== undefined) throw errors.usage("use either --duration or --until");
    return runMutation(ctx, async ({ project, dir, fps }) => {
      const asset = requireOverlayAsset(project, String(args.asset));
      const warnings: Warning[] = [];
      const timeline = timelineDurationF(project);
      const length = asset.duration_f ?? undefined;
      const time = (input: string, end?: number, duration = false) => {
        const parsed = parseTimeInput(input, fps, {
          allowRelative: false,
          allowEnd: !duration,
          allowTimeline: duration,
        });
        if (parsed.warning) warnings.push(parsed.warning);
        return resolveAbsolute(parsed, { fps, end, current: end, timelineLength: timeline });
      };

      const startF = args.at === undefined ? 0 : time(String(args.at), timeline);
      if (startF < 0) throw errors.usage("placement starts before the timeline");
      const inF = args.in === undefined ? 0 : time(String(args.in), length);
      let outF: number;
      if (args.duration !== undefined) outF = inF + time(String(args.duration), undefined, true);
      else if (args.until !== undefined) {
        const until = time(String(args.until), timeline);
        if (until <= startF) throw errors.usage("--until must be after --at");
        outF = inF + (until - startF);
      } else if (asset.type === "image") outF = inF + project.settings.default_image_duration_f;
      else if (length !== undefined) outF = length;
      else throw errors.usage("asset duration is unknown; specify --duration or --until");
      // 画像は同じ 1 枚を伸ばすだけなので尺の上限が無い。映像は素材末尾で頭打ちにする
      if (asset.type !== "image" && length !== undefined && outF > length) {
        outF = length;
        warnings.push(warning("W_CLIP_SHORTER_THAN_REQUESTED", `overlay shortened to asset end f:${length}`));
      }
      if (outF <= inF || (asset.type !== "image" && length !== undefined && outF > length))
        throw new MontashError("E_RANGE_OUT_OF_ASSET", `invalid source range f:${inF}..f:${outF}`, {
          hint: `Choose 0 <= in < out${length === undefined ? "" : ` <= f:${length}`}.`,
        });

      const { track, added } = resolveOverlayTrack(project, args.track === undefined ? undefined : String(args.track));
      assertPlacement(track, startF, startF + outF - inF);
      if (args.id !== undefined) assertIdAvailable(project, String(args.id));
      // 採番カウンタが手編集の ID と衝突することがあるので、空いている ID まで進める（clip add と同じ）
      const used = existingIds(project);
      let dryCounter = (await readIds(dir))?.counters.c ?? 1;
      let id = args.id === undefined ? "" : String(args.id);
      while (id === "") {
        const candidate = ctx.globals.dryRun ? `c${dryCounter++}` : await nextId(dir, "c");
        if (!used.has(candidate)) id = candidate;
      }

      const clip = ClipSchema.parse({
        id,
        asset: asset.id,
        start_f: startF,
        in_f: inF,
        out_f: outF,
        label: args.label,
        video: {},
      });
      applyStyle(clip, args as StyleArgs, {
        res: project.settings.resolution,
        source: asset.type === "video" || asset.type === "image" ? asset.video : undefined,
        frames: (input) => time(input, undefined, true),
      });
      track.clips.push(clip);
      sortClips(project);

      const endF = clipEndF(clip);
      if (endF > Math.max(timeline, 1) && timeline > 0)
        warnings.push(warning("W_BEYOND_TIMELINE", `overlay ends at f:${endF}, past the timeline end f:${timeline}`));
      return {
        result: { overlay: describeOverlay(clip, track.id, project), track_added: added ? track.id : null },
        summary: `add overlay ${clip.id} (${asset.id}) on ${track.id} at f:${startF}`,
        affects: { clips: [clip.id], range_f: [startF, endF] as [number, number] },
        warnings,
        human: `${clip.id}  ${track.id}  f:${startF}..f:${endF}  ${asset.id}${added ? ` (track ${track.id} created)` : ""}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// overlay set / remove / list
// ---------------------------------------------------------------------------

/** `video.transform` を持つ映像クリップ（＝オーバーレイ）を引く */
function requireOverlay(project: Project, id: string) {
  const found = findClip(project, id);
  const clip = found.clip;
  if (!isMediaClip(clip) || !clip.video || clip.video.transform === null)
    throw new MontashError("E_CLIP_NOT_FOUND", `clip "${id}" is not an overlay`, {
      hint: "Run `montash overlay list` to see the overlays, or use `clip set` for a regular clip.",
      detail: { clip: id },
    });
  if (found.track.locked) throw new MontashError("E_TRACK_LOCKED", `track ${found.track.id} is locked`);
  return { clip, track: found.track };
}

function describeOverlay(clip: Clip, trackId: string, project: Project) {
  const fps = project.settings.fps;
  return {
    id: clip.id,
    track: trackId,
    asset: clip.asset,
    label: clip.label,
    start_f: clip.start_f,
    end_f: clipEndF(clip),
    duration_f: clipDurationF(clip),
    start: framesToSeconds(clip.start_f, fps),
    duration: framesToSeconds(clipDurationF(clip), fps),
    in_f: clip.in_f,
    out_f: clip.out_f,
    transform: clip.video?.transform ?? null,
    opacity: clip.video?.opacity ?? 1,
    keep_alpha: clip.video?.keep_alpha ?? false,
    fade: clip.video?.fade ?? null,
  };
}

export const overlaySet = defineCommand({
  path: "overlay set",
  summary: "change the position, size, opacity or fades of an overlay",
  workflows: ["W-08"],
  mutates: true,
  positionals: [{ name: "id", describe: "overlay clip ID", required: true }],
  options: { ...styleOptions },
  examples: [{ cmd: "montash overlay set c3 --position bottom-right --scale 0.3" }],
  async handler(ctx, args) {
    if (!STYLE_KEYS.some((k) => (args as StyleArgs)[k] !== undefined))
      throw errors.usage(
        "specify at least one of --position, --margin, --scale, --opacity, --fade-in, --fade-out, --keep-alpha",
      );
    return runMutation(ctx, ({ project, fps }) => {
      const { clip, track } = requireOverlay(project, String(args.id));
      const asset = project.assets[clip.asset];
      const touched = applyStyle(clip, args as StyleArgs, {
        res: project.settings.resolution,
        source: asset && (asset.type === "video" || asset.type === "image") ? asset.video : undefined,
        frames: (input) => {
          const parsed = parseTimeInput(input, fps, { allowRelative: false, allowEnd: false, allowTimeline: false });
          return resolveAbsolute(parsed, { fps });
        },
      });
      return {
        result: { overlay: describeOverlay(clip, track.id, project) },
        summary: `set ${touched.join(", ")} on overlay ${clip.id}`,
        affects: { clips: [clip.id], range_f: [clip.start_f, clipEndF(clip)] as [number, number] },
        human: `${clip.id}  ${track.id}  ${touched.join(", ")}`,
      };
    });
  },
});

export const overlayRemove = defineCommand({
  path: "overlay remove",
  summary: "remove an overlay clip",
  workflows: ["W-08"],
  mutates: true,
  positionals: [{ name: "id", describe: "overlay clip ID", required: true }],
  async handler(ctx, args) {
    return runMutation(ctx, ({ project }) => {
      const { clip, track } = requireOverlay(project, String(args.id));
      const range: [number, number] = [clip.start_f, clipEndF(clip)];
      const warnings: Warning[] = [];
      removeClips(project, new Set([clip.id]), warnings);
      return {
        result: { removed: clip.id, track: track.id },
        summary: `remove overlay ${clip.id} from ${track.id}`,
        affects: { clips: [clip.id], range_f: range },
        warnings,
        human: `${clip.id}  removed from ${track.id}`,
      };
    });
  },
});

export const overlayList = defineCommand({
  path: "overlay list",
  summary: "list overlays (video clips that carry a transform)",
  workflows: ["W-08"],
  options: { track: { type: "string", describe: "only this track" } },
  async handler(ctx, args) {
    const project = await loadProject(ctx.requireProjectDir());
    const tracks = args.track ? [requireTrack(project, String(args.track))] : project.tracks;
    const overlays = tracks.flatMap((t) =>
      t.clips
        .filter((c): c is Clip => isMediaClip(c) && Boolean(c.video) && c.video?.transform != null)
        .sort((a, b) => a.start_f - b.start_f)
        .map((c) => describeOverlay(c, t.id, project)),
    );
    return {
      result: { overlays },
      human:
        overlays
          .map(
            (o) =>
              `${o.track}  ${o.id}  f:${o.start_f}..f:${o.end_f}  ${o.asset}  ${o.transform?.position ?? `${o.transform?.x},${o.transform?.y}`}  scale=${o.transform?.scale}  opacity=${o.opacity}`,
          )
          .join("\n") || "no overlays",
    };
  },
});
