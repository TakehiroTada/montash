/**
 * ASS 文書の生成（docs/07 §6, docs/12 ADR-10）。
 *
 * テキストトラックの全クリップから 1 つの ASS を組み立て、レンダー側が
 * `subtitles=filename=<ass>:fontsdir=<dir>:original_size=WxH` で 1 回だけ焼く。
 * このモジュールの中心は **純関数 `buildAssDocument()`**（ファイル I/O なし）で、
 * フォントの収集（`prepareFontsDir`）と一時ファイル書き出し（`writeAssFile`）だけが I/O を伴う。
 *
 * 設計の要点（docs/07 §6.2）:
 * - `PlayResX/Y` = プロジェクト解像度。px 座標が 1:1 になる
 * - 1 テキストクリップ = Style 1 つ（名前 = クリップ ID）+ Dialogue 1 行
 * - 色は `#RRGGBB[AA]` → `&HAABBGGRR`（ASS のアルファは 00 が不透明なので反転する）
 * - 時刻はセンチ秒。Start は floor、End は ceil（1 フレームはセンチ秒より長いので隣に漏れない）
 * - フォントは `fontsdir` に解決済みファイルを集めて渡し、fontconfig の有無に依存しない
 *
 * 既知の制約: ASS の Style には行間の指定が無い（`Spacing` は字間）ため、`style.line_spacing` は
 * `project.json` に保持するだけで ASS には反映しない。
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { MontashError } from "../cli/errors.ts";
import type { Fps, Project, Resolution, SubtitleClip, TextPosition, TextStyle } from "../core/schema.ts";
import { isSubtitleClip, isTextClip } from "../core/schema.ts";
import { framesToMillis } from "../core/time.ts";
import { resolveAssetPath } from "../core/validate.ts";
import { type FontEntry, listFonts } from "./fonts.ts";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** ASS 化するテキストクリップ。本文は解決済み（`asset` の読み出しは呼び出し側で行う） */
export interface TextClipLike {
  id: string;
  start_f: number;
  duration_f: number;
  /** 解決済みの本文 */
  text: string;
  markup?: "plain" | "ass";
  style?: TextStyle;
  fade?: { in_f: number; out_f: number };
  /** 重ね順（テキストトラックの並び。既定 0） */
  layer?: number;
  /** 縦マージン（px）の明示指定。字幕の `style.margin_bottom` に使う（既定は解像度の 5%） */
  marginV?: number;
}

export interface AssBuildOptions {
  resolution: Resolution;
  fps: Fps;
  /** `subtitles=fontsdir=` に渡すディレクトリ（ASS 本文には現れない。記録用） */
  fontsDir?: string;
  /** 背景ボックスの描画方式。4 = 行ブロック（libass 拡張）、3 = 行ごと（古い libass 向けフォールバック） */
  borderStyle?: 3 | 4;
  /** `style.font` を持たないクリップに使うフォント（`settings.default_font`） */
  defaultFont?: string;
}

export type TextAlign = "left" | "center" | "right";

export interface Alignment {
  /** テンキー配置（7 8 9 / 4 5 6 / 1 2 3） */
  an: number;
  /** `\pos(x,y)`（プリセット center と座標指定のときだけ） */
  pos?: { x: number; y: number };
  margins: { l: number; r: number; v: number };
}

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

const STYLE_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, " +
  "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, " +
  "MarginL, MarginR, MarginV, Encoding";
const EVENT_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

export const DEFAULT_FONT_SIZE = 48;
export const DEFAULT_BG_PADDING = 16;
export const DEFAULT_TEXT_COLOR = "#FFFFFF";
/** プリセット位置の既定マージン（解像度に対する比率。W/H の 5%） */
export const EDGE_MARGIN_RATIO = 0.05;

