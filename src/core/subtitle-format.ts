/**
 * 書き起こしトークン → 「読める字幕」への整形（純関数。docs/03 W-22, docs/04 §12）。
 *
 * 書き起こしエンジン（whisper.cpp など）が返すのは **トークン単位のタイムスタンプ**で、
 * そのまま SRT にすると「事前ガ / イダンス」のように語の途中で切れて読めない。
 * 実地で判明した「読める字幕」の条件を、ここに 1 か所へまとめる:
 *
 *   1. **文（。！？）でまとめるのを最優先**。文の途中で切ると読みにくい
 *   2. 句点が無くても、**話者の間（トークン間の無音）**が空いたところは文の切れ目として扱う
 *   3. 長い文は読点（、）で分け、それでも長ければ文字数で分ける
 *   4. **語の途中で切らない**（カタカナ語・漢字の連なり・助詞の直前・接頭辞と接尾辞の途中で切らない）
 *   5. 1 字幕 = 最大 `maxLines` 行 × `maxCharsPerLine` 字
 *   6. 日本語の**禁則処理**（行頭に句読点・閉じ括弧・小書き仮名・長音符を置かない）
 *   7. 表示時間は `minDurationMs`〜`maxDurationMs`、字幕どうしは重ならない
 *
 * 字幕の切れ目（cue 境界）と 1 字幕の中の行折り返しは、**同じ `breakScore()` で判定する**。
 * 語境界の知識を 2 か所に分けて持つと、片方だけ直して片方が割れる（D-21 がそれだった）。
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
  /**
   * これ以上の無音（トークン間の間）があれば、句点が無くてもそこで字幕を切る（ms。既定 500）。
   * 0 を渡すと間を見ない（句点だけで切る）。
   */
  pauseGapMs?: number;
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
  pauseGapMs: 500,
} as const;

/**
 * 間（ま）で字幕を切るときの下限の文字数。これより短い断片は作らない。
 * 切りすぎると「で、」だけの字幕が量産されるので、両側がこの長さ以上のときだけ切る。
 */
export const MIN_PAUSE_CHUNK_CHARS = 8;

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

/**
 * 直前の語に貼り付く**活用語尾・敬体**。この直前でも切らない。
 *
 * 実素材で「ありがとうござい / ます」のように割れたので、助詞（PARTICLES）と同じ扱いにする。
 * 語幹と語尾の境目（「共有 / します」「活用 / してもらう」）は読めるので**入れない**。
 * ここを広げすぎると、切れる場所が無くなってかえって悪いところで割れる（実素材で確認した）。
 * 長いものから試すので配列の順序に意味がある。
 */
const SUFFIXES = [
  "ませんでした",
  "ましょう",
  "ました",
  "ません",
  "まして",
  "ます",
  "でしょう",
  "でした",
  "ですね",
  "です",
  "ください",
  "られる",
  "れる",
  "たい",
  "ない",
  "なく",
] as const;

/**
 * 人に付く接尾辞。**前が漢字・カタカナ・英数字のときだけ**接尾辞とみなす。
 * そうしないと「（調べて）ちゃんと」のようなひらがなの語頭を接尾辞と取り違える。
 */
const NAME_SUFFIXES = ["さん", "くん", "ちゃん", "様"] as const;

/**
 * 次の語に貼り付く接頭辞。**この直後では切らない**（「よろしくお / 願いします」を防ぐ）。
 * 逆に、接頭辞の**手前**は語の頭なので好ましい区切りになる。
 */
const PREFIXES = ["お", "ご", "御"] as const;

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

/** 接続表現（文の頭に立つ言い回し）。読点を伴うものだけを見るので助詞と取り違えない */
const CONNECTIVES = [
  "というわけで",
  "とりあえず",
  "ちなみに",
  "ですので",
  "それでは",
  "それで",
  "じゃあ",
  "なので",
  "あと",
  "まあ",
  "はい",
  "じゃ",
] as const;

/**
 * 文の終わりらしい語尾。句点が無いときに「ここまでで 1 文」と見なしてよい手がかり。
 * 呼びかけ（「〜さん」「〜くん」）も、そのあとに間が空けば区切りとして扱う。
 */
