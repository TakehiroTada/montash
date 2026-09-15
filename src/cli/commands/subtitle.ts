/**
 * 字幕（docs/04 §12: `subtitle add|set|remove|list`、W-14）。
 *
 * 字幕クリップは `kind: text` トラックに置き、尺を持たない（字幕ファイル全体が 1 クリップ）。
 *
 * - `mode: burn` の SRT/VTT はテロップと同じ 1 つの ASS に Events として統合して焼く
 * - `mode: burn` の ASS 素材は素材のスタイルを尊重するため別の `subtitles` フィルタで焼く
 * - `mode: soft` はレンダー時に多重化するだけ（`-c:s mov_text`）
 *
 * ここでは `project.json` の内容だけを扱い、焼き込みの結線は `src/ffmpeg/text-prepare.ts` が行う。
 */
import { assertIdAvailable, nextId, readIds } from "../../core/ids.ts";
import { loadProject } from "../../core/project.ts";
import {
  isSubtitleClip,
  type Project,
  type SubtitleClip,
  SubtitleClipSchema,
  type SubtitleStyle,
  type Track,
  TrackSchema,
} from "../../core/schema.ts";
import { framesToSeconds } from "../../core/time.ts";
import { nextTrackId, requireTrack } from "../../core/timeline.ts";
import { assColor, DEFAULT_BG_PADDING, findFontEntry, pickCjkFallback, suggestFamilies } from "../../ffmpeg/ass.ts";
import { type FontEntry, listFonts } from "../../ffmpeg/fonts.ts";
import { POSITION_NAMES } from "../../registry/positions.ts";
import type { CommandContext } from "../context.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning } from "../errors.ts";
import { currentHead, runMutation } from "../mutate.ts";
import { parseTimeInput } from "../time-input.ts";
import { requireAsset } from "./assets.ts";
import { parseOutline, parsePosition, parseShadow } from "./text.ts";

type Args = Record<string, unknown>;

/** yargs は `--margin-bottom` を `marginBottom` としても渡す */
function option(args: Args, name: string): unknown {
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  return args[camel] ?? args[name];
}

function has(args: Args, name: string): boolean {
  return option(args, name) !== undefined;
}

// ---------------------------------------------------------------------------
// オプション定義（add と set で共有する）
// ---------------------------------------------------------------------------

/**
 * `subtitle add` と `subtitle set` が共有するスタイル指定。
 *
 * 名前も書式も **`text add` と同じ**（`--bg` / `--bg-padding` / `--shadow` / `--outline` / `--position` /
 * `--bold`）。字幕でよく使う「太さだけ」「深さだけ」を短く書けるよう、`--outline` と `--shadow` は
 * px だけの略記も受ける（`--outline 3` = `--outline 3,#000000`）。
 */
const STYLE_OPTIONS = {
  font: { type: "string" as const, describe: "font family (default: settings.default_font, then a CJK font)" },
  size: { type: "number" as const, describe: "font size in px (project resolution basis)" },
  color: { type: "string" as const, describe: "text color #RRGGBB[AA]" },
  outline: { type: "string" as const, describe: 'outline width in px, "px,#RRGGBB[AA]", or none' },
  "outline-color": { type: "string" as const, describe: "outline color #RRGGBB[AA] (needs --outline)" },
  bg: { type: "string" as const, describe: "background box color #RRGGBB[AA], or none (wins over outline/shadow)" },
  "bg-padding": { type: "number" as const, describe: `background box padding in px (default ${DEFAULT_BG_PADDING})` },
  shadow: { type: "string" as const, describe: 'drop shadow depth in px, "x,y,#RRGGBB[AA]", or none' },
  position: {
    type: "string" as const,
    describe: `position preset (${POSITION_NAMES.join(", ")}), "x,y" or "x%,y%" (default bottom-center)`,
  },
  bold: { type: "boolean" as const, describe: "bold (helps small subtitles stay readable)" },
  "margin-bottom": { type: "number" as const, describe: "distance from the bottom edge in px" },
  lang: { type: "string" as const, describe: "language tag stored on the clip (soft subtitles: ISO 639)" },
  offset: { type: "string" as const, describe: "shift every cue by ±t", time: true },
};

// ---------------------------------------------------------------------------
// フォント解決（`text add` と同じ方針。docs/04 §9）
// ---------------------------------------------------------------------------