/** `--position` のプリセット名 → `\an`（docs/04 §9） */
export const POSITION_PRESETS: Readonly<Record<string, number>> = Object.freeze({
  center: 5,
  "middle-center": 5,
  "middle-left": 4,
  "middle-right": 6,
  "top-left": 7,
  "top-center": 8,
  "top-right": 9,
  "bottom-left": 1,
  "bottom-center": 2,
  "bottom-right": 3,
});

// ---------------------------------------------------------------------------
// 小さなヘルパ（整数演算。float の途中結果に依存しない）
// ---------------------------------------------------------------------------

function divMod(a: number, b: number): { q: number; r: number } {
  let q = Math.floor(a / b);
  let r = a - q * b;
  while (r < 0) {
    q -= 1;
    r += b;
  }
  while (r >= b) {
    q += 1;
    r -= b;
  }
  return { q, r };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ASS の数値フィールド（小数は 2 桁まで） */
function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value * 100) / 100);
}

// ---------------------------------------------------------------------------
// 色
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;

function invalidColor(value: string): MontashError {
  return new MontashError("E_USAGE", `invalid color ${JSON.stringify(value)}`, {
    hint: 'Use "#RRGGBB" or "#RRGGBBAA" (AA: 00 = fully transparent, FF = opaque).',
    detail: { color: value },
  });
}

/** `#RRGGBB[AA]` → ASS の `&HAABBGGRR`。ASS のアルファは 00 が不透明なので `AA' = 255 - AA` */
export function assColor(hex: string): string {
  const m = HEX_COLOR.exec(String(hex).trim());
  if (!m?.[1]) throw invalidColor(String(hex));
  const rgb = m[1].toUpperCase();
  const a = m[2] === undefined ? 255 : Number.parseInt(m[2], 16);
  const inverted = (255 - a).toString(16).toUpperCase().padStart(2, "0");
  return `&H${inverted}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

/** `style.alpha`（0..1）を色のアルファに掛けた `#RRGGBBAA` を返す */
export function scaleColorAlpha(hex: string, alpha: number): string {
  const m = HEX_COLOR.exec(String(hex).trim());
  if (!m?.[1]) throw invalidColor(String(hex));
  const base = m[2] === undefined ? 255 : Number.parseInt(m[2], 16);
  const factor = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  const scaled = Math.round(base * factor);
  return `#${m[1].toUpperCase()}${scaled.toString(16).toUpperCase().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// エスケープ
// ---------------------------------------------------------------------------

/**
 * 本文を Dialogue の Text フィールドに入れられる形にする。
 * `markup: "plain"` は `{` `}` `\` をエスケープし、改行を `\N`、行頭の空白を `\h` にする。
 * `markup: "ass"` は本文をそのまま通す（AI が `{\b1}強調{\b0}` を書ける）。
 * ただし改行は Dialogue 1 行に収めるため、どちらのモードでも `\N` に変換する。
 */
export function assEscape(text: string, markup: "plain" | "ass"): string {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const converted = lines.map((line) => {
    if (markup === "ass") return line;
    const escaped = line.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
    // 行頭の空白は libass に落とされるので `\h`（ノーブレークスペース）にする
    return escaped.replace(/^[ \t]+/, (run) => "\\h".repeat(run.length));
  });
  return converted.join("\\N");
}

// ---------------------------------------------------------------------------
// 時刻
// ---------------------------------------------------------------------------

/**
 * フレーム → ASS の `H:MM:SS.CC`（センチ秒）。
 * `start` は floor、`end` は ceil（docs/07 §6.2）。
 * 1 フレーム（60fps でも 16.7ms）はセンチ秒より長いので、この丸めで隣接フレームに漏れることはない。
 */
export function assTime(frames: number, fps: Fps, mode: "start" | "end"): string {
  if (!Number.isSafeInteger(frames) || frames < 0) {
    throw new MontashError("E_INVALID_TIME", `frames must be a non-negative integer (got ${String(frames)})`);
  }
  const { q, r } = divMod(frames * fps.den * 100, fps.num);
  const cs = mode === "end" && r > 0 ? q + 1 : q;
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs % 100)}`;
}

// ---------------------------------------------------------------------------
// 位置・配置
// ---------------------------------------------------------------------------

/** px 整数 または "50%" を px に解決する */
export function resolveCoordinate(value: number | string, extent: number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidPosition(String(value));
    return Math.round(value);
  }
  const text = String(value).trim();
  const pct = /^(-?\d+(?:\.\d+)?)%$/.exec(text);
  if (pct?.[1]) return Math.round((Number(pct[1]) / 100) * extent);
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text));
  throw invalidPosition(text);
}

