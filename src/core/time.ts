/**
 * 時間モデル（docs/05 §2, docs/12 ADR-09）。
 *
 * - fps は有理数 `{ num, den }`（互いに素・正の整数）。1 フレーム = `den / num` 秒。
 * - タイムライン上の時間は「プロジェクト fps 基準の整数フレーム」、音声のサブフレーム補正は
 *   「プロジェクト sample_rate 基準の整数サンプル」。
 * - 秒への変換は表示・ffmpeg 境界でのみ行う。変換は整数演算（掛けてから割る）で行い、
 *   丸めは `roundDiv()` に集約する（float の途中結果を比較しない）。
 *
 * このモジュールは純関数のみ（I/O なし）。不正値は MontashError（E_INVALID_FPS / E_INVALID_TIME）を投げる。
 * フレーム数・サンプル数は safe integer（< 2^53）を前提とし、BigInt は使わない。
 */
import { MontashError } from "../cli/errors.ts";

export interface Fps {
  /** 分子（正の整数） */
  num: number;
  /** 分母（正の整数） */
  den: number;
}

/** fps プリセット（docs/05 §4）。キーは表示名 */
export const FPS_PRESETS: Record<string, Fps> = Object.freeze({
  "23.976": { num: 24000, den: 1001 },
  "24": { num: 24, den: 1 },
  "25": { num: 25, den: 1 },
  "29.97": { num: 30000, den: 1001 },
  "30": { num: 30, den: 1 },
  "50": { num: 50, den: 1 },
  "59.94": { num: 60000, den: 1001 },
  "60": { num: 60, den: 1 },
});

/**
 * 小数表記のエイリアス（互いに素に約分した有理数 → プリセット）。
 * "29.97" は文字通りには 2997/100 だが、業界慣習として 30000/1001 を意味する。
 */
const DECIMAL_ALIASES: ReadonlyArray<{ decimal: Fps; preset: Fps }> = [
  { decimal: { num: 2997, den: 100 }, preset: FPS_PRESETS["29.97"]! },
  { decimal: { num: 2997, den: 125 }, preset: FPS_PRESETS["23.976"]! }, // 23.976 = 23976/1000
  { decimal: { num: 2997, den: 50 }, preset: FPS_PRESETS["59.94"]! }, // 59.94 = 5994/100
];

const FPS_HINT = 'Accepted fps: presets 23.976 / 24 / 25 / 29.97 / 30 / 50 / 59.94 / 60, a decimal ("29.97"), or a rational "30000/1001".';

// ---------------------------------------------------------------------------
// 整数演算ヘルパ
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * `round(a / b)` を整数演算で求める（b > 0、a は整数）。
 * 0.5 は正の無限大方向へ丸める（Math.round と同じ規則）。
 * 商が safe integer の範囲内であれば float 誤差の影響を受けない。
 */
export function roundDiv(a: number, b: number): number {
  if (b <= 0) throw new MontashError("E_INVALID_TIME", `division by non-positive denominator ${b}`);
  let q = Math.floor(a / b);
  let r = a - q * b;
  // float 除算の丸めで floor が 1 ずれた場合の補正
  while (r < 0) {
    q -= 1;
    r += b;
  }
  while (r >= b) {
    q += 1;
    r -= b;
  }
  return 2 * r >= b ? q + 1 : q;
}

/** `a / b` を（整数部, 余り）に分ける。余りは常に 0 <= r < b */
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

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** フレーム数・サンプル数の引数（符号は問わない整数）を検証する */
function assertInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new MontashError("E_INVALID_TIME", `${what} must be a safe integer (got ${describe(v)})`);
  }
  return v;
}

function describe(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return Number.isNaN(v) ? "NaN" : String(v);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  return typeof v;
}

// ---------------------------------------------------------------------------
// fps
// ---------------------------------------------------------------------------

