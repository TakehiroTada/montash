/**
 * テロップの幅自動フィット（docs/04 §9 `--fit-width`）。
 *
 * 切り抜き動画のテロップは「短い一言は大きく、長い一言は小さく、**常に 1 行で画面幅いっぱい**」に
 * 作られている。`--size` でポイント数を固定する今のやり方だと、一言ごとに人（や AI）が
 * 文字数からサイズを逆算することになり実用にならない。そこで **指定した幅に収まる最大のサイズ**を
 * ホスト側で決め、結果を `style.size` という**ただの数値として project.json に注入**する。
 *
 * ここは**純関数だけ**を置く（docs/08「I/O は graph の外」）。
 * 文字幅の見積もりには 2 系統がある:
 *
 *   1. **概算**（既定。外部依存ゼロ）: 字種ごとの em 幅で足し合わせる。全角は 1em、
 *      ラテン・数字は字ごとの advance（Helvetica の AFM 値 / 1000 を土台にした概算）。
 *   2. **実測**（`--measure`）: libass に実際に描かせて幅を測る（`src/ffmpeg/text-measure.ts`）。
 *      I/O を伴うので、測った em 幅を `FitOptions.measure` から**値として**流し込む形にしてある。
 *
 * どちらの経路でも「em 幅 → サイズ」の算術はこのファイルの `fitFontSize()` 1 か所に集約している。
 */
import { MontashError } from "../cli/errors.ts";
import { charClass } from "./subtitle-format.ts";

// ---------------------------------------------------------------------------
// 字幅の概算
// ---------------------------------------------------------------------------

/**
 * ASCII 可読文字の advance 幅（em 単位）。Helvetica の AFM 値 / 1000 を丸めたもの。
 *
 * ゴシック系のプロポーショナル欧文フォントはおおむねこの比率に近い。ウェイトが太い書体
 * （Black / Heavy）はこれより数 % 広いので、欧文主体の文字列では実測（`--measure`）のほうが確実。
 */
const ASCII_EM: Readonly<Record<string, number>> = {
  " ": 0.278,
  "!": 0.278,
  '"': 0.355,
  "#": 0.556,
  $: 0.556,
  "%": 0.889,
  "&": 0.667,
  "'": 0.191,
  "(": 0.333,
  ")": 0.333,
  "*": 0.389,
  "+": 0.584,
  ",": 0.278,
  "-": 0.333,
  ".": 0.278,
  "/": 0.278,
  ":": 0.278,
  ";": 0.278,
  "<": 0.584,
  "=": 0.584,
  ">": 0.584,
  "?": 0.556,
  "@": 1.015,
  A: 0.667,
  B: 0.667,
  C: 0.722,
  D: 0.722,
  E: 0.667,
  F: 0.611,
  G: 0.778,
  H: 0.722,
  I: 0.278,
  J: 0.5,
  K: 0.667,
  L: 0.556,
  M: 0.833,
  N: 0.722,
  O: 0.778,
  P: 0.667,
  Q: 0.778,
  R: 0.722,
  S: 0.667,
  T: 0.611,
  U: 0.722,
  V: 0.667,
  W: 0.944,
  X: 0.667,
  Y: 0.667,
  Z: 0.611,
  "[": 0.278,
  "\\": 0.278,
  "]": 0.278,
  "^": 0.469,
  _: 0.556,
  "`": 0.333,
  a: 0.556,
  b: 0.556,
  c: 0.5,
  d: 0.556,
  e: 0.556,
  f: 0.278,
  g: 0.556,
  h: 0.556,
  i: 0.222,
  j: 0.222,
  k: 0.5,
  l: 0.222,
  m: 0.833,
  n: 0.556,
  o: 0.556,
  p: 0.556,
  q: 0.556,
  r: 0.333,
  s: 0.5,
  t: 0.278,
  u: 0.556,
  v: 0.5,
  w: 0.722,
  x: 0.5,
  y: 0.5,
  z: 0.5,
  "{": 0.334,
  "|": 0.26,
  "}": 0.334,
  "~": 0.584,
};

/** 数字は等幅（tabular）で組まれることが多いので 1 つの値にまとめる */
const DIGIT_EM = 0.556;

