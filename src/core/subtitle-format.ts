/**
 * 書き起こしトークン → 「読める字幕」への整形（純関数。docs/03 W-22, docs/04 §12）。
 *
 * 書き起こしエンジン（whisper.cpp など）が返すのは **トークン単位のタイムスタンプ**で、
 * そのまま SRT にすると「事前ガ / イダンス」のように語の途中で切れて読めない。
 * 実地で判明した「読める字幕」の条件を、ここに 1 か所へまとめる:
 *
 *   1. **文（。！？）でまとめるのを最優先**。文の途中で切ると読みにくい
 *   2. 長い文は読点（、）で分け、それでも長ければ文字数で分ける
 *   3. **語の途中で切らない**（カタカナ語・漢字の連なり・助詞の直前で切らない）
 *   4. 1 字幕 = 最大 `maxLines` 行 × `maxCharsPerLine` 字
 *   5. 日本語の**禁則処理**（行頭に句読点・閉じ括弧・小書き仮名・長音符を置かない）
 *   6. 表示時間は `minDurationMs`〜`maxDurationMs`、字幕どうしは重ならない
 *
 * エンジン自体は montash に組み込まない（docs/14「やらないこと」）。ここが本体の価値なので、
 * 外部プロセスにも I/O にも依存しない純関数として書き、単体テストで固定する。
 */

/** 書き起こしエンジンが返す 1 トークン（語より細かいこともある） */
export interface TranscriptToken {
  /** トークンの文字列（前後の空白は許容する） */
  text: string;
  startMs: number;
  endMs: number;
}

export interface SubtitleFormatOptions {
  /** 1 行の最大文字数（既定 20） */
  maxCharsPerLine?: number;
  /** 1 字幕の最大行数（既定 2） */
  maxLines?: number;
  /** 表示時間の下限（ms。既定 1200） */
  minDurationMs?: number;
  /** 表示時間の上限（ms。既定 5500） */
  maxDurationMs?: number;
  /** 字幕どうしの最小の間隔（ms。既定 40） */
  minGapMs?: number;
}

/** 整形後の 1 字幕 */
export interface FormattedCue {
  startMs: number;
  endMs: number;
  /** 表示行（`maxLines` 以下） */
  lines: string[];
  /** `lines.join("\n")` */
  text: string;
}

export const SUBTITLE_FORMAT_DEFAULTS = {
  maxCharsPerLine: 20,
  maxLines: 2,
  minDurationMs: 1200,
  maxDurationMs: 5500,
  minGapMs: 40,
} as const;

// ---------------------------------------------------------------------------
// 文字の分類と禁則
// ---------------------------------------------------------------------------

/** 行頭に置けない文字（句読点・閉じ括弧・小書き仮名・長音符・繰り返し記号） */
const NO_LINE_START = new Set([
  ...`、。，．,.:：;；!！?？)）]］}｝〉》」』〕】〙〗>＞”’"'`,
  ..."ぁぃぅぇぉっゃゅょゎゕゖ",
  ..."ァィゥェォッャュョヮヵヶ",
  ..."ー―‐〜～・…‥々ゝゞヽヾ",
]);

/** 行末に置けない文字（開き括弧） */
const NO_LINE_END = new Set([...`(（[［{｛〈《「『〔【〖<＜“‘`]);

/** 文の終わり */
const SENTENCE_END = new Set([..."。．.！!？?…"]);

/** 文末記号のあとに続きうる閉じ記号（`「…だよ。」` の `」` まで 1 文に含める） */
const CLOSERS = new Set([...`)）]］}｝〉》」』〕】〙〗”’"'`]);

/** 読点（ここで分けると読みやすい） */
const COMMA = new Set([..."、，,"]);

/**
 * 直前の語に貼り付く語（助詞など）。この直前では切らない。
 * 長いものから試すので、配列の順序に意味がある。
 */
const PARTICLES = [
  "という",
  "について",
  "における",
  "として",
  "からの",
  "までに",
  "から",
  "まで",
  "より",
  "など",
  "ので",
  "のに",
  "だけ",
  "ほど",
  "こそ",
  "さえ",
  "でも",
  "には",
  "とは",
  "では",
  "へと",
  "って",
  "は",
  "が",
  "を",
  "に",
  "へ",
  "と",
  "で",
  "も",
  "の",
  "や",
  "か",
  "ね",
  "よ",
] as const;

export type CharClass = "kanji" | "katakana" | "hiragana" | "latin" | "digit" | "punct" | "space" | "other";

