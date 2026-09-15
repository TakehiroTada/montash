/**
 * テキスト・字幕の焼き込み（docs/07 §6, §7、docs/12 ADR-10）。
 *
 * 映像合成の最後（overlay の後、出力 `format` の前）に差し込むフィルタ片を返す**純関数**。
 * ASS 文書の生成・書き出しとフォントの収集は I/O を伴うので `src/ffmpeg/text-prepare.ts` が行い、
 * その結果（`TextBurn`）を `GraphOptions.text` として受け取るだけにしてある。
 *
 * - `engine: "libass"`: `subtitles=filename=...:fontsdir=...:original_size=WxH` を 1〜n 回
 *   （生成 ASS が 1 つ、`mode: burn` の ASS 素材があればその数だけ後ろに続く）
 * - `engine: "drawtext"`: libass 無しビルドのフォールバック（docs/07 §6.3）。クリップごとに
 *   `drawtext=textfile=...:enable='between(n,S,E)'` を積む。折り返し・背景 padding・`markup: ass` は効かない
 *
 * 時刻はすべて**区間ローカル**（`opts.range` の先頭を 0 とする）で渡ってくる。シフトは text-prepare 側の責務。
 */
import type { Resolution, TextPosition } from "../../core/schema.ts";
import { escapeFilterValue, POSITION_PRESETS, resolveCoordinate, subtitlesFilter, type TextAlign } from "../ass.ts";
import type { GraphContext } from "./types.ts";

// ---------------------------------------------------------------------------
// 型（text-prepare が組み立て、buildGraph が受け取るデータ）
// ---------------------------------------------------------------------------

/** 焼く ASS 1 つ分（生成 ASS または `mode: burn` の ASS 素材） */
export interface AssLayer {
  /** 書き出し済みの ASS ファイル（絶対パス） */
  assPath: string;
  /** 解決済みフォントを集めたディレクトリ（fontconfig の有無に依存しないため） */
  fontsDir?: string;
}

/** drawtext フォールバック 1 件（本文とフォントはファイルに解決済み） */
export interface DrawtextSpec {
  /** 本文を UTF-8 で書いた一時ファイル */
  textFile: string;
  /** 解決できたフォントファイル（無ければ fontconfig の `font=` に頼る） */
  fontFile?: string;
  fontFamily?: string;
  /** プロジェクト解像度基準の px */
  size: number;
  color: string;
  bg?: string | null;
  bgPadding?: number;
  position?: TextPosition;
  align?: TextAlign;
  /** 区間ローカルのフレーム（`[startF, endF)`） */
  startF: number;
  endF: number;
  fadeInF?: number;
  fadeOutF?: number;
}

export interface TextBurn {
  engine: "libass" | "drawtext";
  /** libass のときに焼く ASS（前から順に重ねる） */
  layers?: AssLayer[];
  /** drawtext のときに描くテキスト */
  draws?: DrawtextSpec[];
  /** ASS の PlayRes（= プロジェクト解像度）。出力解像度が違っても libass が正しく縮尺する */
  originalSize: Resolution;
}

// ---------------------------------------------------------------------------
// drawtext フォールバック（docs/07 §6.3）
// ---------------------------------------------------------------------------

const HEX = /^#?([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/;

/** `#RRGGBB[AA]` → drawtext の `0xRRGGBB@0.xx` */
export function drawtextColor(hex: string): string {
  const m = HEX.exec(hex.trim());
  if (!m?.[1]) return "white";
  const alpha = m[2] === undefined ? 1 : Number.parseInt(m[2], 16) / 255;
  return `0x${m[1].toUpperCase()}@${Math.round(alpha * 1000) / 1000}`;
}

/** drawtext のオプション値のエスケープ（`'` で括る前提。`:` と `\` と `'` を守る） */
function drawtextValue(value: string): string {
  return `'${escapeFilterValue(value)}'`;
}