/**
 * 全角（East Asian Width の W / F）の範囲。ここに入る文字は 1em として数える。
 *
 * `charClass()` は `、` と `,` をどちらも `punct`、`　`（U+3000）と ` ` をどちらも `space` に
 * 分類する（語の切れ目判定にはそれで十分だが、幅は 3 倍以上違う）。幅の見積もりでは
 * **コードポイントの範囲**で全角・半角を分ける。
 */
const FULLWIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // ハングル字母
  [0x2e80, 0x303e], // CJK 部首補助〜CJK 記号（`、`『』など）
  [0x3041, 0x33ff], // かな・ハングル・CJK 互換
  [0x3400, 0x4dbf], // CJK 拡張 A
  [0x4e00, 0x9fff], // CJK 統合漢字
  [0xa000, 0xa4cf], // イ文字
  [0xac00, 0xd7a3], // ハングル音節
  [0xf900, 0xfaff], // CJK 互換漢字
  [0xfe10, 0xfe19], // 縦書き用記号
  [0xfe30, 0xfe6f], // CJK 互換形・小字形
  [0xff00, 0xff60], // 全角 ASCII・全角記号
  [0xffe0, 0xffe6], // 全角通貨記号
  [0x1f300, 0x1f9ff], // 絵文字
  [0x20000, 0x2fa1f], // CJK 拡張 B 以降
];

