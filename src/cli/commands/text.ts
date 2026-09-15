/**
 * テロップ（docs/04 §9: `text add|set|remove|list|presets`、W-06）。
 *
 * テキストクリップは `kind: text` トラックに置き、レンダー時に 1 つの ASS へまとめて
 * libass で焼く（docs/07 §6、`src/ffmpeg/ass.ts`）。ここでは `project.json` の内容だけを扱う。
 *
 * - 状態変更はすべて `runMutation()` を通す（op 記録・`-m`・`--dry-run`・validate）
 * - 位置・サイズ・色などのスタイルはプリセット（docs/05 §9）を土台に、明示オプションで上書きする
 * - `--font` 未指定なら `settings.default_font` → CJK 対応フォントの順に解決する（docs/04 §9）
 */
import { resolve } from "node:path";
import { assertIdAvailable, nextId, readIds } from "../../core/ids.ts";
import { loadProject } from "../../core/project.ts";
import {
  isTextClip,
  type Project,
  type TextClip,
  TextClipSchema,
  type TextPosition,
  type TextStyle,
  type Track,
  TrackSchema,
} from "../../core/schema.ts";
import { BUILTIN_TEXT_PRESETS, requireTextPreset, resolveTextPresets } from "../../core/text-presets.ts";
import { framesToSeconds } from "../../core/time.ts";
import { assertPlacement, nextTrackId, requireTrack, trackEnd } from "../../core/timeline.ts";
import { assColor, findFontEntry, POSITION_PRESETS, pickCjkFallback, suggestFamilies } from "../../ffmpeg/ass.ts";
import { type FontEntry, listFonts } from "../../ffmpeg/fonts.ts";
import type { CommandContext } from "../context.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning } from "../errors.ts";
import { currentHead, runMutation } from "../mutate.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";
import { requireAsset } from "./assets.ts";

type Args = Record<string, unknown>;

/** yargs は `--bg-padding` を `bgPadding` としても渡す */
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

const BODY_OPTIONS = {
  text: { type: "string" as const, describe: "text body (\\n for line breaks)" },
  "text-file": { type: "string" as const, describe: "read the body from a UTF-8 file" },
  asset: { type: "string" as const, describe: "text asset ID (the body is read at render time)" },
};

const STYLE_OPTIONS = {
  preset: {
    type: "string" as const,
    describe: `style preset (${Object.keys(BUILTIN_TEXT_PRESETS).join(", ")} or a project preset)`,
  },
  font: { type: "string" as const, describe: "font family (default: settings.default_font, then a CJK font)" },
  size: { type: "number" as const, describe: "font size in px (project resolution basis)" },
  color: { type: "string" as const, describe: "text color #RRGGBB[AA]" },
  bg: { type: "string" as const, describe: "background box color #RRGGBB[AA], or none" },
  "bg-padding": { type: "number" as const, describe: "background box padding in px" },
  position: {
    type: "string" as const,
    describe: `position preset (${Object.keys(POSITION_PRESETS).join(", ")}), "x,y" or "x%,y%"`,
  },
  align: { type: "string" as const, describe: "line alignment", choices: ["left", "center", "right"] as const },
  "line-spacing": { type: "number" as const, describe: "extra line spacing in px" },
  wrap: { type: "boolean" as const, describe: "automatic line wrapping (--no-wrap to disable)" },
  "fade-in": { type: "string" as const, describe: "fade in duration", time: true },
  "fade-out": { type: "string" as const, describe: "fade out duration", time: true },
  shadow: { type: "string" as const, describe: 'drop shadow "x,y,#RRGGBB[AA]" (or none)' },
  outline: { type: "string" as const, describe: 'outline "px,#RRGGBB[AA]" (or none)' },
  bold: { type: "boolean" as const, describe: "bold" },
  italic: { type: "boolean" as const, describe: "italic" },
  markup: {
    type: "string" as const,
    describe: "plain escapes { } \\; ass passes override tags through",
    choices: ["plain", "ass"] as const,
  },
};

// ---------------------------------------------------------------------------
// 値のパース
// ---------------------------------------------------------------------------