function invalidPosition(value: string): MontashError {
  return new MontashError("E_USAGE", `invalid position ${JSON.stringify(value)}`, {
    hint: `Use a preset (${Object.keys(POSITION_PRESETS).join(", ")}), "x,y" in px, or "x%,y%".`,
    detail: { position: value },
  });
}

/** 位置指定から既定の揃え（`style.align` が無いとき）を決める。座標指定は左上基準なので left */
export function defaultAlignFor(position: TextPosition | undefined): TextAlign {
  if (position === undefined || position === null) return "center";
  if (typeof position !== "string") return "left";
  const name = position.toLowerCase();
  if (name.endsWith("-left")) return "left";
  if (name.endsWith("-right")) return "right";
  return "center";
}

/**
 * 位置指定と揃えから `\an`・`\pos`・`Margin*` を決める。
 *
 * - プリセット → 行（上・中・下）はプリセット、列（左・中・右）は `align` が決める
 * - `center` は `\an5` + `\pos(W/2, H/2)`
 * - `{x,y}` → 上基準（`\an7/8/9`）+ `\pos(x,y)`。`%` は W/H から px に解決する
 */
export function alignmentOf(position: TextPosition | undefined, align: TextAlign, res: Resolution): Alignment {
  const column = align === "left" ? 1 : align === "right" ? 3 : 2;
  const marginH = Math.round(res.width * EDGE_MARGIN_RATIO);
  const marginV = Math.round(res.height * EDGE_MARGIN_RATIO);

  if (position === undefined || position === null || typeof position === "string") {
    const name = String(position ?? "center").toLowerCase();
    const preset = POSITION_PRESETS[name];
    if (preset === undefined) throw invalidPosition(String(position));
    // 行だけプリセットから取り、列は align で決める（docs/07 §6.2「align は \an の列で表現」）
    const rowBase = preset >= 7 ? 6 : preset >= 4 ? 3 : 0;
    const an = rowBase + column;
    const middle = rowBase === 3;
    return {
      an,
      ...(middle && column === 2 ? { pos: { x: Math.round(res.width / 2), y: Math.round(res.height / 2) } } : {}),
      margins: { l: marginH, r: marginH, v: middle ? 0 : marginV },
    };
  }

  const x = resolveCoordinate(position.x, res.width);
  const y = resolveCoordinate(position.y, res.height);
  return { an: 6 + column, pos: { x, y }, margins: { l: 0, r: 0, v: 0 } };
}

// ---------------------------------------------------------------------------
// ASS 文書
// ---------------------------------------------------------------------------

interface StyleLine {
  style: string;
  event: string;
}

