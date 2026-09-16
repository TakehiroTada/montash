/**
 * テロップ本文の**実測**（docs/04 §9 `--fit-width --measure`）。
 *
 * 概算（`src/core/text-fit.ts`）は字種ごとの advance を足すだけなので、字面の広い書体・太いウェイト・
 * カーニングではずれる。正確に知りたいときは **libass に実際に描かせて測る**のがいちばん確実で、
 * ffmpeg 以外の依存も増えない（docs/14「やらないこと」）。
 *
 * やり方: 黒い 1 フレームに基準サイズ（`REFERENCE_SIZE`）で 1 行を描き、**8bit グレーの生フレーム**を
 * 一時ファイルへ書き出して、黒でない画素のある列の範囲を数える。`cropdetect` を使わないのは、
 * 出力先が stdout（`-progress pipe:1`）と競合せず、閾値・丸め・`skip` の癖に左右されないため。
 *
 * 測るのは**インク（実際に絵のある範囲）の幅**で、縁取り・影・背景ボックスは外す。縁取りの太さは
 * フォントサイズに比例しないので、`fitFontSize()` 側で別に差し引くほうが正しい。
 *
 * 返すのは `幅 ÷ 基準サイズ` = **em 幅**なので、そのまま `FitOptions.measure` に渡せる。
 * つまり I/O はここで済ませ、純関数には**値だけ**を渡す（montash の作法。docs/08）。
 */
import { mkdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { estimateLineEm } from "../core/text-fit.ts";
import { buildAssDocument, escapeFilterValue, type TextClipLike, writeAssFile } from "./ass.ts";
import type { Binaries } from "./locate.ts";
import { runFfmpeg } from "./run.ts";

/** 測るときのフォントサイズ（px）。大きいほど丸め誤差が相対的に小さくなる */
export const REFERENCE_SIZE = 100;
/** 描画キャンバスの周囲に取る余白（px）。端に接すると「切れた」と判定する */
const CANVAS_PAD = 120;
/** キャンバス幅の上限（px）。これを超える行は測らずに概算へ落とす */
const MAX_CANVAS_WIDTH = 16384;
/** はみ出したときにキャンバスを広げて測り直す回数 */
const MAX_ATTEMPTS = 3;
/** 「黒でない」とみなす輝度。リミテッドレンジの黒は 16 なので、その少し上に置く */
const INK_THRESHOLD = 24;

export interface MeasureStyle {
  font?: string;
  bold?: boolean;
  italic?: boolean;
  markup?: "plain" | "ass";
}

export interface MeasureTextOptions {
  bins: Binaries;
  /** ASS と生フレームを置く一時ディレクトリ（`.montash/tmp`） */
  tmpDir: string;
  /** `subtitles=fontsdir=` に渡すディレクトリ */
  fontsDir?: string;
  timeoutMs?: number;
}

/**
 * 8bit グレーの生フレームから、黒でない画素のある列の範囲を返す（純関数）。
 * 何も描かれていなければ null。
 */
export function inkBounds(frame: Uint8Array, width: number, height: number): { x1: number; x2: number } | null {
  let x1 = -1;
  let x2 = -1;
  for (let x = 0; x < width; x++) {
    let ink = false;
    for (let y = 0; y < height; y++) {
      if ((frame[y * width + x] as number) > INK_THRESHOLD) {
        ink = true;
        break;
      }
    }
    if (!ink) continue;
    if (x1 < 0) x1 = x;
    x2 = x;
  }
  return x1 < 0 ? null : { x1, x2 };
}

/** 測定用の ASS（基準サイズ・縁取り無し・折り返し無し・左上から余白分だけずらして描く）を組む */
function measurementAss(line: string, style: MeasureStyle, canvas: { width: number; height: number }): string {
  const clip: TextClipLike = {
    id: "fit",
    start_f: 0,
    duration_f: 25,
    text: line,
    ...(style.markup !== undefined ? { markup: style.markup } : {}),
    style: {
      ...(style.font !== undefined ? { font: style.font } : {}),
      size: REFERENCE_SIZE,
      color: "#FFFFFF",
      bg: null,
      outline: null,
      shadow: null,
      wrap: false,
      align: "left",
      position: { x: CANVAS_PAD, y: CANVAS_PAD },
      ...(style.bold !== undefined ? { bold: style.bold } : {}),
      ...(style.italic !== undefined ? { italic: style.italic } : {}),
    },
  };
  return buildAssDocument([clip], { resolution: canvas, fps: { num: 25, den: 1 } });
}

/** 1 行を 1 パスで描いて測る。描けなかった（真っ黒だった）ときは null */
async function measureOnce(
  line: string,
  style: MeasureStyle,
  canvas: { width: number; height: number },
  opts: MeasureTextOptions,
): Promise<{ em: number; clipped: boolean } | null> {
  const assPath = await writeAssFile(measurementAss(line, style, canvas), opts.tmpDir);
  const rawPath = join(opts.tmpDir, `${basename(assPath, ".ass")}.gray`);
  const filter = [
    `subtitles=filename=${escapeFilterValue(assPath)}`,
    ...(opts.fontsDir !== undefined ? [`fontsdir=${escapeFilterValue(opts.fontsDir)}`] : []),
    `original_size=${canvas.width}x${canvas.height}`,
  ].join(":");
  const args = [
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${canvas.width}x${canvas.height}:r=25:d=1`,
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    "-y",
    rawPath,
  ];
  try {
    await runFfmpeg(opts.bins, args, { timeoutMs: opts.timeoutMs ?? 60_000 });
    const frame = new Uint8Array(await Bun.file(rawPath).arrayBuffer());
    if (frame.length < canvas.width * canvas.height) return null;
    const box = inkBounds(frame, canvas.width, canvas.height);
    if (!box) return null;
    const clipped = box.x1 < CANVAS_PAD / 2 || box.x2 > canvas.width - CANVAS_PAD / 2;
    return { em: (box.x2 - box.x1 + 1) / REFERENCE_SIZE, clipped };
  } finally {
    await unlink(rawPath).catch(() => {});
  }
}

/**
 * 本文の各行の em 幅を libass で実測する。
 *
 * 測れなかった行（真っ黒だった・キャンバスに収まらなかった）は概算値で埋め、`exact` を false にする。
 * 呼び出し側はそれを見て警告を出せる（黙って概算に落ちない）。
 */
export async function measureLineEms(
  lines: readonly string[],
  style: MeasureStyle,
  opts: MeasureTextOptions,
): Promise<{ ems: number[]; exact: boolean }> {
  await mkdir(opts.tmpDir, { recursive: true });
  const ems: number[] = [];
  let exact = true;
  for (const line of lines) {
    const estimate = estimateLineEm(line);
    if (estimate <= 0) {
      ems.push(0);
      continue;
    }
    let width = Math.ceil(estimate * REFERENCE_SIZE * 1.4) + CANVAS_PAD * 2;
    let measured: { em: number; clipped: boolean } | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && width <= MAX_CANVAS_WIDTH; attempt++) {
      const canvas = {
        width: Math.ceil(width / 2) * 2,
        height: REFERENCE_SIZE * 2 + CANVAS_PAD * 2,
      };
      const got = await measureOnce(line, style, canvas, opts);
      if (got && !got.clipped) {
        measured = got;
        break;
      }
      width *= 2;
    }
    if (measured) ems.push(measured.em);
    else {
      ems.push(estimate);
      exact = false;
    }
  }
  return { ems, exact };
}