let fontCache: FontEntry[] | null = null;

/** テスト用: フォント列挙のキャッシュを差し替える */
export function __setSubtitleFontCache(fonts: FontEntry[] | null): void {
  fontCache = fonts;
}

async function resolveFontFamily(
  ctx: CommandContext,
  project: Project,
  requested: string | undefined,
): Promise<string | undefined> {
  if (fontCache === null) fontCache = (await listFonts({ env: ctx.env })).fonts;
  const fonts = fontCache;
  if (requested !== undefined) {
    // フォントが 1 つも列挙できない環境では検証を諦め、指定をそのまま使う
    if (fonts.length > 0 && !findFontEntry(fonts, requested)) {
      const candidates = suggestFamilies(fonts, requested);
      throw new MontashError("E_FONT_NOT_FOUND", `font family "${requested}" was not found on this system`, {
        hint:
          candidates.length > 0
            ? `Did you mean: ${candidates.join(", ")}? Use \`montash fonts list --filter <str>\` to search.`
            : "Use `montash fonts list` to see the installed families.",
        detail: { font: requested, candidates },
      });
    }
    return requested;
  }
  const preferred = project.settings.default_font;
  if (fonts.length === 0) return preferred;
  if (preferred && findFontEntry(fonts, preferred)) return preferred;
  return pickCjkFallback(fonts)?.family ?? preferred;
}

// ---------------------------------------------------------------------------
// 値のパース
// ---------------------------------------------------------------------------

/** `--offset +1.5` / `--offset -f:30` / `--offset 2` をフレームに落とす */
function parseOffsetFrames(raw: string, fps: { num: number; den: number }, warnings: Warning[]): number {
  const parsed = parseTimeInput(raw, fps, { allowRelative: true, allowEnd: false });
  if (parsed.warning) warnings.push(parsed.warning);
  const v = parsed.value;
  if (v.kind === "relative") return v.deltaFrames;
  if (v.kind === "absolute") return v.frames;
  throw errors.usage(`--offset does not accept ${JSON.stringify(raw)}`, "Use ±t (+1.5, -f:30) or an absolute time.");
}

/** 縁取り・影の色を省いたときの既定（ASS 生成側の既定と同じ） */
const DEFAULT_EDGE_COLOR = "#000000";

/**
 * `--outline 3`（px だけ）/ `--outline 3,#000000`（`text add` と同じ書式）/ `--outline none`。
 * px だけのときは既存の色を残す（`--outline-color` で指定済みなら、それを保つ）。
 */
function parseOutlineValue(raw: string, current: SubtitleStyle["outline"]): SubtitleStyle["outline"] {
  const text = raw.trim();
  if (text === "" || text.toLowerCase() === "none") return null;
  if (!text.includes(",")) {
    const width = Number(text);
    if (!Number.isFinite(width) || width < 0)
      throw errors.usage(`invalid --outline "${raw}"`, 'Use a width in px ("3"), "px,#RRGGBB[AA]" or "none".');
    return { width, color: current?.color ?? DEFAULT_EDGE_COLOR };
  }
  return parseOutline(text);
}

/** `--shadow 3`（深さだけ = x と y が同じ）/ `--shadow 2,2,#000000AA` / `--shadow none` */
function parseShadowValue(raw: string, current: SubtitleStyle["shadow"]): SubtitleStyle["shadow"] {
  const text = raw.trim();
  if (text === "" || text.toLowerCase() === "none") return null;
  if (!text.includes(",")) {
    const depth = Number(text);
    if (!Number.isFinite(depth) || depth < 0)
      throw errors.usage(`invalid --shadow "${raw}"`, 'Use a depth in px ("3"), "x,y,#RRGGBB[AA]" or "none".');
    return { x: depth, y: depth, color: current?.color ?? DEFAULT_EDGE_COLOR };
  }
  return parseShadow(text);
}