/** 文字の種別（語の連なりを壊さないための判定に使う） */
export function charClass(ch: string): CharClass {
  if (/\s/.test(ch)) return "space";
  if (/[0-9０-９]/.test(ch)) return "digit";
  if (/[A-Za-zＡ-Ｚａ-ｚ]/.test(ch)) return "latin";
  if (/[ぁ-ゟ]/.test(ch)) return "hiragana";
  if (/[゠-ヿｦ-ﾟ]/.test(ch)) return "katakana";
  if (/[一-鿿々〇豈-﫿]/.test(ch)) return "kanji";
  if (/[\p{P}\p{S}]/u.test(ch)) return "punct";
  return "other";
}

function startsWithParticle(text: string, i: number): boolean {
  for (const p of PARTICLES) {
    if (text.startsWith(p, i)) return true;
  }
  return false;
}

/**
 * `i - 1` と `i` の間で切ってよいか、切るならどれだけ好ましいかを返す（純関数）。
 * 負の値は「切ってはいけない」。値が大きいほど好ましい区切り。
 */
export function breakScore(text: string, i: number): number {
  if (i <= 0 || i >= text.length) return -1;
  const prev = text[i - 1] as string;
  const next = text[i] as string;
  // 禁則: 行頭に来られない文字の前／行末に来られない文字の後ろでは切らない
  if (NO_LINE_START.has(next)) return -1;
  if (NO_LINE_END.has(prev)) return -1;
  const a = charClass(prev);
  const b = charClass(next);
  // 空白は自然な区切り
  if (a === "space" || b === "space") return 9;
  // 句読点・閉じ括弧の直後はいちばん好ましい
  if (SENTENCE_END.has(prev) || CLOSERS.has(prev)) return 10;
  if (COMMA.has(prev)) return 8;
  // 助詞は直前の語に貼り付く。その手前で切ると「事前 / が」のように読めなくなる
  if (startsWithParticle(text, i)) return -1;
  // 語の途中（同じ種別が続いている）では切らない: カタカナ語・漢語・英数字
  if (a === b && (a === "kanji" || a === "katakana" || a === "latin" || a === "digit")) return -1;
  // ひらがな → 漢字・カタカナ・英数字 は語の頭になりやすい
  if (a === "hiragana" && b !== "hiragana") return 6;
  if (a !== b) return 3;
  // ひらがな同士。最後の手段として許す
  return 1;
}

/**
 * `[minCut, maxCut]` の範囲から、いちばん好ましい区切り位置を選ぶ（純関数）。
 * `softTarget` に近いほど好ましい（行の長さを揃えるため）。
 * どこも切れない場合は禁則だけ避けて `maxCut` 付近で切る。
 */
export function findBreak(text: string, minCut: number, maxCut: number, softTarget: number): number {
  const lo = Math.max(1, minCut);
  const hi = Math.min(maxCut, text.length - 1);
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = lo; i <= hi; i++) {
    const s = breakScore(text, i);
    if (s < 0) continue;
    const total = s * 100 - Math.abs(i - softTarget);
    if (total > bestScore) {
      bestScore = total;
      best = i;
    }
  }
  if (best > 0) return best;
  // 候補が無い（1 語が長すぎるカタカナ語など）。目標位置で割り、行頭禁則だけは避ける
  let i = Math.min(hi, Math.max(lo, softTarget));
  while (i > lo && NO_LINE_START.has(text[i] as string)) i--;
  return Math.max(i, lo);
}

// ---------------------------------------------------------------------------
// 区間（元テキストの [start, end) ）での分割
// ---------------------------------------------------------------------------

type Range = [number, number];

/** 文（。！？…）で切る。文末記号に続く閉じ括弧は同じ文に含める */
export function sentenceRanges(text: string): Range[] {
  const out: Range[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!SENTENCE_END.has(text[i] as string)) continue;
    let j = i + 1;
    while (j < text.length && (SENTENCE_END.has(text[j] as string) || CLOSERS.has(text[j] as string))) j++;
    out.push([start, j]);
    start = j;
    i = j - 1;
  }
  if (start < text.length) out.push([start, text.length]);
  return out;
}

/** 読点の直後で切る */
function commaRanges(text: string, [s, e]: Range): Range[] {
  const out: Range[] = [];
  let start = s;
  for (let i = s; i < e; i++) {
    if (!COMMA.has(text[i] as string)) continue;
    out.push([start, i + 1]);
    start = i + 1;
  }
  if (start < e) out.push([start, e]);
  return out;
}

/** どうしても長い区間を文字数で割る（語の途中では切らない） */
function splitByLength(text: string, [s, e]: Range, capacity: number, out: Range[]): void {
  let pos = s;
  while (e - pos > capacity) {
    const cut = findBreak(text, pos + 1, pos + capacity, pos + capacity);
    if (cut <= pos) break;
    out.push([pos, cut]);
    pos = cut;
  }
  if (e > pos) out.push([pos, e]);
}