/** `--position center` / `--position 960,540` / `--position 5%,85%` */
export function parsePosition(raw: string): TextPosition {
  const text = raw.trim();
  if (Object.hasOwn(POSITION_PRESETS, text.toLowerCase())) return text.toLowerCase();
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length === 2 && parts[0] !== "" && parts[1] !== "") {
    const coord = (v: string): number | string => {
      if (/^-?\d+(\.\d+)?%$/.test(v)) return v;
      if (/^-?\d+$/.test(v)) return Number(v);
      throw errors.usage(`invalid position coordinate "${v}"`, 'Use px integers ("960,540") or percents ("50%,85%").');
    };
    return { x: coord(parts[0] as string), y: coord(parts[1] as string) };
  }
  throw errors.usage(
    `invalid position "${raw}"`,
    `Use a preset (${Object.keys(POSITION_PRESETS).join(", ")}), "x,y" or "x%,y%".`,
  );
}

/** `--shadow 2,2,#000000AA` */
export function parseShadow(raw: string): { x: number; y: number; color: string } | null {
  const text = raw.trim();
  if (text === "" || text.toLowerCase() === "none") return null;
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length !== 3) throw errors.usage(`invalid --shadow "${raw}"`, 'Use "x,y,#RRGGBB[AA]" or "none".');
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw errors.usage(`invalid --shadow offset in "${raw}"`, 'Use "x,y,#RRGGBB[AA]".');
  assColor(parts[2] as string);
  return { x, y, color: parts[2] as string };
}

/** `--outline 2,#000000` */
export function parseOutline(raw: string): { width: number; color: string } | null {
  const text = raw.trim();
  if (text === "" || text.toLowerCase() === "none") return null;
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length !== 2) throw errors.usage(`invalid --outline "${raw}"`, 'Use "px,#RRGGBB[AA]" or "none".');
  const width = Number(parts[0]);
  if (!Number.isFinite(width) || width < 0)
    throw errors.usage(`invalid --outline width in "${raw}"`, 'Use "px,#RRGGBB[AA]".');
  assColor(parts[1] as string);
  return { width, color: parts[1] as string };
}

// ---------------------------------------------------------------------------
// フォント解決
// ---------------------------------------------------------------------------

/** 同一プロセス内でのフォント列挙のキャッシュ（`text add` を続けて呼んでも 1 回で済ませる） */
let fontCache: FontEntry[] | null = null;

async function systemFonts(ctx: CommandContext): Promise<FontEntry[]> {
  if (fontCache === null) fontCache = (await listFonts({ env: ctx.env })).fonts;
  return fontCache;
}

/** テスト用: フォント列挙のキャッシュを差し替える */
export function __setFontCache(fonts: FontEntry[] | null): void {
  fontCache = fonts;
}

/**
 * 使用するフォントファミリーを決める（docs/04 §9）。
 * `--font` 指定時は実在を確認し、無ければ `E_FONT_NOT_FOUND`（hint に近い候補）。
 * 未指定なら `settings.default_font` → CJK 対応フォントの順。
 */