/** `{ num, den }` を検証し、互いに素に正規化する（project.json から読んだ値の検証にも使う） */
export function makeFps(num: unknown, den: unknown): Fps {
  if (!isPositiveInt(num) || !isPositiveInt(den)) {
    throw new MontashError("E_INVALID_FPS", `fps must be a ratio of positive integers (got ${describe(num)}/${describe(den)})`, { hint: FPS_HINT });
  }
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/**
 * fps の入力を解釈する。
 * - 数値 / 数値文字列: `30`, `"30"`, `29.97`, `"23.976"`, `"59.94"`（小数はプリセットのエイリアスを優先し、
 *   それ以外は小数を厳密な有理数として扱う: `"12.5"` → 25/2）
 * - 有理数文字列: `"30000/1001"`
 */
export function parseFps(input: string | number): Fps {
  const invalid = (why: string): MontashError =>
    new MontashError("E_INVALID_FPS", `invalid fps ${describe(input)}: ${why}`, { hint: FPS_HINT, detail: { input } });

  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) throw invalid("must be a positive finite number");
    text = String(input);
  } else if (typeof input === "string") {
    text = input.trim();
  } else {
    throw invalid("must be a number or string");
  }
  if (text === "") throw invalid("empty string");

  const preset = FPS_PRESETS[text];
  if (preset) return preset;

  // 有理数表記 "30000/1001"
  const ratio = /^(\d+)\s*\/\s*(\d+)$/.exec(text);
  if (ratio) {
    const num = Number(ratio[1]);
    const den = Number(ratio[2]);
    if (!isPositiveInt(num) || !isPositiveInt(den)) throw invalid("numerator and denominator must be positive integers");
    return matchAlias(makeFps(num, den));
  }

  // 小数表記 "29.970" / "12.5" / "24"
  const dec = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (dec) {
    const intPart = dec[1]!;
    const fracPart = (dec[2] ?? "").replace(/0+$/, "");
    if (fracPart.length > 9) throw invalid("too many decimal digits (max 9)");
    const scale = 10 ** fracPart.length;
    const num = Number(intPart) * scale + Number(fracPart || "0");
    if (!Number.isSafeInteger(num)) throw invalid("value is too large");
    if (num === 0) throw invalid("must be positive");
    return matchAlias(makeFps(num, scale));
  }

  throw invalid("unrecognized format");
}

/** 約分済みの有理数が小数エイリアス（29.97 など）に一致すれば対応するプリセットを返す */
function matchAlias(fps: Fps): Fps {
  for (const { decimal, preset } of DECIMAL_ALIASES) {
    if (fps.num === decimal.num && fps.den === decimal.den) return preset;
  }
  return fps;
}

export function fpsEquals(a: Fps, b: Fps): boolean {
  // 正規化されていない値同士でも比較できるよう交差乗算する
  return a.num * b.den === b.num * a.den;
}

/** 表示名。プリセットはその名前（"29.97"）、整数 fps はそのまま、その他は小数 3 桁 */
export function fpsLabel(fps: Fps): string {
  for (const [label, preset] of Object.entries(FPS_PRESETS)) {
    if (fpsEquals(fps, preset)) return label;
  }
  const { q, r } = divMod(fps.num, fps.den);
  if (r === 0) return String(q);
  const milli = roundDiv(fps.num * 1000, fps.den);
  const { q: whole, r: frac } = divMod(milli, 1000);
  return `${whole}.${String(frac).padStart(3, "0")}`;
}

/** 1 フレームの長さ（秒）。表示用 */
export function frameDurationSeconds(fps: Fps): number {
  return fps.den / fps.num;
}

// ---------------------------------------------------------------------------
// フレーム → 秒・文字列
// ---------------------------------------------------------------------------

/**
 * f フレームを（整数秒, 余りフレーム×den）に分ける。`f * den = sec * num + rem`（0 <= rem < num）。
 * 以降の桁計算を `rem`（< num）に対して行うことで、`f * den * 1e6` のような大きな中間値を避ける。
 */
function splitSeconds(f: number, fps: Fps): { sec: number; rem: number } {
  const { q, r } = divMod(f * fps.den, fps.num);
  return { sec: q, rem: r };
}

/** 秒（浮動小数）。表示専用: 編集判断には使わない */
export function framesToSeconds(f: number, fps: Fps): number {
  assertInt(f, "frames");
  return (f * fps.den) / fps.num;
}

/** ミリ秒（`round(f * den * 1000 / num)`） */
export function framesToMillis(f: number, fps: Fps): number {
  assertInt(f, "frames");
  return scaledUnits(f, fps, 1000);
}

/** `round(f * den * unit / num)` を桁溢れなく求める（unit: 1000 = ms, 1e6 = µs, sample_rate = サンプル） */
function scaledUnits(f: number, fps: Fps, unit: number): number {
  const sign = f < 0 ? -1 : 1;
  const { sec, rem } = splitSeconds(Math.abs(f), fps);
  return sign * (sec * unit + roundDiv(rem * unit, fps.num));
}

/** ffmpeg 用の秒文字列。小数 6 桁固定（マイクロ秒精度）: 375 @29.97 → "12.512500" */
export function framesToSecString(f: number, fps: Fps): string {
  assertInt(f, "frames");
  const micros = scaledUnits(f, fps, 1_000_000);
  const sign = micros < 0 ? "-" : "";
  const { q, r } = divMod(Math.abs(micros), 1_000_000);
  return `${sign}${q}.${String(r).padStart(6, "0")}`;
}

