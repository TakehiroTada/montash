/**
 * テキスト・字幕の焼き込み準備（docs/07 §6, §7、docs/12 ADR-10）。
 *
 * フィルタグラフ（`graph/`）は純関数に保ちたいので、**I/O を伴う部分だけ**をここに集めた:
 *
 *   1. テキストクリップの本文解決（`asset` 参照の読み出し）と字幕素材（SRT/VTT/ASS）の読み込み
 *   2. 区間レンダー・プレビューのセグメント向けの時刻シフト（区間の先頭を 0 にする。§11.1）
 *   3. `buildAssDocument()` → `.montash/tmp/<hash>.ass` への書き出し、`fontsdir` の構築
 *   4. libass 無しビルド向けの drawtext フォールバック用の一時ファイル（本文・フォント解決）
 *
 * 結果（`TextBurn`）を `buildGraph(project, { text })` に渡すと、`graph/text.ts` が
 * 映像チェーンの最後にフィルタ片を差し込む。`mode: soft` の字幕は焼かずに出力段で多重化する。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Warning } from "../cli/errors.ts";
import { MontashError } from "../cli/errors.ts";
import { projectPaths } from "../core/project.ts";
import type { Project, Resolution, SubtitleClip, TextStyle } from "../core/schema.ts";
import { framesToMillis, framesToSecString } from "../core/time.ts";
import { resolveAssetPath } from "../core/validate.ts";
import {
  buildAssDocument,
  cuesToTextClips,
  findFontEntry,
  fontFamiliesOf,
  parseSubtitleCues,
  pickCjkFallback,
  prepareFontsDir,
  resolveTextClips,
  shiftAssDocument,
  subtitleClipsOf,
  type TextClipLike,
  writeAssFile,
} from "./ass.ts";
import { type FontEntry, listFonts } from "./fonts.ts";
import type { AssLayer, DrawtextSpec, TextBurn } from "./graph/text.ts";
import type { GraphRange, SoftSubtitle } from "./graph/types.ts";
import { type Binaries, type FfmpegInfo, inspectFfmpeg } from "./locate.ts";

// ---------------------------------------------------------------------------
// エンジンの判定
// ---------------------------------------------------------------------------

export type TextEngine = "libass" | "drawtext" | "none";

/** `inspectFfmpeg()` は ffmpeg を 3 回起動するので、同じバイナリの結果は使い回す */
const engineCache = new Map<string, Promise<FfmpegInfo>>();

export async function detectTextEngine(bins: Binaries): Promise<TextEngine> {
  let info = engineCache.get(bins.ffmpeg);
  if (!info) {
    info = inspectFfmpeg(bins);
    engineCache.set(bins.ffmpeg, info);
  }
  try {
    return (await info).textEngine;
  } catch {
    engineCache.delete(bins.ffmpeg);
    return "libass";
  }
}

/** テスト用: 検出結果のキャッシュを捨てる */
export function __clearEngineCache(): void {
  engineCache.clear();
}

/**
 * 実際に使うエンジンを決める（docs/07 §6.1）。
 * `settings.text_engine` はユーザーの希望で、ffmpeg が持っていない機能は選べない。
 */
export function effectiveEngine(setting: "libass" | "drawtext", detected: TextEngine): TextEngine {
  if (detected === "none") return "none";
  if (setting === "drawtext") return detected === "drawtext" || detected === "libass" ? "drawtext" : "none";
  return detected;
}

// ---------------------------------------------------------------------------
// 収集（テキストクリップ + burn 字幕）
// ---------------------------------------------------------------------------

/** 字幕クリップの `style`（`looseObject` なので `color` など追加キーも保持される） */
function subtitleStyle(clip: SubtitleClip, defaultFont: string | undefined): TextStyle {
  const raw = clip.style as Record<string, unknown>;
  const style: TextStyle = { position: "bottom-center", align: "center" };
  const font = typeof raw.font === "string" ? raw.font : defaultFont;
  if (font !== undefined && font !== "") style.font = font;
  if (typeof raw.size === "number") style.size = raw.size;
  if (typeof raw.color === "string") style.color = raw.color;
  if (typeof raw.outline === "object" && raw.outline !== null) style.outline = raw.outline as TextStyle["outline"];
  return style;
}