/** プリセット土台なしでスタイルを組み立てる（`base` は `subtitle set` のときの現在値） */
function buildStyle(args: Args, base: SubtitleStyle): SubtitleStyle {
  const style: SubtitleStyle = { ...base };
  if (has(args, "font")) style.font = String(option(args, "font"));
  if (has(args, "size")) {
    const size = Number(option(args, "size"));
    if (!Number.isFinite(size) || size <= 0) throw errors.usage("--size must be a positive number of px");
    style.size = size;
  }
  if (has(args, "color")) {
    const color = String(option(args, "color"));
    assColor(color);
    style.color = color;
  }
  if (has(args, "outline")) style.outline = parseOutlineValue(String(option(args, "outline")), style.outline);
  if (has(args, "outline-color")) {
    const color = String(option(args, "outline-color"));
    assColor(color);
    if (!style.outline || style.outline.width <= 0)
      throw errors.usage(
        "--outline-color needs an outline width",
        'Pass --outline too (e.g. --outline 3 --outline-color "#000000").',
      );
    style.outline = { ...style.outline, color };
  }
  if (has(args, "bg")) {
    const bg = String(option(args, "bg")).trim();
    if (bg === "" || bg.toLowerCase() === "none") style.bg = null;
    else {
      assColor(bg);
      style.bg = bg;
    }
  }
  if (has(args, "bg-padding")) {
    const padding = Number(option(args, "bg-padding"));
    if (!Number.isFinite(padding) || padding < 0) throw errors.usage("--bg-padding must be >= 0");
    style.bg_padding = padding;
  }
  if (has(args, "shadow")) style.shadow = parseShadowValue(String(option(args, "shadow")), style.shadow);
  if (has(args, "position")) style.position = parsePosition(String(option(args, "position")));
  if (has(args, "bold")) style.bold = Boolean(option(args, "bold"));
  if (has(args, "margin-bottom")) {
    const margin = Number(option(args, "margin-bottom"));
    if (!Number.isFinite(margin) || margin < 0) throw errors.usage("--margin-bottom must be >= 0");
    style.margin_bottom = margin;
  }
  return style;
}

// ---------------------------------------------------------------------------
// トラック・クリップの取得
// ---------------------------------------------------------------------------

/** テキストトラックを得る。名前指定が無く 1 つも無ければ T1 を自動作成する */
function textTrackFor(project: Project, name: unknown): { track: Track; created: boolean } {
  if (name !== undefined) {
    const track = requireTrack(project, String(name));
    if (track.kind !== "text")
      throw errors.usage(`track ${track.id} is a ${track.kind} track`, "Subtitles go on a text track (T1, T2 ...).");
    return { track, created: false };
  }
  const existing = project.tracks.find((t) => t.kind === "text");
  if (existing) return { track: existing, created: false };
  const id = nextTrackId(project, "text");
  const track = TrackSchema.parse({ id, kind: "text", name: id });
  project.tracks.push(track);
  return { track, created: true };
}

interface FoundClip {
  clip: SubtitleClip;
  track: Track;
  index: number;
}

function requireSubtitleClip(project: Project, id: string): FoundClip {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index < 0) continue;
    const clip = track.clips[index];
    if (clip && isSubtitleClip(clip)) return { clip, track, index };
    throw new MontashError("E_CLIP_NOT_FOUND", `clip "${id}" is not a subtitle clip`, {
      hint: "Use `montash subtitle list` to see the subtitle clips.",
      detail: { clip: id, track: track.id },
    });
  }
  const known = project.tracks.flatMap((t) => t.clips.filter(isSubtitleClip).map((c) => c.id));
  throw new MontashError("E_CLIP_NOT_FOUND", `subtitle clip "${id}" not found`, {
    hint: `Use \`montash subtitle list\` to see the subtitle clips (${known.join(", ") || "none"}).`,
    detail: { clip: id, known_clips: known },
  });
}

/** 素材の形式（`format` が無ければ拡張子から） */
function formatOf(project: Project, assetId: string): string {
  const asset = project.assets[assetId];
  const declared = asset && "format" in asset ? (asset as { format?: string }).format : undefined;
  if (declared) return declared;
  const ext = (asset?.path ?? "").split(".").pop()?.toLowerCase();
  return ext === "ass" || ext === "ssa" ? "ass" : ext === "vtt" ? "vtt" : "srt";
}

function describe(project: Project, clip: SubtitleClip, track: string, fps: { num: number; den: number }) {
  return {
    ...clip,
    track,
    format: formatOf(project, clip.asset),
    offset: framesToSeconds(clip.offset_f, fps),
  };
}