function renderClip(clip: TextClipLike, opts: AssBuildOptions, borderStyle: 3 | 4): StyleLine {
  const style: TextStyle = clip.style ?? {};
  const fps = opts.fps;
  const alpha = style.alpha ?? 1;
  const font = style.font ?? opts.defaultFont ?? "Sans";
  const size = style.size ?? DEFAULT_FONT_SIZE;
  const align: TextAlign = style.align ?? defaultAlignFor(style.position);
  const at = alignmentOf(style.position, align, opts.resolution);

  const primary = assColor(scaleColorAlpha(style.color ?? DEFAULT_TEXT_COLOR, alpha));
  // SecondaryColour はカラオケ用で未使用。ASS の慣例どおり不透明の赤を入れておく
  const secondary = "&H000000FF";
  const bg = typeof style.bg === "string" && style.bg.trim() !== "" ? style.bg : null;
  let border: number;
  let outlineWidth: number;
  let shadowDepth: number;
  let outlineColour: string;
  let backColour: string;
  if (bg !== null) {
    // 背景ボックス: BorderStyle=4（行ブロック）/ 3（行ごと）。padding は Outline 値（docs/07 §6.2）。
    // libass の版によって箱の色が OutlineColour / BackColour のどちらかになるため両方に同じ色を入れる。
    // 箱と縁取りは同じ Outline 値を奪い合うので、bg があるときは outline/shadow を描かない。
    const box = assColor(scaleColorAlpha(bg, alpha));
    border = borderStyle;
    outlineWidth = style.bg_padding ?? DEFAULT_BG_PADDING;
    shadowDepth = 0;
    outlineColour = box;
    backColour = box;
  } else {
    border = 1;
    outlineWidth = style.outline?.width ?? 0;
    outlineColour = assColor(style.outline?.color ?? "#000000");
    backColour = assColor(style.shadow?.color ?? "#000000");
    // Style の Shadow は右下方向のオフセット 1 値。x/y が異なる場合は行内の \xshad/\yshad で表す
    shadowDepth = style.shadow && style.shadow.x === style.shadow.y ? Math.abs(style.shadow.x) : 0;
  }

  const styleLine = [
    `Style: ${clip.id}`,
    font,
    num(size),
    primary,
    secondary,
    outlineColour,
    backColour,
    style.bold ? "-1" : "0",
    style.italic ? "-1" : "0",
    "0",
    "0",
    "100",
    "100",
    "0",
    "0",
    String(border),
    num(outlineWidth),
    num(shadowDepth),
    String(at.an),
    String(Math.round(at.margins.l)),
    String(Math.round(at.margins.r)),
    String(Math.round(clip.marginV ?? at.margins.v)),
    "1",
  ].join(",");

  // 行内オーバーライド（順序は決定的に: pos → fad → q → xshad/yshad）
  const tags: string[] = [];
  if (at.pos) tags.push(`\\pos(${at.pos.x},${at.pos.y})`);
  const fadeIn = clip.fade?.in_f ?? 0;
  const fadeOut = clip.fade?.out_f ?? 0;
  if (fadeIn > 0 || fadeOut > 0) {
    tags.push(`\\fad(${framesToMillis(fadeIn, fps)},${framesToMillis(fadeOut, fps)})`);
  }
  // WrapStyle は文書全体の設定なので、クリップ単位の wrap:false は \q2 で表す
  if (style.wrap === false) tags.push("\\q2");
  if (bg === null && style.shadow && style.shadow.x !== style.shadow.y) {
    tags.push(`\\xshad(${num(style.shadow.x)})\\yshad(${num(style.shadow.y)})`);
  }
  const override = tags.length > 0 ? `{${tags.join("")}}` : "";
  const body = assEscape(clip.text ?? "", clip.markup ?? "plain");
  const event = [
    `Dialogue: ${clip.layer ?? 0}`,
    assTime(clip.start_f, fps, "start"),
    assTime(clip.start_f + clip.duration_f, fps, "end"),
    clip.id,
    "",
    "0",
    "0",
    "0",
    "",
    `${override}${body}`,
  ].join(",");

  return { style: styleLine, event };
}

/**
 * テキストクリップ列から ASS 全文を組み立てる（純関数）。
 * クリップ 1 つにつき Style 1 行（名前 = クリップ ID）と Dialogue 1 行を出す。
 */