/** `mode: burn` の SRT/VTT を ASS の Events に統合するためのテキストクリップに変換する（docs/07 §7） */
async function burnCueClips(
  project: Project,
  dir: string,
  clip: SubtitleClip,
  layer: number,
  warnings: Warning[],
): Promise<TextClipLike[]> {
  const asset = project.assets[clip.asset];
  if (!asset) throw new MontashError("E_ASSET_NOT_FOUND", `subtitle clip "${clip.id}" references "${clip.asset}"`);
  const path = resolveAssetPath(dir, asset.path);
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (cause) {
    throw new MontashError("E_ASSET_MISSING", `subtitle asset "${asset.id}" could not be read (${path})`, {
      hint: "Use `montash assets relink` to point it at the file again.",
      detail: { asset: asset.id, path },
      cause,
    });
  }
  const cues = parseSubtitleCues(text);
  if (!cues.length) {
    warnings.push({
      code: "W_SUBTITLE_EMPTY",
      message: `subtitle asset "${asset.id}" has no cues; nothing is burned for ${clip.id}`,
    });
    return [];
  }
  const raw = clip.style as Record<string, unknown>;
  return cuesToTextClips(cues, {
    fps: project.settings.fps,
    idPrefix: clip.id,
    offsetF: clip.start_f + clip.offset_f,
    style: subtitleStyle(clip, project.settings.default_font),
    ...(typeof raw.margin_bottom === "number" ? { marginV: raw.margin_bottom } : {}),
    // 字幕はテロップより下のレイヤに置く（同時刻に重なったらテロップを上に）
    layer,
  });
}

/** 字幕素材の形式（`format` が無ければ拡張子で判定する） */
function subtitleFormat(project: Project, clip: SubtitleClip): string {
  const asset = project.assets[clip.asset];
  const declared = asset && "format" in asset ? (asset as { format?: string }).format : undefined;
  if (declared) return declared;
  const ext = (asset?.path ?? "").split(".").pop()?.toLowerCase();
  return ext === "ass" || ext === "ssa" ? "ass" : ext === "vtt" ? "vtt" : "srt";
}

// ---------------------------------------------------------------------------
// 区間シフト（docs/07 §11.1）
// ---------------------------------------------------------------------------

/**
 * クリップ列を区間 `[from, to)` へ落とし込む（純関数）。
 * 区間の先頭が 0 フレームになるよう時刻をずらし、はみ出す部分は切り詰める。
 */
export function shiftClipsToRange(clips: readonly TextClipLike[], range: GraphRange): TextClipLike[] {
  const length = range.to_f - range.from_f;
  const out: TextClipLike[] = [];
  for (const clip of clips) {
    const start = clip.start_f - range.from_f;
    const end = start + clip.duration_f;
    if (end <= 0 || start >= length) continue;
    const clamped = Math.max(0, start);
    out.push({ ...clip, start_f: clamped, duration_f: Math.min(end, length) - clamped });
  }
  return out;
}

// ---------------------------------------------------------------------------
// drawtext フォールバック用の一時ファイル
// ---------------------------------------------------------------------------

/** 本文を `.montash/tmp/<hash>.txt` に書く（drawtext は `textfile=` でしか安全に長文を渡せない） */
async function writeTextFile(body: string, tmpDir: string): Promise<string> {
  await mkdir(tmpDir, { recursive: true });
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
  const path = join(tmpDir, `${hash}.txt`);
  await Bun.write(path, body);
  return path;
}