async function resolveFontFamily(
  ctx: CommandContext,
  project: Project,
  requested: string | undefined,
): Promise<string | undefined> {
  const fonts = await systemFonts(ctx);
  if (requested !== undefined) {
    // フォントが 1 つも列挙できない環境（最小コンテナ等）では検証を諦め、指定をそのまま使う
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
// スタイルの組み立て
// ---------------------------------------------------------------------------

interface StyleResult {
  style: TextStyle;
  fade: { in_f: number; out_f: number };
}

function parseDurationFrames(raw: string, fps: { num: number; den: number }, warnings: Warning[]): number {
  const parsed = parseTimeInput(raw, fps, { allowRelative: false, allowEnd: false });
  if (parsed.warning) warnings.push(parsed.warning);
  return resolveAbsolute(parsed, { fps });
}

/**
 * プリセット（土台）と明示オプションからスタイルとフェードを組み立てる。
 * `base` は `text set` のときの現在値。
 */
function buildStyle(
  args: Args,
  project: Project,
  base: TextStyle,
  baseFade: { in_f: number; out_f: number },
  warnings: Warning[],
): StyleResult {
  const style: TextStyle = { ...base };
  let fade = { ...baseFade };

  const presetName = option(args, "preset");
  if (presetName !== undefined) {
    const preset = requireTextPreset(project, String(presetName));
    const { fade: presetFade, ...presetStyle } = preset;
    Object.assign(style, presetStyle);
    style.preset = String(presetName);
    if (presetFade) fade = { in_f: presetFade.in_f, out_f: presetFade.out_f };
  }

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
  if (has(args, "position")) style.position = parsePosition(String(option(args, "position")));
  if (has(args, "align")) style.align = String(option(args, "align")) as "left" | "center" | "right";
  if (has(args, "line-spacing")) style.line_spacing = Number(option(args, "line-spacing"));
  if (has(args, "wrap")) style.wrap = Boolean(option(args, "wrap"));
  if (has(args, "shadow")) style.shadow = parseShadow(String(option(args, "shadow")));
  if (has(args, "outline")) style.outline = parseOutline(String(option(args, "outline")));
  if (has(args, "bold")) style.bold = Boolean(option(args, "bold"));
  if (has(args, "italic")) style.italic = Boolean(option(args, "italic"));

  const fps = project.settings.fps;
  if (has(args, "fade-in")) fade.in_f = parseDurationFrames(String(option(args, "fade-in")), fps, warnings);
  if (has(args, "fade-out")) fade.out_f = parseDurationFrames(String(option(args, "fade-out")), fps, warnings);

  return { style, fade };
}

// ---------------------------------------------------------------------------
// 本文の解決
// ---------------------------------------------------------------------------

interface BodyResult {
  text?: string;
  asset?: string | null;
}

/** `--text` / `--text-file` / `--asset` は排他。`required` なら 1 つは必須 */
async function readBody(ctx: CommandContext, args: Args, project: Project, required: boolean): Promise<BodyResult> {
  const given = ["text", "text-file", "asset"].filter((name) => has(args, name));
  if (given.length > 1) throw errors.usage("use only one of --text, --text-file, --asset");
  if (given.length === 0) {
    if (required) throw errors.usage("provide --text, --text-file or --asset");
    return {};
  }
  if (has(args, "asset")) {
    const id = String(option(args, "asset"));
    const asset = requireAsset(project, id);
    if (asset.type !== "text")
      throw new MontashError("E_ASSET_TYPE_MISMATCH", `asset "${id}" is a ${asset.type} asset, not text`, {
        hint: "Create one with `montash assets new-text <id> --text ...`.",
        detail: { asset: id, type: asset.type },
      });
    return { asset: id };
  }
  if (has(args, "text")) return { text: unescapeNewlines(String(option(args, "text"))), asset: null };
  const path = resolve(ctx.cwd, String(option(args, "text-file")));
  try {
    const bytes = await Bun.file(path).arrayBuffer();
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), asset: null };
  } catch (cause) {
    throw new MontashError("E_ASSET_MISSING", `cannot read ${path}`, {
      hint: "Check the path passed to --text-file.",
      detail: { path },
      cause,
    });
  }
}

/** シェル経由で渡される `\n` をそのまま改行として受け取る（docs/04 §9「複数行は \n を受理」） */
function unescapeNewlines(text: string): string {
  return text.replace(/\\n/g, "\n");
}

// ---------------------------------------------------------------------------
// トラック・クリップの取得
// ---------------------------------------------------------------------------

/** テキストトラックを得る。名前指定が無く 1 つも無ければ T1 を自動作成する（docs/04 §9） */
function textTrackFor(project: Project, name: unknown): { track: Track; created: boolean } {
  if (name !== undefined) {
    const track = requireTrack(project, String(name));
    if (track.kind !== "text")
      throw errors.usage(`track ${track.id} is a ${track.kind} track`, "Text clips go on a text track (T1, T2 ...).");
    return { track, created: false };
  }
  const existing = project.tracks.find((t) => t.kind === "text");
  if (existing) return { track: existing, created: false };
  const track = TrackSchema.parse({
    id: nextTrackId(project, "text"),
    kind: "text",
    name: nextTrackId(project, "text"),
  });
  project.tracks.push(track);
  return { track, created: true };
}