/** `HH:MM:SS.mmm`（ミリ秒丸め）。負値は先頭に "-" */
export function framesToTimecode(f: number, fps: Fps): string {
  assertInt(f, "frames");
  const millis = framesToMillis(f, fps);
  const sign = millis < 0 ? "-" : "";
  const abs = Math.abs(millis);
  const ms = abs % 1000;
  const totalSec = (abs - ms) / 1000;
  const s = totalSec % 60;
  const m = ((totalSec - s) / 60) % 60;
  const h = (totalSec - s - m * 60) / 3600;
  return `${sign}${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(ms).padStart(3, "0")}`;
}

/**
 * `HH:MM:SS:FF`（非ドロップフレーム）。FF は秒内のフレーム番号。
 * 分数 fps（29.97 等）では 1 秒あたり `round(num/den)` フレーム（= 30）として数える。
 * 非ドロップフレームなので 29.97 では実時間よりわずかに遅れる（表示用途のみ）。
 */
export function framesToFrameTimecode(f: number, fps: Fps): string {
  assertInt(f, "frames");
  const nominal = Math.max(1, roundDiv(fps.num, fps.den));
  const sign = f < 0 ? "-" : "";
  const abs = Math.abs(f);
  const ff = abs % nominal;
  const totalSec = (abs - ff) / nominal;
  const s = totalSec % 60;
  const m = ((totalSec - s) / 60) % 60;
  const h = (totalSec - s - m * 60) / 3600;
  const ffWidth = Math.max(2, String(nominal - 1).length);
  return `${sign}${pad2(h)}:${pad2(m)}:${pad2(s)}:${String(ff).padStart(ffWidth, "0")}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// 秒 → フレーム（入力の受理）
// ---------------------------------------------------------------------------

/** 丸め幅がこの値（秒）を超えたら snapped とみなす（1µs。ffmpeg の内部精度と同じ） */
export const SNAP_TOLERANCE_SECONDS = 1e-6;

/**
 * 秒（浮動小数）を最寄りフレームに丸める。`frames = round(s * num / den)`。
 * `exactSeconds` は採用したフレームの正確な秒、`snapped` は丸め幅が 1µs を超えたか。
 * 負の秒も受理する（相対指定の差分に使う）。
 */
export function secondsToFrames(s: number, fps: Fps): { frames: number; snapped: boolean; exactSeconds: number } {
  if (typeof s !== "number" || !Number.isFinite(s)) {
    throw new MontashError("E_INVALID_TIME", `seconds must be a finite number (got ${describe(s)})`);
  }
  const frames = Math.round((s * fps.num) / fps.den);
  if (!Number.isSafeInteger(frames)) {
    throw new MontashError("E_INVALID_TIME", `seconds ${s} is out of range at ${fpsLabel(fps)} fps`);
  }
  const exactSeconds = (frames * fps.den) / fps.num;
  const snapped = Math.abs(exactSeconds - s) > SNAP_TOLERANCE_SECONDS;
  return { frames, snapped, exactSeconds };
}

// ---------------------------------------------------------------------------
// フレーム <-> サンプル、fps 変更
// ---------------------------------------------------------------------------

function assertSampleRate(sampleRate: unknown): number {
  if (!isPositiveInt(sampleRate)) {
    throw new MontashError("E_INVALID_TIME", `sample rate must be a positive integer (got ${describe(sampleRate)})`);
  }
  return sampleRate;
}

/** `round(f * den * sr / num)`。29.97/48kHz では 1 フレーム = 1601.6 サンプルなので丸めが入る（誤差 < 1 サンプル） */
export function framesToSamples(f: number, fps: Fps, sampleRate: number): number {
  assertInt(f, "frames");
  assertSampleRate(sampleRate);
  return scaledUnits(f, fps, sampleRate);
}

/** `round(smp * num / (den * sr))` */
export function samplesToFrames(smp: number, fps: Fps, sampleRate: number): number {
  assertInt(smp, "samples");
  assertSampleRate(sampleRate);
  return roundDiv(smp * fps.num, fps.den * sampleRate);
}

/** fps 変更時の再スナップ: `round(f * to.num * from.den / (to.den * from.num))`（docs/05 §2） */
export function resnapFrames(f: number, from: Fps, to: Fps): number {
  assertInt(f, "frames");
  return roundDiv(f * to.num * from.den, to.den * from.num);
}

// ---------------------------------------------------------------------------
// 検証
// ---------------------------------------------------------------------------

/** 非負の safe integer であることを確認して返す。`field` はエラーメッセージ用のフィールド名 */
export function assertFrames(f: unknown, field: string): number {
  if (typeof f !== "number" || !Number.isSafeInteger(f) || f < 0) {
    throw new MontashError("E_INVALID_TIME", `${field} must be a non-negative integer number of frames (got ${describe(f)})`, {
      hint: "Time fields are stored as integer frames at the project fps (e.g. start_f: 375).",
      detail: { field, value: typeof f === "number" || typeof f === "string" ? f : describe(f) },
    });
  }
  return f;
}