/**
 * 1 文を字幕 1 枚に収まる区間へ割る（純関数）。
 * 文 → 読点 → 文字数、の順に緩めていく。
 */
export function chunkSentence(text: string, range: Range, capacity: number): Range[] {
  if (range[1] - range[0] <= capacity) return [range];
  const merged: Range[] = [];
  let cur: Range | null = null;
  for (const piece of commaRanges(text, range)) {
    if (cur !== null && piece[1] - cur[0] <= capacity) {
      cur = [cur[0], piece[1]];
      continue;
    }
    if (cur !== null) merged.push(cur);
    cur = piece;
  }
  if (cur !== null) merged.push(cur);
  const out: Range[] = [];
  for (const r of merged) {
    if (r[1] - r[0] <= capacity) out.push(r);
    else splitByLength(text, r, capacity, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 行分け・禁則
// ---------------------------------------------------------------------------

/**
 * 禁則処理（行頭に句読点・閉じ括弧・小書き仮名・長音符を置かない / 行末に開き括弧を置かない）。
 * 行頭に来てしまった文字は前の行の末尾へ送る（ぶら下げ）ので、1 行が規定より 1 文字長くなることがある。
 */
export function applyKinsoku(lines: readonly string[]): string[] {
  const out = [...lines];
  for (let i = 1; i < out.length; i++) {
    for (;;) {
      const line = out[i] as string;
      const head = line[0];
      if (head === undefined || !NO_LINE_START.has(head) || line.length <= 1) break;
      out[i - 1] = (out[i - 1] as string) + head;
      out[i] = line.slice(1);
    }
  }
  for (let i = out.length - 2; i >= 0; i--) {
    for (;;) {
      const line = out[i] as string;
      const tail = line.at(-1);
      if (tail === undefined || !NO_LINE_END.has(tail) || line.length <= 1) break;
      out[i] = line.slice(0, -1);
      out[i + 1] = tail + (out[i + 1] as string);
    }
  }
  return out.filter((l) => l !== "");
}

/**
 * 1 字幕の本文を最大 `maxLines` 行 × `maxCharsPerLine` 字へ折る（純関数）。
 * 行の長さが揃うように区切り位置を選び、語の途中では切らない。
 */
export function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const body = text.trim();
  if (body === "") return [];
  if (body.length <= maxCharsPerLine) return [body];
  const lines: string[] = [];
  let pos = 0;
  while (pos < body.length) {
    const remaining = body.length - pos;
    if (lines.length === maxLines - 1 || remaining <= maxCharsPerLine) {
      lines.push(body.slice(pos));
      break;
    }
    const linesLeft = maxLines - lines.length;
    // 残りが最後の行に収まるよう、ここより手前では切らない
    const minCut = Math.max(pos + 1, pos + remaining - (linesLeft - 1) * maxCharsPerLine);
    const target = pos + Math.min(maxCharsPerLine, Math.ceil(remaining / linesLeft));
    const cut = findBreak(body, minCut, pos + maxCharsPerLine, target);
    if (cut <= pos) {
      lines.push(body.slice(pos));
      break;
    }
    lines.push(body.slice(pos, cut));
    pos = cut;
  }
  return applyKinsoku(lines.map((l) => l.trim()).filter((l) => l !== ""));
}

// ---------------------------------------------------------------------------
// トークン → 文字ごとの時刻
// ---------------------------------------------------------------------------

/** whisper.cpp などが混ぜてくる特殊トークン（`[_BEG_]` / `<|ja|>`） */
const SPECIAL_TOKEN = /^\s*(?:\[[^\]]*\]|<\|[^|]*\|>)\s*$/;

interface CharTime {
  startMs: number;
  endMs: number;
}

/** 特殊トークンを落とし、開始時刻を単調増加に均す（エンジンの時刻は前後することがある） */
export function cleanTokens(tokens: readonly TranscriptToken[]): TranscriptToken[] {
  const out: TranscriptToken[] = [];
  let prevStart = 0;
  for (const t of tokens) {
    if (t.text === "" || SPECIAL_TOKEN.test(t.text)) continue;
    const startMs = Math.max(0, t.startMs, prevStart);
    const endMs = Math.max(t.endMs, startMs);
    out.push({ text: t.text, startMs, endMs });
    prevStart = startMs;
  }
  return out;
}

/** トークン列を 1 本の文字列と、文字ごとの時刻へ展開する */
function expand(tokens: readonly TranscriptToken[]): { text: string; times: CharTime[] } {
  let text = "";
  const times: CharTime[] = [];
  for (const t of tokens) {
    const chars = [...t.text];
    const span = Math.max(0, t.endMs - t.startMs);
    for (let k = 0; k < chars.length; k++) {
      text += chars[k];
      times.push({
        startMs: t.startMs + (span * k) / chars.length,
        endMs: t.startMs + (span * (k + 1)) / chars.length,
      });
    }
  }
  return { text, times };
}

/** 区間の前後から空白を落とす（空になったら null） */
function trimRange(text: string, [s, e]: Range): Range | null {
  let a = s;
  let b = e;
  while (a < b && /\s/.test(text[a] as string)) a++;
  while (b > a && /\s/.test(text[b - 1] as string)) b--;
  return b > a ? [a, b] : null;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

/**
 * 書き起こしトークンを「読める字幕」に整形する（純関数）。
 *
 * 文 → 読点 → 文字数の順に分け、語の途中では切らず、禁則処理を掛け、
 * 表示時間を `min`〜`max` に収めて、字幕どうしが重ならないようにする。
 */
export function formatTranscript(
  tokens: readonly TranscriptToken[],
  options: SubtitleFormatOptions = {},
): FormattedCue[] {
  const maxCharsPerLine = options.maxCharsPerLine ?? SUBTITLE_FORMAT_DEFAULTS.maxCharsPerLine;
  const maxLines = options.maxLines ?? SUBTITLE_FORMAT_DEFAULTS.maxLines;
  const minDurationMs = options.minDurationMs ?? SUBTITLE_FORMAT_DEFAULTS.minDurationMs;
  const maxDurationMs = options.maxDurationMs ?? SUBTITLE_FORMAT_DEFAULTS.maxDurationMs;
  const minGapMs = options.minGapMs ?? SUBTITLE_FORMAT_DEFAULTS.minGapMs;
  if (maxCharsPerLine < 1 || maxLines < 1) throw new Error("maxCharsPerLine and maxLines must be >= 1");
  const capacity = maxCharsPerLine * maxLines;

  const { text, times } = expand(cleanTokens(tokens));
  if (text.trim() === "") return [];

  const ranges: Range[] = [];
  for (const sentence of sentenceRanges(text)) {
    const trimmed = trimRange(text, sentence);
    if (trimmed === null) continue;
    for (const chunk of chunkSentence(text, trimmed, capacity)) {
      const r = trimRange(text, chunk);
      if (r !== null) ranges.push(r);
    }
  }

  const cues: FormattedCue[] = [];
  for (const [s, e] of ranges) {
    const lines = wrapLines(text.slice(s, e), maxCharsPerLine, maxLines);
    if (lines.length === 0) continue;
    const startMs = Math.round((times[s] as CharTime).startMs);
    const endMs = Math.round((times[e - 1] as CharTime).endMs);
    cues.push({ startMs, endMs: Math.max(endMs, startMs), lines, text: lines.join("\n") });
  }

  return retime(cues, { minDurationMs, maxDurationMs, minGapMs });
}

/**
 * 表示時間を整える（純関数）:
 *   - 長すぎる表示は `maxDurationMs` で切る
 *   - 短すぎる表示は次の字幕の手前まで伸ばす（`minDurationMs`。空きが無ければ伸ばさない）
 *   - 重なりは前の字幕を縮めて解消する（最低でも 1ms は残す）
 */
export function retime(
  cues: readonly FormattedCue[],
  opts: { minDurationMs: number; maxDurationMs: number; minGapMs: number },
): FormattedCue[] {
  const out = cues.map((c) => ({ ...c }));
  for (let i = 0; i < out.length; i++) {
    const cue = out[i] as FormattedCue;
    const next = out[i + 1];
    if (cue.endMs - cue.startMs > opts.maxDurationMs) cue.endMs = cue.startMs + opts.maxDurationMs;
    const ceiling = next === undefined ? Number.POSITIVE_INFINITY : next.startMs - opts.minGapMs;
    if (cue.endMs - cue.startMs < opts.minDurationMs) {
      cue.endMs = Math.max(cue.endMs, Math.min(cue.startMs + opts.minDurationMs, ceiling));
    }
    if (cue.endMs > ceiling) cue.endMs = Math.max(cue.startMs + 1, ceiling);
    if (cue.endMs <= cue.startMs) cue.endMs = cue.startMs + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// SRT 出力
// ---------------------------------------------------------------------------

/** `00:01:02,345` */
export function formatSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const milli = total % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/** 整形済みの字幕を SRT にする（純関数） */
export function toSrt(cues: readonly FormattedCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}\n`)
    .join("\n");
}