/** 全角として数える文字か */
export function isFullWidth(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if (cp === 0x3000) return true; // 全角スペース（`charClass` は space に分類する）
  for (const [lo, hi] of FULLWIDTH_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

/**
 * 1 文字の概算 advance 幅（em）。`charClass()` の字種判定を土台にし、
 * 全角・半角はコードポイントで分ける（純関数）。
 */
export function charEm(ch: string): number {
  if (ch === "") return 0;
  if (isFullWidth(ch)) return 1;
  const cls = charClass(ch);
  if (cls === "digit") return DIGIT_EM;
  const ascii = ASCII_EM[ch];
  if (ascii !== undefined) return ascii;
  switch (cls) {
    case "space":
      return ASCII_EM[" "] as number;
    case "latin":
      return 0.556; // ラテン拡張（アクセント付きなど）は小文字相当で見る
    case "punct":
      return 0.5;
    default:
      // 半角カナ・記号・その他。半角カナは 0.5em
      return /[｡-ﾟ]/.test(ch) ? 0.5 : 0.6;
  }
}

/**
 * 1 行の概算幅（em）。フォントサイズ 1px あたりの描画幅にあたる（純関数）。
 * サロゲートペアを 1 文字として数えるため、文字列は `[...line]` で回す。
 */
export function estimateLineEm(line: string): number {
  let sum = 0;
  for (const ch of line) sum += charEm(ch);
  return sum;
}

// ---------------------------------------------------------------------------
// 幅指定のパース
// ---------------------------------------------------------------------------

/**
 * `--fit-width 90%` / `--fit-width 1152` / `--fit-width 1152px` を px に解決する。
 * `%` はプロジェクト解像度の横幅に対する割合。
 */
export function parseFitWidth(raw: string, videoWidth: number): number {
  const text = String(raw).trim();
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(text);
  if (pct?.[1] !== undefined) {
    const ratio = Number(pct[1]) / 100;
    if (ratio <= 0 || ratio > 1)
      throw new MontashError("E_USAGE", `invalid --fit-width "${raw}"`, {
        hint: "Use a percentage of the project width between 0% and 100% (for example 90%).",
        detail: { fit_width: raw },
      });
    return ratio * videoWidth;
  }
  const px = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(text);
  if (px?.[1] !== undefined && Number(px[1]) > 0) return Number(px[1]);
  throw new MontashError("E_USAGE", `invalid --fit-width "${raw}"`, {
    hint: 'Use a percentage ("90%") or a pixel width ("1152") on the project resolution basis.',
    detail: { fit_width: raw },
  });
}

// ---------------------------------------------------------------------------
// サイズの決定
// ---------------------------------------------------------------------------

/** フィットの既定値（プロジェクト解像度の高さに対する比率） */
export const FIT_DEFAULTS = {
  /**
   * `--max-size` の既定。切り抜きテロップの実測（画面高の 9〜10%）に合わせてある。
   * `--size` かプリセットのサイズがあればそちらが上限になる。
   */
  maxSizeRatio: 0.1,
  /** `--min-size` の既定。これ以上小さいと 1 行に押し込んでも読めない */
  minSizeRatio: 0.04,
} as const;

/** 行ごとの em 幅を返す関数（実測を差し込むための口） */
export type LineMeasure = (line: string) => number;

export interface FitOptions {
  /** 本文（`\n` 区切りの複数行を受け付ける。いちばん幅の要る行が全体のサイズを決める） */
  text: string;
  /** 収めたい幅（px。プロジェクト解像度基準） */
  maxWidth: number;
  /** サイズの上限（px） */
  maxSize: number;
  /** サイズの下限（px） */
  minSize: number;
  /** 縁取りの太さ（px）。左右に 1 本ずつはみ出すので幅から差し引く */
  outlineWidth?: number;
  /**
   * ASS の `Fontsize` 1px あたりに出る em 数（既定 1）。
   * libass は「`usWinAscent + usWinDescent` が Fontsize になる」ように字を縮めるので、
   * CJK フォントでは 0.8 前後になる（`src/ffmpeg/font-metrics.ts` が読んで値で渡す）。
   * 実測値を `measure` で渡すときは、そこに既に含まれているので 1 のままにする。
   */
  sizeScale?: number;
  /** 行ごとの em 幅。既定は `estimateLineEm`（概算） */
  measure?: LineMeasure;
}

export interface FitResult {
  /** 決まったフォントサイズ（px。整数に切り下げるので「収まる側」に倒れる） */
  size: number;
  /** 幅を決めた行（いちばん長い行） */
  line: string;
  /** その行の em 幅 */
  em: number;
  /** `size` で描いたときのその行の推定幅（px。縁取りを含む） */
  width: number;
  /** 上限・下限で頭打ちになったか。`"min"` は指定幅に収まらなかったことを意味する */
  clamped: "min" | "max" | null;
}

/**
 * 指定した幅に収まる最大のフォントサイズを決める（純関数）。
 *
 * 描画幅は「フォントサイズ × em 幅」で線形に効くので、`size = (maxWidth - 縁取り) / em` を
 * 切り下げ、`[minSize, maxSize]` に丸める。下限で止まったときは `clamped: "min"` を返し、
 * 呼び出し側が「指定幅に収まらなかった」と警告できるようにする（黙って溢れさせない）。
 *
 * `em` は `sizeScale` を掛けたあとの値（= 実際に ASS の Fontsize 1px あたりに出る幅）を返す。
 */
export function fitFontSize(opts: FitOptions): FitResult {
  const base = opts.measure ?? estimateLineEm;
  const scale = opts.sizeScale !== undefined && opts.sizeScale > 0 ? opts.sizeScale : 1;
  const measure: LineMeasure = (line) => base(line) * scale;
  const outline = Math.max(0, opts.outlineWidth ?? 0);
  const maxSize = Math.max(1, opts.maxSize);
  const minSize = Math.max(1, Math.min(opts.minSize, maxSize));
  const available = Math.max(1, opts.maxWidth - outline * 2);

  const lines = opts.text.split("\n");
  let line = lines[0] ?? "";
  let em = 0;
  for (const candidate of lines) {
    const value = measure(candidate);
    if (value > em) {
      em = value;
      line = candidate;
    }
  }

  if (em <= 0) {
    // 空文字・空白だけ: 幅の制約が無いので上限をそのまま使う
    return { size: maxSize, line, em: 0, width: outline * 2, clamped: null };
  }

  const ideal = Math.floor(available / em);
  const size = Math.min(maxSize, Math.max(minSize, ideal));
  const clamped = ideal > maxSize ? "max" : ideal < minSize ? "min" : null;
  return { size, line, em, width: em * size + outline * 2, clamped };
}

/** `--max-size` / `--min-size` を省略したときの既定（プロジェクト解像度の高さ基準） */
export function defaultFitBounds(videoHeight: number, styleSize?: number): { maxSize: number; minSize: number } {
  const maxSize = styleSize ?? Math.round(videoHeight * FIT_DEFAULTS.maxSizeRatio);
  const minSize = Math.min(maxSize, Math.round(videoHeight * FIT_DEFAULTS.minSizeRatio));
  return { maxSize: Math.max(1, maxSize), minSize: Math.max(1, minSize) };
}