interface FoundClip {
  clip: TextClip;
  track: Track;
  index: number;
}

function requireTextClip(project: Project, id: string): FoundClip {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === id);
    if (index < 0) continue;
    const clip = track.clips[index];
    if (clip && isTextClip(clip)) return { clip, track, index };
    throw new MontashError("E_CLIP_NOT_FOUND", `clip "${id}" is not a text clip`, {
      hint: "Use `montash text list` to see the text clips.",
      detail: { clip: id, track: track.id },
    });
  }
  const known = project.tracks.flatMap((t) => t.clips.filter(isTextClip).map((c) => c.id));
  throw new MontashError("E_CLIP_NOT_FOUND", `text clip "${id}" not found`, {
    hint: `Use \`montash text list\` to see the text clips (${known.join(", ") || "none"}).`,
    detail: { clip: id, known_clips: known },
  });
}

function describeTextClip(clip: TextClip, track: string, fps: { num: number; den: number }) {
  return {
    ...clip,
    track,
    end_f: clip.start_f + clip.duration_f,
    start: framesToSeconds(clip.start_f, fps),
    duration: framesToSeconds(clip.duration_f, fps),
    end: framesToSeconds(clip.start_f + clip.duration_f, fps),
  };
}

function preview(clip: TextClip): string {
  if (clip.asset !== null) return `@${clip.asset}`;
  const single = clip.text.replace(/\n/g, "\\n");
  return single.length > 40 ? `${single.slice(0, 39)}…` : single;
}

// ---------------------------------------------------------------------------
// text add
// ---------------------------------------------------------------------------