const SENTENCE_LIKE_ENDINGS = [
  "ませんでした",
  "ましょう",
  "ました",
  "ません",
  "ます",
  "でしょう",
  "でした",
  "ですね",
  "です",
  "ください",
  "さん",
  "くん",
  "ちゃん",
] as const;

/** `SENTENCE_LIKE_ENDINGS` のいちばん長いものの文字数（後方を見る窓の幅） */
const MAX_SENTENCE_LIKE_ENDING = Math.max(...SENTENCE_LIKE_ENDINGS.map((s) => s.length));

/** 語の頭（ここで切ると読める）の点数。間（ま）による格上げの下限にも使う */
const WORD_HEAD_SCORE = 6;

/** 間（ま）が空いていたら、句点と同じくらい good な区切りとして扱う */
const PAUSE_SCORE = 10;

/** `text[i]` から始まる語が「直前に貼り付く」ものか（助詞・活用語尾・接尾辞） */
function attachesToPrevious(text: string, i: number): boolean {
  for (const p of PARTICLES) {
    if (text.startsWith(p, i)) return true;
  }
  for (const s of SUFFIXES) {
    if (text.startsWith(s, i)) return true;
  }
  const before = charClass(text[i - 1] ?? "");
  if (before !== "hiragana" && before !== "space" && NAME_SUFFIXES.some((s) => text.startsWith(s, i))) return true;
  return false;
}

/** `text[i]` が「お願い」「ご説明」のような接頭辞 + 語の**接頭辞**か */
function isPrefixAt(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === undefined || !PREFIXES.includes(ch as (typeof PREFIXES)[number])) return false;
  const after = text[i + 1];
  if (after === undefined) return false;
  const cls = charClass(after);
  return cls === "kanji" || cls === "katakana";
}

function startsWithConnective(text: string, i: number): boolean {
  for (const c of CONNECTIVES) {
    // 「で、」のような助詞と紛れる形を避けるため、読点を伴うものだけを接続表現とみなす
    if (text.startsWith(c, i) && COMMA.has(text[i + c.length] ?? "")) return true;
  }
  return false;
}

/** `breakScore()` に渡す文脈。文字ごとの「直前の無音（ms）」を添えると、間（ま）も判定に使う */
export interface BreakContext {
  /** `gaps[i]` = `text[i]` の直前にあった無音の長さ（ms）。トークンの内側は 0 */
  gaps?: readonly number[] | undefined;
  /** この長さ以上の無音は語の切れ目として格上げする（ms） */
  pauseHintMs?: number | undefined;
  /** 助詞・接尾辞の「貼り付き」を無視する（どこも切れないときの最後の手段） */
  relaxed?: boolean | undefined;
}

/**
 * `i - 1` と `i` の間で切ってよいか、切るならどれだけ好ましいかを返す（純関数）。
 * 負の値は「切ってはいけない」。値が大きいほど好ましい区切り。
 *
 * **cue 境界（字幕の切れ目）と行折り返しの両方がこの 1 つの判定を使う。**
 * `ctx.gaps` を渡すと、話者の間（ま）が空いたところを語の切れ目として格上げする。
 */
export function breakScore(text: string, i: number, ctx: BreakContext = {}): number {
  const base = rawScore(text, i, ctx);
  if (base < WORD_HEAD_SCORE) return base;
  // 間（ま）が空いていて、文の切れ目らしければ句点と同じ扱いにする。
  // 語の途中（`base < WORD_HEAD_SCORE`）は格上げしない: エンジンの時刻は語の中でも飛ぶ（「33 | 回目」）
  const hint = ctx.pauseHintMs;
  const gap = ctx.gaps?.[i];
  if (hint !== undefined && hint > 0 && gap !== undefined && gap >= hint && isUtteranceBoundary(text, i))
    return Math.max(base, PAUSE_SCORE);
  return base;
}

/**
 * 「ここで発話が切れた」と見てよい位置か（純関数）。
 * 左が文の終わりらしく終わる（敬体の語尾・呼びかけ・読点・句点）か、右が接続表現で始まる。
 * 間（ま）だけを根拠に切ると「リーダーの仕事はもっと | 重要な〜」のように句の途中で切れるので、
 * 間（時間）と本文（言葉）の両方がそろったときだけ切れ目とみなす。
 */