export function buildAssDocument(clips: readonly TextClipLike[], opts: AssBuildOptions): string {
  const { width, height } = opts.resolution;
  const borderStyle = opts.borderStyle ?? 4;
  // WrapStyle は文書全体。全クリップが wrap:false のときだけ 2（折り返さない）にし、
  // 混在時は 0（スマート折り返し）にして個別クリップを \q2 で落とす
  const noWrap = clips.length > 0 && clips.every((c) => c.style?.wrap === false);
  const rendered = clips.map((clip) => renderClip(clip, opts, borderStyle));
  return [
    "[Script Info]",
    "; Generated by montash (docs/07 §6)",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    `WrapStyle: ${noWrap ? 2 : 0}`,
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    STYLE_FORMAT,
    ...rendered.map((r) => r.style),
    "",
    "[Events]",
    EVENT_FORMAT,
    ...rendered.map((r) => r.event),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// プロジェクトからテキストクリップを集める
// ---------------------------------------------------------------------------

export interface ProjectTextClip extends TextClipLike {
  /** 置かれているテキストトラック */
  track: string;
  /** `asset` 参照（本文の出所） */
  asset: string | null;
}

/**
 * テキストトラックのテキストクリップを集める（本文は未解決: `asset` があれば `text` は空のまま）。
 * `layer` はテキストトラックの並び順（後ろのトラックが上）。
 */
export function textClipsOf(project: Project): ProjectTextClip[] {
  const out: ProjectTextClip[] = [];
  let layer = 0;
  for (const track of project.tracks) {
    if (track.kind !== "text") continue;
    for (const clip of [...track.clips].sort((a, b) => a.start_f - b.start_f)) {
      if (!isTextClip(clip)) continue;
      out.push({
        id: clip.id,
        start_f: clip.start_f,
        duration_f: clip.duration_f,
        text: clip.text,
        markup: clip.markup,
        style: clip.style,
        fade: clip.fade,
        layer,
        track: track.id,
        asset: clip.asset,
      });
    }
    layer += 1;
  }
  return out;
}

/**
 * `textClipsOf()` の本文を解決する（`asset` があればテキスト素材を読み、`text` より優先する）。
 * 読めない素材は `E_ASSET_MISSING`。
 */
export async function resolveTextClips(project: Project, dir: string): Promise<ProjectTextClip[]> {
  const clips = textClipsOf(project);
  for (const clip of clips) {
    if (clip.asset === null) continue;
    const asset = project.assets[clip.asset];
    if (!asset) {
      throw new MontashError("E_ASSET_NOT_FOUND", `text clip "${clip.id}" references unknown asset "${clip.asset}"`);
    }
    const path = resolveAssetPath(dir, asset.path);
    try {
      clip.text = await Bun.file(path).text();
    } catch (cause) {
      throw new MontashError("E_ASSET_MISSING", `text asset "${asset.id}" could not be read (${path})`, {
        hint: "Use `montash assets relink` to point it at the file again.",
        detail: { asset: asset.id, path },
        cause,
      });
    }
  }
  return clips;
}

/** ASS に必要なフォントファミリーを集める（`fontsdir` の構築に使う） */
export function fontFamiliesOf(clips: readonly TextClipLike[], defaultFont?: string): string[] {
  const families = new Set<string>();
  for (const clip of clips) {
    const family = clip.style?.font ?? defaultFont;
    if (family !== undefined && family !== "") families.add(family);
  }
  if (defaultFont !== undefined && defaultFont !== "") families.add(defaultFont);
  return [...families].sort();
}

// ---------------------------------------------------------------------------
// フォント（fontsdir）
// ---------------------------------------------------------------------------

/** CJK フォールバックとして優先的に採用するファミリー（docs/04 §9 の既定フォント順） */
export const CJK_FALLBACK_PREFERENCE = [
  "Noto Sans CJK JP",
  "Noto Sans JP",
  "Noto Serif CJK JP",
  "Hiragino Sans",
  "Hiragino Kaku Gothic ProN",
  "Yu Gothic",
  "YuGothic",
  "Meiryo",
  "Source Han Sans",
  "IPAGothic",
  "IPAexGothic",
  "TakaoGothic",
] as const;

/** ファミリー名の完全一致（大文字小文字を無視）。Regular 系のスタイルを先頭に並べる */
export function entriesForFamily(fonts: readonly FontEntry[], family: string): FontEntry[] {
  const needle = family.trim().toLowerCase();
  const hit = fonts.filter((f) => f.family.trim().toLowerCase() === needle);
  return hit.sort((a, b) => styleRank(a.style) - styleRank(b.style));
}

function styleRank(style: string): number {
  const s = style.toLowerCase();
  if (s === "regular" || s === "book" || s === "" || s === "normal") return 0;
  if (s.includes("bold") && s.includes("italic")) return 3;
  if (s.includes("bold")) return 1;
  if (s.includes("italic") || s.includes("oblique")) return 2;
  return 4;
}

/** ファミリー名から代表的な 1 ファイルを引く。無ければ null */
export function findFontEntry(fonts: readonly FontEntry[], family: string): FontEntry | null {
  return entriesForFamily(fonts, family)[0] ?? null;
}

/** 2 語間の編集距離（打ち間違いの候補出しに使う。長さの差が大きい場合は打ち切る） */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = row;
  }
  return prev[b.length] ?? max + 1;
}