async function drawtextSpecs(
  clips: readonly TextClipLike[],
  tmpDir: string,
  fonts: readonly FontEntry[],
  defaultFont: string | undefined,
): Promise<DrawtextSpec[]> {
  const out: DrawtextSpec[] = [];
  for (const clip of clips) {
    const style = clip.style ?? {};
    const family = style.font ?? defaultFont;
    const entry = family !== undefined ? findFontEntry(fonts, family) : null;
    const fallback = entry ?? pickCjkFallback(fonts);
    out.push({
      textFile: await writeTextFile(clip.text ?? "", tmpDir),
      ...(fallback ? { fontFile: fallback.path } : {}),
      ...(family !== undefined ? { fontFamily: family } : {}),
      size: style.size ?? 48,
      color: style.color ?? "#FFFFFF",
      ...(style.bg !== undefined ? { bg: style.bg } : {}),
      ...(style.bg_padding !== undefined ? { bgPadding: style.bg_padding } : {}),
      ...(style.position !== undefined ? { position: style.position } : {}),
      ...(style.align !== undefined ? { align: style.align } : {}),
      startF: clip.start_f,
      endF: clip.start_f + clip.duration_f,
      ...(clip.fade?.in_f ? { fadeInF: clip.fade.in_f } : {}),
      ...(clip.fade?.out_f ? { fadeOutF: clip.fade.out_f } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface PrepareTextOptions {
  /** 区間レンダー／プレビューのセグメント。渡すと ASS の時刻を区間の先頭基準にシフトする */
  range?: GraphRange;
  /** ffmpeg のテキストエンジン。省略時は `bins` から検出する */
  engine?: TextEngine;
  bins?: Binaries;
  /** 一時ファイルの置き場（既定 `.montash/tmp`） */
  tmpDir?: string;
  /** 列挙済みフォント（テスト用） */
  fonts?: readonly FontEntry[];
  /** ソフト字幕のコーデック（既定 `mov_text`。MKV なら `srt`） */
  softCodec?: string;
}

export interface PreparedText {
  /** `buildGraph(project, { text })` にそのまま渡す。焼くものが無ければ undefined */
  burn?: TextBurn;
  /** 出力段で多重化する字幕（`OutputSpec.subtitles`） */
  soft: SoftSubtitle[];
  /** 実際に使ったエンジン */
  engine: TextEngine;
  warnings: Warning[];
}

/** テキストトラックが 1 つも中身を持たないか（何もしない判定を安く済ませる） */
export function hasTextContent(project: Project): boolean {
  return project.tracks.some((t) => t.kind === "text" && !t.muted && t.clips.length > 0);
}

/**
 * プロジェクトからテキスト・字幕の焼き込み材料を用意する。
 *
 * libass が無い環境では `settings.text_engine` に従って drawtext へ落とし、
 * どちらも無ければ `W_TEXT_ENGINE_LIMITED` を出してテキストを飛ばす（レンダーは続ける）。
 */
export async function prepareText(project: Project, dir: string, opts: PrepareTextOptions = {}): Promise<PreparedText> {
  const warnings: Warning[] = [];
  const soft: SoftSubtitle[] = [];
  const fps = project.settings.fps;
  const originalSize: Resolution = project.settings.resolution;
  const tmpDir = opts.tmpDir ?? projectPaths(dir).tmpDir;

  if (!hasTextContent(project)) return { soft, engine: "libass", warnings };

  // --- soft 字幕は焼かずに多重化する（docs/07 §7） ---
  const muted = new Set(project.tracks.filter((t) => t.muted).map((t) => t.id));
  const subtitles = subtitleClipsOf(project).filter((s) => !muted.has(s.track));
  for (const { clip } of subtitles) {
    if (clip.mode !== "soft") continue;
    const asset = project.assets[clip.asset];
    if (!asset) throw new MontashError("E_ASSET_NOT_FOUND", `subtitle clip "${clip.id}" references "${clip.asset}"`);
    const shift = clip.start_f + clip.offset_f;
    soft.push({
      path: resolveAssetPath(dir, asset.path),
      codec: opts.softCodec ?? "mov_text",
      ...(clip.lang !== undefined ? { language: clip.lang } : {}),
      ...(shift !== 0 ? { offsetS: framesToSecString(shift, fps) } : {}),
      default: soft.length === 0,
    });
  }

  // --- 焼くテキスト（テロップ + burn の SRT/VTT） ---
  const textClips: TextClipLike[] = (await resolveTextClips(project, dir)).filter((c) => !muted.has(c.track));
  const assAssets: Array<{ clip: SubtitleClip; path: string }> = [];
  for (const { clip, layer } of subtitles) {
    if (clip.mode !== "burn") continue;
    if (subtitleFormat(project, clip) === "ass") {
      const asset = project.assets[clip.asset];
      if (asset) assAssets.push({ clip, path: resolveAssetPath(dir, asset.path) });
      continue;
    }
    textClips.push(...(await burnCueClips(project, dir, clip, layer, warnings)));
  }

  if (!textClips.length && !assAssets.length) return { soft, engine: "libass", warnings };

  // --- エンジンの決定 ---
  const detected = opts.engine ?? (opts.bins ? await detectTextEngine(opts.bins) : "libass");
  const engine = effectiveEngine(project.settings.text_engine, detected);
  if (engine === "none") {
    warnings.push({
      code: "W_TEXT_ENGINE_LIMITED",
      message: "this ffmpeg build has neither the subtitles (libass) nor the drawtext filter; text is not rendered",
      hint: "Install a full ffmpeg build (scripts/install-deps.sh) and render again.",
    });
    return { soft, engine, warnings };
  }

  // --- 区間シフト（区間の先頭を 0 フレームにする。docs/07 §11.1） ---
  const shifted = opts.range ? shiftClipsToRange(textClips, opts.range) : textClips;
  const offsetMs = opts.range ? -framesToMillis(opts.range.from_f, fps) : 0;

  if (engine === "drawtext") {
    warnings.push({
      code: "W_TEXT_ENGINE_LIMITED",
      message: "text is drawn with drawtext (this ffmpeg has no libass): no wrapping, box padding or ASS markup",
      hint: "Install a full ffmpeg build (scripts/install-deps.sh) for libass rendering.",
    });
    if (assAssets.length)
      warnings.push({
        code: "W_TEXT_ENGINE_LIMITED",
        message: `${assAssets.length} burned ASS subtitle asset(s) need libass and are skipped`,
      });
    const fonts = opts.fonts ?? (await listFonts()).fonts;
    const draws = await drawtextSpecs(shifted, tmpDir, fonts, project.settings.default_font);
    return {
      ...(draws.length ? { burn: { engine, draws, originalSize } } : {}),
      soft,
      engine,
      warnings,
    };
  }

  // --- libass: 生成 ASS を 1 つ、ASS 素材はスタイルを尊重して別の subtitles で焼く ---
  const layers: AssLayer[] = [];
  const families = fontFamiliesOf(shifted, project.settings.default_font);
  const fontsDir = await prepareFontsDir(families, tmpDir, opts.fonts ? { fonts: opts.fonts } : {});
  if (shifted.length) {
    const doc = buildAssDocument(shifted, {
      resolution: originalSize,
      fps,
      fontsDir,
      ...(project.settings.default_font ? { defaultFont: project.settings.default_font } : {}),
    });
    layers.push({ assPath: await writeAssFile(doc, tmpDir), fontsDir });
  }
  for (const { clip, path } of assAssets) {
    const shiftMs = framesToMillis(clip.start_f + clip.offset_f, fps) + offsetMs;
    const source = await Bun.file(path)
      .text()
      .catch((cause: unknown) => {
        throw new MontashError("E_ASSET_MISSING", `subtitle asset "${clip.asset}" could not be read (${path})`, {
          hint: "Use `montash assets relink` to point it at the file again.",
          detail: { asset: clip.asset, path },
          cause,
        });
      });
    const assPath = shiftMs === 0 ? path : await writeAssFile(shiftAssDocument(source, shiftMs), tmpDir);
    layers.push({ assPath, fontsDir });
  }

  return { ...(layers.length ? { burn: { engine, layers, originalSize } } : {}), soft, engine, warnings };
}