export function isUtteranceBoundary(text: string, i: number): boolean {
  if (i <= 0 || i > text.length) return false;
  const prev = text[i - 1] as string;
  if (SENTENCE_END.has(prev) || CLOSERS.has(prev) || COMMA.has(prev)) return true;
  const left = text.slice(Math.max(0, i - MAX_SENTENCE_LIKE_ENDING), i);
  if (SENTENCE_LIKE_ENDINGS.some((suffix) => left.endsWith(suffix))) return true;
  return startsWithConnective(text, i);
}

function rawScore(text: string, i: number, ctx: BreakContext): number {
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
  // 「週に 4、5 回」のような数の並びの読点は文の区切りではない
  if (COMMA.has(prev)) return b === "digit" && charClass(text[i - 2] ?? "") === "digit" ? -1 : 8;
  // 接頭辞は次の語に貼り付く。「よろしくお / 願いします」を防ぐ
  if (isPrefixAt(text, i - 1)) return -1;
  // 助詞・活用語尾は直前の語に貼り付く。その手前で切ると「事前 / が」のように読めなくなる
  if (!ctx.relaxed && attachesToPrevious(text, i)) return -1;
  // 接続表現（「じゃあ、」「なので、」）の手前は文の切れ目に近い
  if (startsWithConnective(text, i)) return 7;
  // 接頭辞のついた語（「お願い」「ご説明」）の手前は語の頭
  if (isPrefixAt(text, i)) return WORD_HEAD_SCORE;
  // 語の途中（同じ種別が続いている）では切らない: カタカナ語・漢語・英数字
  if (a === b && (a === "kanji" || a === "katakana" || a === "latin" || a === "digit")) return -1;
  // ひらがな → 漢字・カタカナ・英数字 は語の頭になりやすい
  if (a === "hiragana" && b !== "hiragana") return WORD_HEAD_SCORE;
  if (a !== b) return 3;
  // ひらがな同士。最後の手段として許す
  return 1;
}

/**
 * `[minCut, maxCut]` の範囲から、いちばん好ましい区切り位置を選ぶ（純関数）。
 * `softTarget` に近いほど好ましい（行の長さを揃えるため）。
 * 語境界の候補が無ければ助詞の貼り付きだけ緩めて探し直し、それでも無ければ禁則だけ避けて割る。
 */
export function findBreak(
  text: string,
  minCut: number,
  maxCut: number,
  softTarget: number,
  ctx: BreakContext = {},
): number {
  const lo = Math.max(1, minCut);
  const hi = Math.min(maxCut, text.length - 1);
  for (const relaxed of [false, true]) {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = lo; i <= hi; i++) {
      const s = breakScore(text, i, { ...ctx, relaxed });
      if (s < 0) continue;
      const total = s * 100 - Math.abs(i - softTarget);
      if (total > bestScore) {
        bestScore = total;
        best = i;
      }
    }
    if (best > 0) return best;
  }
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

/**
 * 話者の間（ま）で区間を割る（純関数。D-22）。
 *
 * whisper は句点を出さないことがあり、そのときは文の切れ目が本文に現れない。
 * 切る条件は 3 つそろったときだけ（実素材で確かめた。どれが欠けても誤爆する）:
 *
 *   1. トークン間の無音が `minGapMs` 以上
 *   2. `breakScore()` が語の頭と見る位置（エンジンの時刻は語の中でも飛ぶ。実素材で「33 | 回目」に 730ms）
 *   3. `isUtteranceBoundary()`（文の終わりらしい語尾、または接続表現の手前）
 *
 * さらに、両側が `MIN_PAUSE_CHUNK_CHARS` 以上になる切り方だけ採る（1 文字字幕を量産しないため）。
 */
export function pauseRanges(text: string, [s, e]: Range, gaps: readonly number[], minGapMs: number): Range[] {
  if (minGapMs <= 0) return [[s, e]];
  const out: Range[] = [];
  let start = s;
  for (let i = s + 1; i < e; i++) {
    if ((gaps[i] ?? 0) < minGapMs) continue;
    if (i - start < MIN_PAUSE_CHUNK_CHARS || e - i < MIN_PAUSE_CHUNK_CHARS) continue;
    if (breakScore(text, i) < WORD_HEAD_SCORE) continue;
    if (!isUtteranceBoundary(text, i)) continue;
    out.push([start, i]);
    start = i;
  }
  out.push([start, e]);
  return out;
}