export const textAdd = defineCommand({
  path: "text add",
  summary: "add a text clip (telop) on a text track, creating T1 if needed",
  workflows: ["W-06"],
  mutates: true,
  options: {
    ...BODY_OPTIONS,
    at: { type: "string", describe: "timeline position (default: end of the track)", time: true },
    duration: { type: "string", describe: "how long the text stays on screen", time: true },
    until: { type: "string", describe: "end position instead of --duration", time: true },
    track: { type: "string", describe: "text track (default: the first text track, else a new T1)" },
    ...STYLE_OPTIONS,
    id: { type: "string", describe: "explicit clip ID (default: the next x<N>)" },
  },
  examples: [
    { cmd: 'montash text add --text "Summer Trip 2026" --at 0 --duration 3 --preset title-center' },
    { cmd: 'montash text add --text "福岡到着" --at 12 --duration 3 --preset lower-third --size 48' },
  ],
  async handler(ctx, args: Args) {
    if (has(args, "duration") && has(args, "until")) throw errors.usage("use either --duration or --until");
    return runMutation(ctx, async ({ project, dir, fps }) => {
      const warnings: Warning[] = [];
      const body = await readBody(ctx, args, project, true);
      const { track, created } = textTrackFor(project, option(args, "track"));

      // --at（既定はトラック末尾）
      const atRaw = String(option(args, "at") ?? "end");
      const atParsed = parseTimeInput(atRaw, fps, { allowRelative: false });
      if (atParsed.warning) warnings.push(atParsed.warning);
      const startF = resolveAbsolute(atParsed, { fps, end: trackEnd(track), current: trackEnd(track) });

      // --duration / --until
      let durationF: number;
      if (has(args, "until")) {
        const untilParsed = parseTimeInput(String(option(args, "until")), fps, { allowRelative: false });
        if (untilParsed.warning) warnings.push(untilParsed.warning);
        const untilF = resolveAbsolute(untilParsed, { fps, end: trackEnd(track), current: startF });
        durationF = untilF - startF;
      } else if (has(args, "duration")) {
        const parsed = parseTimeInput(String(option(args, "duration")), fps, {
          allowRelative: false,
          allowEnd: false,
          allowTimeline: false,
        });
        if (parsed.warning) warnings.push(parsed.warning);
        durationF = resolveAbsolute(parsed, { fps });
      } else {
        throw errors.usage("provide --duration or --until");
      }
      if (durationF <= 0)
        throw errors.usage(
          `the text would last ${durationF} frames`,
          "Use --duration <t> (> 0) or --until after --at.",
        );

      const { style, fade } = buildStyle(args, project, {}, { in_f: 0, out_f: 0 }, warnings);
      const font = await resolveFontFamily(ctx, project, style.font);
      if (font !== undefined) style.font = font;

      assertPlacement(track, startF, startF + durationF);
      const explicitId = option(args, "id");
      if (explicitId !== undefined) assertIdAvailable(project, String(explicitId));
      const id =
        explicitId !== undefined
          ? String(explicitId)
          : ctx.globals.dryRun
            ? `x${(await readIds(dir))?.counters.x ?? 1}`
            : await nextId(dir, "x");

      const clip = TextClipSchema.parse({
        id,
        type: "text",
        start_f: startF,
        duration_f: durationF,
        text: body.text ?? "",
        asset: body.asset ?? null,
        ...(has(args, "markup") ? { markup: String(option(args, "markup")) } : {}),
        style,
        fade,
      });
      track.clips.push(clip);
      track.clips.sort((a, b) => a.start_f - b.start_f);

      return {
        result: { clip: describeTextClip(clip, track.id, fps), track_created: created ? track.id : null },
        summary: `add text ${clip.id} on ${track.id} at f:${startF}`,
        affects: { clips: [clip.id], range_f: [startF, startF + durationF] as [number, number] },
        warnings,
        human: `${clip.id}  ${track.id}  f:${startF}..f:${startF + durationF}  ${preview(clip)}${created ? `\n  (created text track ${track.id})` : ""}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// text set
// ---------------------------------------------------------------------------

export const textSet = defineCommand({
  path: "text set",
  summary: "change the body, timing or style of a text clip",
  workflows: ["W-06"],
  mutates: true,
  positionals: [{ name: "id", describe: "text clip ID", required: true }],
  options: {
    ...BODY_OPTIONS,
    at: { type: "string", describe: "move to this timeline position", time: true },
    duration: { type: "string", describe: "new duration", time: true },
    until: { type: "string", describe: "new end position", time: true },
    ...STYLE_OPTIONS,
  },
  examples: [{ cmd: 'montash text set x1 --text "福岡に到着" --position 5%,85%' }],
  async handler(ctx, args: Args) {
    if (has(args, "duration") && has(args, "until")) throw errors.usage("use either --duration or --until");
    const id = String(args.id);
    return runMutation(ctx, async ({ project, fps }) => {
      const warnings: Warning[] = [];
      const { clip, track } = requireTextClip(project, id);
      const body = await readBody(ctx, args, project, false);
      const before = JSON.stringify(clip);

      if (body.text !== undefined) {
        clip.text = body.text;
        clip.asset = null;
      }
      if (body.asset !== undefined && body.asset !== null) clip.asset = body.asset;
      if (has(args, "markup")) clip.markup = String(option(args, "markup")) as "plain" | "ass";

      let startF = clip.start_f;
      let durationF = clip.duration_f;
      if (has(args, "at")) {
        const parsed = parseTimeInput(String(option(args, "at")), fps, { allowRelative: true });
        if (parsed.warning) warnings.push(parsed.warning);
        startF = resolveAbsolute(parsed, { fps, current: clip.start_f, end: trackEnd(track) });
      }
      if (has(args, "until")) {
        const parsed = parseTimeInput(String(option(args, "until")), fps, { allowRelative: false });
        if (parsed.warning) warnings.push(parsed.warning);
        durationF = resolveAbsolute(parsed, { fps, end: trackEnd(track), current: startF }) - startF;
      } else if (has(args, "duration")) {
        const parsed = parseTimeInput(String(option(args, "duration")), fps, {
          allowRelative: false,
          allowEnd: false,
        });
        if (parsed.warning) warnings.push(parsed.warning);
        durationF = resolveAbsolute(parsed, { fps });
      }
      if (durationF <= 0) throw errors.usage(`the text would last ${durationF} frames`, "Use --duration <t> (> 0).");

      const { style, fade } = buildStyle(args, project, clip.style, clip.fade, warnings);
      if (has(args, "font") || style.font === undefined) {
        const font = await resolveFontFamily(ctx, project, style.font);
        if (font !== undefined) style.font = font;
      }
      clip.style = style;
      clip.fade = fade;

      // 自分自身を除いた重なり判定
      const others = { ...track, clips: track.clips.filter((c) => c.id !== clip.id) };
      assertPlacement(others, startF, startF + durationF);
      clip.start_f = startF;
      clip.duration_f = durationF;
      track.clips.sort((a, b) => a.start_f - b.start_f);

      const changed = JSON.stringify(clip) !== before;
      return {
        result: { clip: describeTextClip(clip, track.id, fps) },
        changed,
        summary: `set text ${clip.id}`,
        affects: { clips: [clip.id], range_f: [startF, startF + durationF] as [number, number] },
        warnings,
        human: `${clip.id}  ${track.id}  f:${startF}..f:${startF + durationF}  ${preview(clip)}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// text remove
// ---------------------------------------------------------------------------

export const textRemove = defineCommand({
  path: "text remove",
  summary: "remove a text clip",
  workflows: ["W-06"],
  mutates: true,
  positionals: [{ name: "id", describe: "text clip ID", required: true }],
  examples: [{ cmd: "montash text remove x1" }],
  async handler(ctx, args: Args) {
    const id = String(args.id);
    return runMutation(ctx, ({ project, fps }) => {
      const { clip, track, index } = requireTextClip(project, id);
      track.clips.splice(index, 1);
      return {
        result: { removed: describeTextClip(clip, track.id, fps) },
        summary: `remove text ${clip.id} from ${track.id}`,
        affects: { clips: [clip.id], range_f: [clip.start_f, clip.start_f + clip.duration_f] as [number, number] },
        human: `removed ${clip.id} from ${track.id}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// text list / presets
// ---------------------------------------------------------------------------

export const textList = defineCommand({
  path: "text list",
  summary: "list text clips in timeline order",
  workflows: ["W-06"],
  options: { track: { type: "string", describe: "limit to one text track" } },
  examples: [{ cmd: "montash text list --track T1" }],
  async handler(ctx, args: Args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const fps = project.settings.fps;
    const tracks = args.track ? [requireTrack(project, String(args.track))] : project.tracks;
    const clips = tracks
      .filter((t) => t.kind === "text")
      .flatMap((t) =>
        [...t.clips]
          .filter(isTextClip)
          .sort((a, b) => a.start_f - b.start_f)
          .map((c) => describeTextClip(c, t.id, fps)),
      );
    return {
      result: { clips },
      head: await currentHead(dir),
      human:
        clips
          .map(
            (c) =>
              `${c.track}  ${c.id}  f:${c.start_f}..f:${c.end_f}  ${c.style.preset ?? "-"}  ${preview(c as TextClip)}`,
          )
          .join("\n") || "no text clips",
    };
  },
});

export const textPresets = defineCommand({
  path: "text presets",
  summary: "list the built-in and project text style presets",
  workflows: ["W-06"],
  examples: [{ cmd: "montash text presets", note: "preset names for `text add --preset`" }],
  async handler(ctx) {
    const project = await loadProject(ctx.requireProjectDir());
    const presets = resolveTextPresets(project);
    return {
      result: { presets },
      human: presets
        .map((p) => {
          const position =
            typeof p.preset.position === "string"
              ? p.preset.position
              : p.preset.position
                ? `${p.preset.position.x},${p.preset.position.y}`
                : "-";
          return `${p.name}  ${p.source}  size=${p.preset.size ?? "-"}  position=${position}  bg=${p.preset.bg ?? "none"}`;
        })
        .join("\n"),
    };
  },
});