/** 位置指定 → drawtext の `x` / `y` 式。`W/H` は出力サイズ、`tw/th` は描画テキストのサイズ */
export function drawtextPosition(
  position: TextPosition | undefined,
  align: TextAlign,
  res: Resolution,
  marginH: number,
  marginV: number,
): { x: string; y: string } {
  if (position === undefined || position === null || typeof position === "string") {
    const preset = POSITION_PRESETS[String(position ?? "center").toLowerCase()] ?? 5;
    const row = preset >= 7 ? "top" : preset >= 4 ? "middle" : "bottom";
    const x = align === "left" ? `${marginH}` : align === "right" ? `w-tw-${marginH}` : "(w-tw)/2";
    const y = row === "top" ? `${marginV}` : row === "middle" ? "(h-th)/2" : `h-th-${marginV}`;
    return { x, y };
  }
  const px = resolveCoordinate(position.x, res.width);
  const py = resolveCoordinate(position.y, res.height);
  const x = align === "left" ? `${px}` : align === "right" ? `${px}-tw` : `${px}-tw/2`;
  return { x, y: `${py}` };
}

/**
 * フェードを `alpha` 式にする。`enable` で表示区間は絞ってあるので、区間内の形だけを書く。
 * n は drawtext に入ってくるフレーム番号（区間の先頭が 0）。
 */
function alphaExpr(spec: DrawtextSpec, base: number): string {
  const inF = spec.fadeInF ?? 0;
  const outF = spec.fadeOutF ?? 0;
  if (inF <= 0 && outF <= 0) return "";
  const s = spec.startF;
  const e = spec.endF;
  const a = Math.round(base * 1000) / 1000;
  let expr = `${a}`;
  if (outF > 0) expr = `if(gt(n\\,${e - outF})\\,${a}*(${e}-n)/${outF}\\,${expr})`;
  if (inF > 0) expr = `if(lt(n\\,${s + inF})\\,${a}*(n-${s})/${inF}\\,${expr})`;
  return expr;
}

function drawtextFilter(spec: DrawtextSpec, ctx: GraphContext): string {
  // プロジェクト解像度基準の px を出力解像度へ合わせる（ASS の original_size と同じ考え方）
  const scale = ctx.res.height / ctx.project.settings.resolution.height;
  const size = Math.max(1, Math.round(spec.size * scale));
  const marginH = Math.round(ctx.res.width * 0.05);
  const marginV = Math.round(ctx.res.height * 0.05);
  const align: TextAlign = spec.align ?? "center";
  const { x, y } = drawtextPosition(spec.position, align, ctx.res, marginH, marginV);

  const m = HEX.exec((spec.color ?? "#FFFFFF").trim());
  const baseAlpha = m?.[2] === undefined ? 1 : Number.parseInt(m[2], 16) / 255;
  const alpha = alphaExpr(spec, baseAlpha);

  const opts = [`textfile=${drawtextValue(spec.textFile)}`];
  if (spec.fontFile !== undefined) opts.push(`fontfile=${drawtextValue(spec.fontFile)}`);
  else if (spec.fontFamily !== undefined) opts.push(`font=${drawtextValue(spec.fontFamily)}`);
  opts.push(`fontsize=${size}`, `fontcolor=${drawtextColor(spec.color ?? "#FFFFFF")}`);
  if (spec.bg !== undefined && spec.bg !== null && spec.bg !== "") {
    opts.push(
      "box=1",
      `boxcolor=${drawtextColor(spec.bg)}`,
      `boxborderw=${Math.round((spec.bgPadding ?? 16) * scale)}`,
    );
  }
  // ffmpeg 7 で入った text_align は使わない（フォールバック経路は古いビルドで動く必要がある）
  opts.push(`x=${x}`, `y=${y}`);
  if (alpha !== "") opts.push(`alpha='${alpha}'`);
  opts.push(`enable='between(n\\,${spec.startF}\\,${spec.endF - 1})'`);
  return `drawtext=${opts.join(":")}`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 映像チェーンの最後に差し込むテキストのフィルタ片を返す（純関数）。
 * テキストが無い（`opts.text` が未指定）なら空配列を返し、既存のグラフは 1 文字も変わらない。
 */
export function textFilters(ctx: GraphContext): string[] {
  const burn = ctx.opts.text;
  if (!burn) return [];
  if (burn.engine === "libass") {
    return (burn.layers ?? []).map((layer) =>
      subtitlesFilter({
        assPath: layer.assPath,
        ...(layer.fontsDir !== undefined ? { fontsDir: layer.fontsDir } : {}),
        originalSize: burn.originalSize,
      }),
    );
  }
  return (burn.draws ?? []).map((spec) => drawtextFilter(spec, ctx));
}