/** 近いファミリー名の候補（E_FONT_NOT_FOUND の hint 用） */
export function suggestFamilies(fonts: readonly FontEntry[], family: string, limit = 5): string[] {
  const needle = family.trim().toLowerCase();
  const head = needle.split(/\s+/)[0] ?? needle;
  const tolerance = Math.max(2, Math.floor(needle.length / 4));
  const scored = new Map<string, number>();
  for (const f of fonts) {
    const name = f.family.toLowerCase();
    let score = 0;
    if (name.includes(needle)) score = 3;
    else if (needle.includes(name)) score = 2;
    else if (head !== "" && name.includes(head)) score = 1;
    // 打ち間違い（Helvetika → Helvetica）も拾う
    else if (editDistance(name, needle, tolerance) <= tolerance) score = 2;
    if (score > 0 && (scored.get(f.family) ?? 0) < score) scored.set(f.family, score);
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

/** CJK フォールバックに使うフォントを選ぶ（優先リスト → 任意の CJK フォント） */
export function pickCjkFallback(fonts: readonly FontEntry[]): FontEntry | null {
  for (const family of CJK_FALLBACK_PREFERENCE) {
    const exact = findFontEntry(fonts, family);
    if (exact) return exact;
    const partial = fonts.find((f) => f.family.toLowerCase().includes(family.toLowerCase()));
    if (partial) return partial;
  }
  return fonts.find((f) => f.cjk) ?? null;
}

export interface PrepareFontsOptions {
  /** 列挙済みのフォント（省略時は listFonts()） */
  fonts?: readonly FontEntry[];
  /** 1 ファミリーあたりコピーする最大ファイル数（ウェイト違いを含める） */
  maxFilesPerFamily?: number;
}

/**
 * 解決済みのフォントファイルを `<tmpDir>/fonts` に集めて、そのディレクトリを返す。
 * CJK フォールバックは要求が無くても必ず 1 つ入れる（日本語が豆腐になるのを防ぐ。docs/07 §6.2）。
 * シンボリックリンクを優先し、張れない環境（Windows 等）ではコピーする。
 */
export async function prepareFontsDir(
  families: readonly string[],
  tmpDir: string,
  opts: PrepareFontsOptions = {},
): Promise<string> {
  const dir = join(tmpDir, "fonts");
  await mkdir(dir, { recursive: true });
  const fonts = opts.fonts ?? (await listFonts()).fonts;
  const limit = opts.maxFilesPerFamily ?? 4;
  const chosen = new Map<string, FontEntry>();
  for (const family of families) {
    for (const entry of entriesForFamily(fonts, family).slice(0, limit)) chosen.set(entry.path, entry);
  }
  const cjk = pickCjkFallback(fonts);
  if (cjk) chosen.set(cjk.path, cjk);
  for (const entry of chosen.values()) {
    const target = join(dir, basename(entry.path));
    if (existsSync(target)) continue;
    try {
      await symlink(entry.path, target);
    } catch {
      try {
        await copyFile(entry.path, target);
      } catch {
        // 読めないフォントは黙って飛ばす（他のフォントで描画を続ける）
      }
    }
  }
  return dir;
}

// ---------------------------------------------------------------------------
// 書き出しとフィルタ引数
// ---------------------------------------------------------------------------

/** ASS を `.montash/tmp/<hash>.ass` に書いてパスを返す。内容が同じなら同じパスになる */
export async function writeAssFile(doc: string, tmpDir: string): Promise<string> {
  await mkdir(tmpDir, { recursive: true });
  const hash = new Bun.CryptoHasher("sha256").update(doc).digest("hex").slice(0, 16);
  const path = join(tmpDir, `${hash}.ass`);
  await Bun.write(path, doc);
  return path;
}

/** filtergraph の値に入れるパスのエスケープ（`'` で括る前提） */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

export interface SubtitlesFilterOptions {
  assPath: string;
  fontsDir?: string;
  /** プロジェクト解像度。プロキシ解像度でも同じ ASS を正しく縮尺させる */
  originalSize?: Resolution;
}

/** `subtitles=...` フィルタ文字列（レンダー結線側で使う。docs/07 §6） */
export function subtitlesFilter(opts: SubtitlesFilterOptions): string {
  const parts = [`filename='${escapeFilterValue(opts.assPath)}'`];
  if (opts.fontsDir !== undefined) parts.push(`fontsdir='${escapeFilterValue(opts.fontsDir)}'`);
  if (opts.originalSize) parts.push(`original_size=${opts.originalSize.width}x${opts.originalSize.height}`);
  return `subtitles=${parts.join(":")}`;
}

// ---------------------------------------------------------------------------
// 字幕素材（SRT / VTT / ASS）— docs/07 §7
// ---------------------------------------------------------------------------

/** 字幕ファイル 1 件分の表示（ミリ秒）。SRT / WebVTT の共通表現 */
export interface SubtitleCue {
  startMs: number;
  endMs: number;
  /** 改行を含む本文（タグは除去済み） */
  text: string;
}

/** `HH:MM:SS,mmm` / `MM:SS.mmm`（VTT は時が省略できる） */
const CUE_TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const CUE_RANGE = new RegExp(`${CUE_TIME.source}\\s*-->\\s*${CUE_TIME.source}`);

function cueMillis(h: string | undefined, m: string, s: string, frac: string): number {
  const ms = Number(frac.padEnd(3, "0").slice(0, 3));
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + ms;
}

/**
 * SRT / WebVTT を解析して表示単位の一覧にする（純関数）。
 *
 * 番号行・`WEBVTT` ヘッダ・`NOTE` ブロック・キュー設定（`align:start` 等）は読み飛ばす。
 * `<i>` のようなインラインタグは落とす（ASS のスタイルは字幕クリップの `style` が決めるため）。
 */
export function parseSubtitleCues(source: string): SubtitleCue[] {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const cues: SubtitleCue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    if (/^WEBVTT/.test(lines[0] ?? "")) continue;
    const at = lines.findIndex((l) => CUE_RANGE.test(l));
    if (at < 0) continue;
    const m = CUE_RANGE.exec(lines[at] as string);
    if (!m) continue;
    const startMs = cueMillis(m[1], m[2] as string, m[3] as string, m[4] as string);
    const endMs = cueMillis(m[5], m[6] as string, m[7] as string, m[8] as string);
    const body = lines
      .slice(at + 1)
      .join("\n")
      .replace(/<[^>\n]*>/g, "")
      .trim();
    if (body === "") continue;
    cues.push({ startMs, endMs: Math.max(endMs, startMs), text: body });
  }
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** ミリ秒 → フレーム（四捨五入）。字幕の時刻はフレームに丸めてから ASS に落とす */
export function millisToFrames(ms: number, fps: Fps): number {
  return Math.round((ms * fps.num) / (fps.den * 1000));
}

export interface CueClipOptions {
  fps: Fps;
  /** Style 名のもとになる ID（`s1` → `s1_0`, `s1_1` ...） */
  idPrefix: string;
  /** タイムライン上のずらし（`start_f + offset_f`。フレーム） */
  offsetF: number;
  style?: TextStyle;
  marginV?: number;
  layer?: number;
}

/**
 * 字幕の表示単位をテキストクリップ列に変換する（純関数）。
 * これで SRT/VTT はテロップと同じ 1 つの ASS に Events として統合される（docs/07 §7）。
 */
export function cuesToTextClips(cues: readonly SubtitleCue[], opts: CueClipOptions): TextClipLike[] {
  const out: TextClipLike[] = [];
  cues.forEach((cue, i) => {
    const start = millisToFrames(cue.startMs, opts.fps) + opts.offsetF;
    const end = millisToFrames(cue.endMs, opts.fps) + opts.offsetF;
    const duration = Math.max(1, end - start);
    if (start + duration <= 0) return;
    out.push({
      id: `${opts.idPrefix}_${i}`,
      start_f: Math.max(0, start),
      // 先頭が切れる場合は残りだけを出す（区間レンダーでの clamp は呼び出し側が行う）
      duration_f: start < 0 ? duration + start : duration,
      text: cue.text,
      markup: "plain",
      ...(opts.style !== undefined ? { style: opts.style } : {}),
      ...(opts.marginV !== undefined ? { marginV: opts.marginV } : {}),
      ...(opts.layer !== undefined ? { layer: opts.layer } : {}),
    });
  });
  return out;
}

/**
 * ASS 素材の Dialogue / Comment 時刻を `offsetMs` だけずらした文書を返す（純関数）。
 * 素材のスタイルを尊重するため、本文には一切手を入れない（docs/07 §7）。
 * ずらした結果が負になる行は落とす。
 */
export function shiftAssDocument(doc: string, offsetMs: number): string {
  if (offsetMs === 0) return doc;
  const out: string[] = [];
  for (const line of doc.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^(Dialogue|Comment):\s*([^,]*),([^,]*),([^,]*),(.*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const start = parseAssTime(m[3] as string);
    const end = parseAssTime(m[4] as string);
    if (start === null || end === null) {
      out.push(line);
      continue;
    }
    const shiftedEnd = end + offsetMs;
    if (shiftedEnd <= 0) continue;
    out.push(
      `${m[1]}: ${(m[2] as string).trim()},${formatAssTime(Math.max(0, start + offsetMs))},${formatAssTime(shiftedEnd)},${m[5]}`,
    );
  }
  return out.join("\n");
}

/** `H:MM:SS.CC` → ミリ秒。解釈できなければ null */
export function parseAssTime(value: string): number | null {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,2})\s*$/.exec(value);
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number((m[4] as string).padEnd(2, "0")) * 10;
}

/** ミリ秒 → `H:MM:SS.CC`（センチ秒に切り捨て） */
export function formatAssTime(ms: number): string {
  const cs = Math.max(0, Math.floor(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${h}:${pad2(m)}:${pad2(s)}.${pad2(cs % 100)}`;
}

/** 字幕クリップを置かれている順に集める（テキストトラックのみ） */
export function subtitleClipsOf(project: Project): Array<{ clip: SubtitleClip; track: string; layer: number }> {
  const out: Array<{ clip: SubtitleClip; track: string; layer: number }> = [];
  let layer = 0;
  for (const track of project.tracks) {
    if (track.kind !== "text") continue;
    for (const clip of [...track.clips].sort((a, b) => a.start_f - b.start_f)) {
      if (isSubtitleClip(clip)) out.push({ clip, track: track.id, layer });
    }
    layer += 1;
  }
  return out;
}