/** `--asset` が字幕素材であることを確かめる */
function requireSubtitleAsset(project: Project, id: string) {
  const asset = requireAsset(project, id);
  if (asset.type !== "subtitle")
    throw new MontashError("E_ASSET_TYPE_MISMATCH", `asset "${id}" is a ${asset.type} asset, not subtitle`, {
      hint: "Import a .srt, .vtt or .ass file with `montash import`.",
      detail: { asset: id, type: asset.type },
    });
  return asset;
}

// ---------------------------------------------------------------------------
// subtitle add
// ---------------------------------------------------------------------------

export const subtitleAdd = defineCommand({
  path: "subtitle add",
  summary: "attach a subtitle file to the timeline (burned in or muxed as a soft track)",
  workflows: ["W-14"],
  mutates: true,
  options: {
    asset: { type: "string", describe: "subtitle asset ID (srt, vtt or ass)", required: true },
    mode: {
      type: "string",
      describe: "burn into the picture, or mux as a selectable track",
      choices: ["burn", "soft"] as const,
      default: "burn",
    },
    at: { type: "string", describe: "timeline position of the first cue (default 0)", time: true },
    track: { type: "string", describe: "text track (default: the first text track, else a new T1)" },
    ...STYLE_OPTIONS,
    id: { type: "string", describe: "explicit clip ID (default: the next s<N>)" },
  },
  examples: [
    { cmd: 'montash subtitle add --asset ja_srt --mode burn --font "Noto Sans CJK JP" --size 40 --margin-bottom 60' },
    { cmd: 'montash subtitle add --asset ja_srt --outline 3 --outline-color "#000000" --bold' },
    { cmd: 'montash subtitle add --asset ja_srt --bg "#000000B3" --bg-padding 10' },
    { cmd: "montash subtitle add --asset ja_srt --mode soft --lang ja" },
  ],
  async handler(ctx, args: Args) {
    return runMutation(ctx, async ({ project, dir, fps }) => {
      const warnings: Warning[] = [];
      const assetId = String(option(args, "asset"));
      const asset = requireSubtitleAsset(project, assetId);
      const { track, created } = textTrackFor(project, option(args, "track"));
      const mode = String(option(args, "mode") ?? "burn") as "burn" | "soft";

      let startF = 0;
      if (has(args, "at")) {
        const parsed = parseTimeInput(String(option(args, "at")), fps, { allowRelative: false, allowEnd: false });
        if (parsed.warning) warnings.push(parsed.warning);
        if (parsed.value.kind !== "absolute") throw errors.usage("--at needs an absolute time");
        startF = parsed.value.frames;
      }
      const offsetF = has(args, "offset") ? parseOffsetFrames(String(option(args, "offset")), fps, warnings) : 0;

      const style = buildStyle(args, {});
      // ASS 素材は素材自身のスタイルで焼くので、フォント指定は意味を持たない
      if (mode === "burn" && formatOf(project, assetId) !== "ass") {
        const font = await resolveFontFamily(ctx, project, style.font);
        if (font !== undefined) style.font = font;
      } else if (style.font !== undefined) {
        await resolveFontFamily(ctx, project, style.font);
      }

      if (track.locked) throw new MontashError("E_TRACK_LOCKED", `track ${track.id} is locked`);
      const explicitId = option(args, "id");
      if (explicitId !== undefined) assertIdAvailable(project, String(explicitId));
      const id =
        explicitId !== undefined
          ? String(explicitId)
          : ctx.globals.dryRun
            ? `s${(await readIds(dir))?.counters.s ?? 1}`
            : await nextId(dir, "s");

      const clip = SubtitleClipSchema.parse({
        id,
        type: "subtitle",
        asset: assetId,
        mode,
        start_f: startF,
        offset_f: offsetF,
        style,
        ...(has(args, "lang") ? { lang: String(option(args, "lang")) } : {}),
      });
      track.clips.push(clip);
      track.clips.sort((a, b) => a.start_f - b.start_f);

      // ASS 素材は素材自身の Style で焼くので、ここで指定したスタイルはどれも効かない
      if (mode === "burn" && formatOf(project, assetId) === "ass" && Object.keys(style).length > 0)
        warnings.push({
          code: "W_SUBTITLE_STYLE_IGNORED",
          message: `asset "${asset.id}" is an ASS file; its own styles win over the style options (docs/07 §7)`,
        });

      return {
        result: { clip: describe(project, clip, track.id, fps), track_created: created ? track.id : null },
        summary: `add ${mode} subtitle ${clip.id} from ${assetId} on ${track.id}`,
        affects: { clips: [clip.id], range_f: null },
        warnings,
        human: `${clip.id}  ${track.id}  ${mode}  ${assetId}  offset f:${offsetF}${created ? `\n  (created text track ${track.id})` : ""}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// subtitle set
// ---------------------------------------------------------------------------

export const subtitleSet = defineCommand({
  path: "subtitle set",
  summary: "change the mode, style, language or offset of a subtitle clip",
  workflows: ["W-14"],
  mutates: true,
  positionals: [{ name: "id", describe: "subtitle clip ID", required: true }],
  options: {
    asset: { type: "string", describe: "point at another subtitle asset" },
    mode: { type: "string", describe: "burn or soft", choices: ["burn", "soft"] as const },
    ...STYLE_OPTIONS,
  },
  examples: [
    { cmd: "montash subtitle set s1 --mode soft --lang ja" },
    { cmd: 'montash subtitle set s1 --bg "#000000B3" --position bottom-center --margin-bottom 80' },
  ],
  async handler(ctx, args: Args) {
    const id = String(args.id);
    return runMutation(ctx, async ({ project, fps }) => {
      const warnings: Warning[] = [];
      const { clip, track } = requireSubtitleClip(project, id);
      const before = JSON.stringify(clip);

      if (has(args, "asset")) {
        const assetId = String(option(args, "asset"));
        requireSubtitleAsset(project, assetId);
        clip.asset = assetId;
      }
      if (has(args, "mode")) clip.mode = String(option(args, "mode")) as "burn" | "soft";
      if (has(args, "lang")) clip.lang = String(option(args, "lang"));
      if (has(args, "offset")) clip.offset_f = parseOffsetFrames(String(option(args, "offset")), fps, warnings);

      const style = buildStyle(args, clip.style);
      if (has(args, "font")) {
        const font = await resolveFontFamily(ctx, project, style.font);
        if (font !== undefined) style.font = font;
      }
      clip.style = style;

      const changed = JSON.stringify(clip) !== before;
      return {
        result: { clip: describe(project, clip, track.id, fps) },
        changed,
        summary: `set subtitle ${clip.id}`,
        affects: { clips: [clip.id], range_f: null },
        warnings,
        human: `${clip.id}  ${track.id}  ${clip.mode}  ${clip.asset}  offset f:${clip.offset_f}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// subtitle remove / list
// ---------------------------------------------------------------------------

export const subtitleRemove = defineCommand({
  path: "subtitle remove",
  summary: "remove a subtitle clip",
  workflows: ["W-14"],
  mutates: true,
  positionals: [{ name: "id", describe: "subtitle clip ID", required: true }],
  examples: [{ cmd: "montash subtitle remove s1" }],
  handler(ctx, args: Args) {
    const id = String(args.id);
    return runMutation(ctx, ({ project, fps }) => {
      const { clip, track, index } = requireSubtitleClip(project, id);
      track.clips.splice(index, 1);
      return {
        result: { removed: describe(project, clip, track.id, fps) },
        summary: `remove subtitle ${clip.id} from ${track.id}`,
        affects: { clips: [clip.id], range_f: null },
        human: `removed ${clip.id} from ${track.id}`,
      };
    });
  },
});

export const subtitleList = defineCommand({
  path: "subtitle list",
  summary: "list subtitle clips",
  workflows: ["W-14"],
  options: { track: { type: "string", describe: "limit to one text track" } },
  examples: [{ cmd: "montash subtitle list --track T1" }],
  async handler(ctx, args: Args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const fps = project.settings.fps;
    const tracks = args.track ? [requireTrack(project, String(args.track))] : project.tracks;
    const clips = tracks
      .filter((t) => t.kind === "text")
      .flatMap((t) =>
        [...t.clips]
          .filter(isSubtitleClip)
          .sort((a, b) => a.start_f - b.start_f)
          .map((c) => describe(project, c, t.id, fps)),
      );
    return {
      result: { clips },
      head: await currentHead(dir),
      human:
        clips
          .map(
            (c) => `${c.track}  ${c.id}  ${c.mode}  ${c.format}  ${c.asset}  ${c.lang ?? "-"}  offset f:${c.offset_f}`,
          )
          .join("\n") || "no subtitle clips",
    };
  },
});