/** 1 字幕の見た目の枠（行の長さと行数）。cue をどこで切るかはこれに依存する */
export interface LineGeometry {
  maxCharsPerLine: number;
  maxLines: number;
}

/**
 * どうしても長い区間を文字数で割る（語の途中では切らない）。
 *
 * 容量いっぱいまで詰めると、そのあとの**行折り返しに選べる位置が無くなる**（`wrapCuts` の注記）。
 * そこで「切ってよい位置」のうち、**その塊が語を割らずに折り返せる**ものを優先して選ぶ。
 * 見つからなければ従来どおりいちばん好ましい位置で切る（詰めるより割るほうがまだ読める、ではなく、
 * どちらも無理な入力＝1 語が長すぎる場合なので、ここで粘っても良くならない）。
 */
function splitByLength(
  text: string,
  [s, e]: Range,
  capacity: number,
  out: Range[],
  ctx: BreakContext,
  geom: LineGeometry,
): void {
  let pos = s;
  while (e - pos > geom.maxCharsPerLine) {
    // 残り全部が 1 字幕に収まり、かつ語を割らずに折り返せるなら、そこで終わり
    if (e - pos <= capacity && isWrappable(text, [pos, e], geom)) break;
    const cut = findChunkCut(text, pos, Math.min(e - 1, pos + capacity), ctx, geom);
    if (cut <= pos || cut >= e) break;
    out.push([pos, cut]);
    pos = cut;
  }
  if (e > pos) out.push([pos, e]);
}

/**
 * `pos` から始まる 1 字幕の終わりを選ぶ。好ましい区切りを長いほうから順に試し、
 * **語を割らずに折り返せる**最初のものを採る（純関数）。
 */
function findChunkCut(text: string, pos: number, hiLimit: number, ctx: BreakContext, geom: LineGeometry): number {
  const first = findBreak(text, pos + 1, hiLimit, hiLimit, ctx);
  if (first <= pos) return first;
  let hi = hiLimit;
  for (let guard = 0; guard < 64; guard++) {
    const cut = findBreak(text, pos + 1, hi, hi, ctx);
    if (cut <= pos) break;
    if (cut - pos <= geom.maxCharsPerLine || isWrappable(text, [pos, cut], geom)) return cut;
    hi = cut - 1;
    if (hi <= pos + 1) break;
  }
  return first;
}

/**
 * 1 文を字幕 1 枚に収まる区間へ割る（純関数）。
 * 文 → 読点 → 文字数、の順に緩めていく。
 */
export function chunkSentence(
  text: string,
  range: Range,
  capacity: number,
  ctx: BreakContext = {},
  geom: LineGeometry = { maxCharsPerLine: capacity, maxLines: 1 },
): Range[] {
  if (range[1] - range[0] <= capacity && isWrappable(text, range, geom)) return [range];
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
    if (r[1] - r[0] <= capacity && isWrappable(text, r, geom)) out.push(r);
    else splitByLength(text, r, capacity, out, ctx, geom);
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
 * 区切り位置の判定（`breakScore()`）は cue 境界と同じものを使う（D-21）。
 * 話者の間（ま）は渡さない: 行の切れ目は時間の切れ目ではないので、語境界と行の釣り合いだけで決める。
 */
export function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const body = text.trim();
  if (body === "") return [];
  if (body.length <= maxCharsPerLine) return [body];
  const { cuts } = wrapCuts(body, maxCharsPerLine, maxLines);
  const lines: string[] = [];
  let pos = 0;
  for (const cut of cuts) {
    lines.push(body.slice(pos, cut));
    pos = cut;
  }
  lines.push(body.slice(pos));
  return applyKinsoku(lines.map((l) => l.trim()).filter((l) => l !== ""));
}

/**
 * `wrapLines()` が入れる行の切れ目を返す（純関数）。`clean` は**すべての切れ目が語境界だった**か。
 *
 * 行の切れ目は「両側が `maxCharsPerLine` に収まる」範囲でしか選べない。字幕本文が容量ちょうど
 * （`maxCharsPerLine * maxLines`）まで詰まっていると選べる位置が 1 つしかなく、そこが語の途中でも
 * 割るしかなくなる（実素材で 2 行字幕 132 件のうち 15 件がこれだった）。
 * `clean` を見て cue 側を少し短く切り直すために、判定をここに出している。
 */
export function wrapCuts(body: string, maxCharsPerLine: number, maxLines: number): { cuts: number[]; clean: boolean } {
  const cuts: number[] = [];
  let clean = true;
  let pos = 0;
  while (pos < body.length) {
    const remaining = body.length - pos;
    if (cuts.length === maxLines - 1 || remaining <= maxCharsPerLine) break;
    const linesLeft = maxLines - cuts.length;
    // 残りが最後の行に収まるよう、ここより手前では切らない
    const minCut = Math.max(pos + 1, pos + remaining - (linesLeft - 1) * maxCharsPerLine);
    const target = pos + Math.min(maxCharsPerLine, Math.ceil(remaining / linesLeft));
    const cut = findBreak(body, minCut, pos + maxCharsPerLine, target);
    if (cut <= pos) break;
    if (breakScore(body, cut) < 0) clean = false;
    cuts.push(cut);
    pos = cut;
  }
  return { cuts, clean };
}

/** 1 字幕の本文が、語を割らずに `maxLines` 行へ折れるか */
function isWrappable(text: string, [s, e]: Range, geom: LineGeometry): boolean {
  const body = text.slice(s, e).trim();
  if (body.length <= geom.maxCharsPerLine) return true;
  return wrapCuts(body, geom.maxCharsPerLine, geom.maxLines).clean;
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

/**
 * トークン列を 1 本の文字列と、文字ごとの時刻・直前の無音へ展開する。
 * `gaps[i]` は `text[i]` の直前にあった無音（ms）。トークンの内側は 0（時刻を按分しているだけなので）。
 */
function expand(tokens: readonly TranscriptToken[]): { text: string; times: CharTime[]; gaps: number[] } {
  let text = "";
  const times: CharTime[] = [];
  const gaps: number[] = [];
  let prevEndMs: number | null = null;
  for (const t of tokens) {
    const chars = [...t.text];
    const span = Math.max(0, t.endMs - t.startMs);
    for (let k = 0; k < chars.length; k++) {
      text += chars[k];
      gaps.push(k === 0 && prevEndMs !== null ? Math.max(0, t.startMs - prevEndMs) : 0);
      times.push({
        startMs: t.startMs + (span * k) / chars.length,
        endMs: t.startMs + (span * (k + 1)) / chars.length,
      });
    }
    if (chars.length > 0) prevEndMs = t.endMs;
  }
  return { text, times, gaps };
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
  const pauseGapMs = Math.max(0, options.pauseGapMs ?? SUBTITLE_FORMAT_DEFAULTS.pauseGapMs);
  if (maxCharsPerLine < 1 || maxLines < 1) throw new Error("maxCharsPerLine and maxLines must be >= 1");
  const capacity = maxCharsPerLine * maxLines;

  const { text, times, gaps } = expand(cleanTokens(tokens));
  if (text.trim() === "") return [];

  // 切る／切らないを決める「間」より短い無音でも、**どこで切るか**を選ぶときの手がかりにはなる。
  // 実測（21 分の会議音声、5354 トークン境界）で無音の p95 が 280ms だったので、その少し上を取る。
  const ctx: BreakContext = { gaps, pauseHintMs: Math.round(pauseGapMs * 0.6) };

  const ranges: Range[] = [];
  for (const sentence of sentenceRanges(text)) {
    const trimmed = trimRange(text, sentence);
    if (trimmed === null) continue;
    for (const segment of pauseRanges(text, trimmed, gaps, pauseGapMs)) {
      const paused = trimRange(text, segment);
      if (paused === null) continue;
      for (const chunk of chunkSentence(text, paused, capacity, ctx, { maxCharsPerLine, maxLines })) {
        const r = trimRange(text, chunk);
        if (r !== null) ranges.push(r);
      }
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
