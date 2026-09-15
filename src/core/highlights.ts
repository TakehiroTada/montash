/**
 * ハイライト候補の検出（純関数。docs/03 W-23, docs/04 §16 `suggest highlights`, docs/13 D-23）。
 *
 * 21 分の会議から切り抜きを作るとき、「どこを残すか」を決める材料が montash に何も無かった。
 * 結果として書き起こしを読んだ AI が独断で区間を選び、重要な話題を落としてやり直しになった（D-23）。
 * ここは **候補を出すだけ**で、タイムラインには触れない。決めるのは人（または人の指示を受けた AI）。
 *
 * 設計の芯:
 *   - **要約に LLM を使わない**。montash は ffmpeg と書き起こしエンジン以外の外部サービスに依存しない
 *     （docs/14「やらないこと」）。ここで返す「要約」は書き起こしの先頭の文と、その区間に偏って出る語
 *     （tf-idf）だけ。**判断材料であって判断ではない**ので、何を根拠に出したかを `evidence` に必ず載せる。
 *   - **I/O を持たない**。無音区間（silencedetect）と書き起こしトークンは呼び出し側が値で注入する
 *     （loudnorm / ducking / effect-analysis と同じ「I/O は graph の外」の作法）。
 *     おかげで whisper も ffmpeg も無しに単体テストできる。
 *
 * 検出に使うシグナル（すべて機械的に出せるもの）:
 *   1. **間（ま）** — 発話のあいだのギャップ。話題の変わり目は間が長い
 *   2. **語彙の移り変わり** — 前後の窓で使われる語の重なり（コサイン類似度）が落ちるところ
 *   3. **切り出しの語** — 「では」「次は」「続いて」のような話の頭に来る表現
 *   4. **発話密度** — 無音でない時間の割合（無音だらけの区間は切り抜きに向かない）
 */

import type { TranscriptToken } from "./subtitle-format.ts";
import { charClass } from "./subtitle-format.ts";

export type { TranscriptToken };

/** 無音区間（秒）。`ffmpeg/audio-analysis.ts` の `SilenceSpan` をそのまま渡せる形 */
export interface SilenceRange {
  from: number;
  to: number;
}

/** 検出の入力。すべて呼び出し側が測って値で渡す */
export interface HighlightInput {
  /** 素材（またはタイムライン）の長さ（秒） */
  duration: number;
  /** 書き起こしトークン（空でもよい。無い場合は無音区間だけで区切る） */
  tokens?: readonly TranscriptToken[];
  /** silencedetect が返した無音区間（空でもよい） */
  silence?: readonly SilenceRange[];
}

export interface HighlightOptions {
  /** 候補の最短の長さ（秒。既定 30） */
  minDuration?: number;
  /** 候補の最長の長さ（秒。既定 180）。これを超える塊は中で一番強い切れ目で割る */
  maxDuration?: number;
  /** この長さ以上の間を発話の切れ目とみなす（秒。既定 0.6） */
  pause?: number;
  /** 切れ目とみなす境界スコアのしきい値（0〜1。既定 0.35） */
  threshold?: number;
  /** 選ぶ候補の合計の長さの上限（秒）。null で上限なし */
  budget?: number | null;
  /** 選ぶ候補の本数の上限。null で上限なし */
  count?: number | null;
  /** 候補の前後に足す余白（秒。既定 0.3） */
  pad?: number;
  /** `lead`（先頭の文）の最大文字数（既定 60） */
  leadChars?: number;
  /** `keywords` の本数（既定 5） */
  keywords?: number;
}

export const HIGHLIGHT_DEFAULTS = {
  minDuration: 30,
  maxDuration: 180,
  pause: 0.6,
  threshold: 0.35,
  pad: 0.3,
  leadChars: 60,
  keywords: 5,
} as const;

/** 境界スコアの重み（合計 1.0）。実素材（21 分の朝ミーティング）で調整した */
const W_BOUNDARY = { pause: 0.45, lexical: 0.4, cue: 0.15 } as const;
/**
 * 候補スコアの重み（合計 1.0）。
 *
 * **このスコアは「面白さ」ではない。** 機械的に測れるのは「その区間がまとまって喋っているか」
 * までで、話の重要度は測れない（D-23 の前提どおり、決めるのは人）。実素材（21 分の朝ミーティング、
 * 人が選んだ 10 区間が正解）で各成分と「人が採用したか」の相関を測ると
 * 喋りの密度 r=0.46 / 語の偏り r=0.38 / 無音でない割合 r=0.21 / 切れ目のはっきりさ r=-0.08 だった。
 * 正解が 1 本ぶんしか無いので重みは**その順序に沿えている程度**にとどめ、深追いしない。
 */
const W_SEGMENT = { speech: 0.3, focus: 0.35, density: 0.2, edges: 0.15 } as const;
/** 喋りの密度の目安（1 秒あたりの文字数）。日本語の会話はおおむね 5〜7 文字/秒 */
const DENSITY_SATURATION = 6;
/** この長さの間で「間」のスコアが頭打ちになる（秒） */
const PAUSE_SATURATION = 2.0;
/** 語彙の比較に使う窓（秒）。前後それぞれこの長さぶんの発話を見る */
const LEXICAL_WINDOW = 45;

// ---------------------------------------------------------------------------
// 発話（utterance）
// ---------------------------------------------------------------------------

/** 間で区切った発話のひと塊 */
export interface Utterance {
  start: number;
  end: number;
  text: string;
  /** 先行する間の長さ（秒）。先頭は 0 */
  gapBefore: number;
}

/** whisper が混ぜる特殊トークン（`[_BEG_]` / `<|ja|>` など）と空白だけのトークンを落とす */
function cleanTokenText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  // `[_BEG_]` / `[_TT_325]`（whisper が混ぜる時刻トークン）など。放っておくと `lead` に出て読めなくなる
  if (/^\[_[A-Z0-9_]+\]$/.test(trimmed)) return "";
  if (/^<\|.*\|>$/.test(trimmed)) return "";
  return trimmed;
}

/**
 * トークン列を「間」で区切って発話にする（純関数）。
 * トークンが無いときは無音区間の補集合（＝鳴っているところ）を発話とみなす。
 */
export function toUtterances(input: HighlightInput, pause: number): Utterance[] {
  const tokens = (input.tokens ?? [])
    .map((t) => ({ ...t, text: cleanTokenText(t.text) }))
    .filter((t) => t.text !== "" && Number.isFinite(t.startMs) && Number.isFinite(t.endMs))
    .sort((a, b) => a.startMs - b.startMs);
  if (tokens.length === 0) return speechFromSilence(input, pause);

  const out: Utterance[] = [];
  for (const token of tokens) {
    const start = token.startMs / 1000;
    const end = Math.max(start, token.endMs / 1000);
    const last = out.at(-1);
    if (last && start - last.end < pause) {
      last.end = Math.max(last.end, end);
      last.text += token.text;
      continue;
    }
    out.push({ start, end, text: token.text, gapBefore: last ? Math.max(0, start - last.end) : 0 });
  }
  return out;
}

/** 書き起こしが無いときの代替: 無音でない区間を 1 発話とみなす */
function speechFromSilence(input: HighlightInput, pause: number): Utterance[] {
  const silence = [...(input.silence ?? [])].sort((a, b) => a.from - b.from);
  const out: Utterance[] = [];
  let cursor = 0;
  for (const span of silence) {
    if (span.from > cursor)
      out.push({ start: cursor, end: Math.min(span.from, input.duration), text: "", gapBefore: 0 });
    cursor = Math.max(cursor, span.to);
  }
  if (cursor < input.duration) out.push({ start: cursor, end: input.duration, text: "", gapBefore: 0 });
  const merged: Utterance[] = [];
  for (const span of out) {
    if (span.end - span.start <= 0) continue;
    const last = merged.at(-1);
    if (last && span.start - last.end < pause) {
      last.end = span.end;
      continue;
    }
    merged.push({ ...span, gapBefore: last ? span.start - last.end : 0 });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 語の取り出し（形態素解析は使わない）
// ---------------------------------------------------------------------------

/**
 * 日本語に空白は無いので、**同じ字種の連なり**を 1 語として取り出す（純関数）。
 * 「テックライブ」「多面観察」「AWS」のような固有名詞はこれで拾える。ひらがなは助詞・活用が
 * ほとんどなので落とす。形態素解析器は入れない（依存を増やさない方針）。
 */
export function extractTerms(text: string): string[] {
  const out: string[] = [];
  let run = "";
  let runClass = "";
  const flush = () => {
    if (run.length >= 2 && (runClass === "kanji" || runClass === "katakana" || runClass === "latin")) {
      if (!STOP_TERMS.has(run)) out.push(run);
    }
    run = "";
    runClass = "";
  };
  for (const ch of text) {
    const cls = charClass(ch);
    if (cls === runClass) {
      run += ch;
      continue;
    }
    flush();
    runClass = cls;
    run = ch;
  }
  flush();
  return out;
}

/** どの話題にも出るので手掛かりにならない語 */
const STOP_TERMS = new Set([
  "今日",
  "今回",
  "今週",
  "来週",
  "先週",
  "皆さん",
  "自分",
  "本当",
  "一応",
  "感じ",
  "話",
  "方",
  "的",
  "思",
  "言",
  "以上",
  "part",
  "the",
]);

function termCounts(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const term of extractTerms(text)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

/** 2 つの語の頻度ベクトルのコサイン類似度（どちらかが空なら 0） */
export function cosine(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [term, count] of a) {
    na += count * count;
    const other = b.get(term);
    if (other !== undefined) dot += count * other;
  }
  for (const count of b.values()) nb += count * count;
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 話の頭に来る表現。ここが来たら話題が変わった可能性が高い。
 * 「えー」「あの」のような filler は**入れない**（どこにでも出るので手掛かりにならない）。
 */
const CUE_PHRASES = [
  "それでは",
  "では",
  "じゃあ",
  "じゃ、",
  "続いて",
  "続きまして",
  "次に",
  "次は",
  "最後に",
  "あとは",
  "もう一つ",
  "もう1つ",
  "ということで",
  "はい、では",
  "以上です",
] as const;

/** 発話の頭が切り出しの語で始まるか（純関数） */
export function startsWithCue(text: string): string | null {
  const head = text.replace(/^[\s、。,.]+/, "").slice(0, 12);
  for (const cue of CUE_PHRASES) if (head.startsWith(cue)) return cue;
  return null;
}

// ---------------------------------------------------------------------------
// 境界の強さ
// ---------------------------------------------------------------------------

/** 発話 i と i+1 のあいだの切れ目。`index` は「i+1 の手前で切る」を意味する */
export interface Boundary {
  index: number;
  /** 秒（i の終わりと i+1 の始まりの中点ではなく、i+1 の始まり側に寄せる） */
  at: number;
  /** 間の長さ（秒） */
  gap: number;
  /** 語彙の移り変わり（0〜1。1 に近いほど前後で使う語が違う） */
  lexicalShift: number;
  /** 切り出しの語（無ければ null） */
  cue: string | null;
  /** 総合スコア（0〜1） */
  score: number;
}

/** すべての発話境界にスコアを付ける（純関数） */
export function scoreBoundaries(utterances: readonly Utterance[]): Boundary[] {
  const counts = utterances.map((u) => termCounts([u.text]));
  const out: Boundary[] = [];
  for (let i = 1; i < utterances.length; i++) {
    const prev = utterances[i - 1] as Utterance;
    const next = utterances[i] as Utterance;
    const gap = Math.max(0, next.start - prev.end);
    const before = windowCounts(utterances, counts, i - 1, -1);
    const after = windowCounts(utterances, counts, i, +1);
    const lexicalShift = before.size === 0 || after.size === 0 ? 0 : 1 - cosine(before, after);
    const cue = startsWithCue(next.text);
    const score =
      W_BOUNDARY.pause * Math.min(1, gap / PAUSE_SATURATION) +
      W_BOUNDARY.lexical * lexicalShift +
      W_BOUNDARY.cue * (cue === null ? 0 : 1);
    out.push({
      index: i,
      at: prev.end + gap / 2,
      gap: round(gap, 2),
      lexicalShift: round(lexicalShift, 3),
      cue,
      score: round(score, 3),
    });
  }
  return out;
}

/** i から step の向きに LEXICAL_WINDOW 秒ぶんの語を集める */
function windowCounts(
  utterances: readonly Utterance[],
  counts: readonly Map<string, number>[],
  from: number,
  step: 1 | -1,
): Map<string, number> {
  const anchor = utterances[from];
  if (anchor === undefined) return new Map();
  const edge = step === 1 ? anchor.start : anchor.end;
  const out = new Map<string, number>();
  for (let i = from; i >= 0 && i < utterances.length; i += step) {
    const u = utterances[i] as Utterance;
    const reach = step === 1 ? u.end - edge : edge - u.start;
    if (reach > LEXICAL_WINDOW && i !== from) break;
    for (const [term, n] of counts[i] as Map<string, number>) out.set(term, (out.get(term) ?? 0) + n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 区切る
// ---------------------------------------------------------------------------

/**
 * 強い境界から順に貪欲に割る（純関数）。
 *
 * 「しきい値を超えた境界で切る」を単純に前から順にやると、直後にもっと強い境界があっても
 * 先に切ってしまう。**強い順に採用し、min より短い塊を作る切れ目は捨てる**ことで、
 * 同じ入力からは必ず同じ割り方が出る（決定的）。
 */
export function splitByBoundaries(
  utterances: readonly Utterance[],
  boundaries: readonly Boundary[],
  opts: { minDuration: number; maxDuration: number; threshold: number },
): number[] {
  const total = utterances.at(-1);
  if (total === undefined) return [];
  const cuts: number[] = [];
  const spanOf = (from: number, to: number): number => {
    const a = utterances[from] as Utterance;
    const b = utterances[to - 1] as Utterance;
    return b.end - a.start;
  };
  const edges = () => [0, ...cuts, utterances.length];
  const fits = (index: number): boolean => {
    const list = edges();
    let lo = 0;
    for (const e of list) {
      if (e < index) lo = e;
      else if (e > index) return spanOf(lo, index) >= opts.minDuration && spanOf(index, e) >= opts.minDuration;
    }
    return false;
  };

  const strong = boundaries
    .filter((b) => b.score >= opts.threshold)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const b of strong) {
    if (cuts.includes(b.index)) continue;
    if (!fits(b.index)) continue;
    cuts.push(b.index);
    cuts.sort((x, y) => x - y);
  }

  // 長すぎる塊は、しきい値未満でも中で一番強い境界で割る（無いなら諦める）
  for (;;) {
    const list = edges();
    let split: number | null = null;
    for (let i = 0; i + 1 < list.length; i++) {
      const from = list[i] as number;
      const to = list[i + 1] as number;
      if (spanOf(from, to) <= opts.maxDuration) continue;
      const inside = boundaries
        .filter(
          (b) =>
            b.index > from &&
            b.index < to &&
            spanOf(from, b.index) >= opts.minDuration &&
            spanOf(b.index, to) >= opts.minDuration,
        )
        .sort((a, b) => b.score - a.score || a.index - b.index);
      const best = inside[0];
      if (best !== undefined) {
        split = best.index;
        break;
      }
    }
    if (split === null) break;
    cuts.push(split);
    cuts.sort((x, y) => x - y);
  }
  return cuts;
}

// ---------------------------------------------------------------------------
// 候補
// ---------------------------------------------------------------------------

/**
 * スコアの内訳。**「何を根拠にこの候補を出したか」を人が読むための欄**で、
 * これを見ずに `score` だけで選ばないための情報（D-23 の「決めるのは人」）。
 */
export interface HighlightEvidence {
  /** 直前の間の長さ（秒） */
  lead_silence_s: number;
  /** 直後の間の長さ（秒） */
  trail_silence_s: number;
  /** 始まりの境界での語彙の移り変わり（0〜1） */
  lexical_shift: number;
  /** 始まりの発話にあった切り出しの語 */
  cue: string | null;
  /** 発話の数 */
  utterances: number;
  /** 書き起こしの文字数 */
  chars: number;
  /** 1 秒あたりの文字数（喋りの密度） */
  chars_per_s: number;
  /** その区間に偏って出る語がどれだけあるか（0〜1。全候補のなかでの相対値） */
  topic_focus: number;
  /** 前後の切れ目のはっきりさ（0〜1） */
  edge_clarity: number;
  /** 喋りの密度（0〜1。`chars_per_s` を 6 文字/秒で頭打ちにしたもの） */
  density: number;
}

export interface HighlightCandidate {
  /** スコア順の順位（1 始まり） */
  rank: number;
  /** `--max` / `--count` の枠に入ったか */
  selected: boolean;
  start: number;
  end: number;
  duration: number;
  /** 0〜1。何で決まったかは `evidence` を見る */
  score: number;
  /** 無音でない時間の割合（0〜1） */
  speech_ratio: number;
  /** **要約ではない**。書き起こしの先頭の文をそのまま切り出したもの */
  lead: string;
  /** その区間に偏って出る語（tf-idf 順）。要約の代わりの手掛かり */
  keywords: string[];
  evidence: HighlightEvidence;
}

export interface HighlightResult {
  duration: number;
  /** 時刻順のすべての候補（`selected` で枠内かが分かる） */
  candidates: HighlightCandidate[];
  /** 選ばれた候補の合計の長さ（秒） */
  selected_duration: number;
  /** 使ったシグナル（書き起こしが無ければ transcript は false） */
  signals: { transcript: boolean; silence: boolean; utterances: number; boundaries: number };
  options: Required<Omit<HighlightOptions, "budget" | "count">> & { budget: number | null; count: number | null };
}

/** 無音区間から「鳴っている時間」を測る */
function speechRatio(silence: readonly SilenceRange[], start: number, end: number): number {
  const span = end - start;
  if (span <= 0) return 0;
  let quiet = 0;
  for (const s of silence) {
    const from = Math.max(s.from, start);
    const to = Math.min(s.to, end);
    if (to > from) quiet += to - from;
  }
  return round(Math.max(0, Math.min(1, 1 - quiet / span)), 3);
}

/** 書き起こしの先頭の文（句点まで、無ければ leadChars 文字まで）。要約ではない */
export function leadSentence(text: string, maxChars: number): string {
  const body = text.replace(/^[\s、。,.]+/, "");
  const chars = [...body];
  for (let i = 0; i < chars.length && i < maxChars; i++) {
    if ("。！？!?".includes(chars[i] as string)) return chars.slice(0, i + 1).join("");
  }
  if (chars.length <= maxChars) return body;
  return `${chars.slice(0, maxChars).join("")}…`;
}

/**
 * 区間に偏って出る語を tf-idf で選ぶ（全区間の語の分布と比べる）。
 * 返す `mass` は上位 `limit` 語の重みの合計で、「この区間は何かの話題に寄っている」度合いに使う。
 */
function keywordsFor(
  counts: ReadonlyMap<string, number>,
  documentFrequency: ReadonlyMap<string, number>,
  documents: number,
  limit: number,
): { terms: string[]; mass: number } {
  const scored: { term: string; weight: number }[] = [];
  for (const [term, tf] of counts) {
    const df = documentFrequency.get(term) ?? 1;
    const idf = Math.log((documents + 1) / (df + 0.5));
    if (idf <= 0) continue;
    scored.push({ term, weight: tf * idf * Math.min(1, term.length / 2) });
  }
  scored.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
  const top = scored.slice(0, limit);
  return { terms: top.map((s) => s.term), mass: top.reduce((sum, s) => sum + s.weight, 0) };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * ハイライト候補を返す（この関数が本体）。**タイムラインには触れない。**
 *
 * 呼び出し側は無音区間（silencedetect）と書き起こしトークンを測って渡すだけでよい。
 */
export function suggestHighlights(input: HighlightInput, options: HighlightOptions = {}): HighlightResult {
  const opts = {
    minDuration: options.minDuration ?? HIGHLIGHT_DEFAULTS.minDuration,
    maxDuration: options.maxDuration ?? HIGHLIGHT_DEFAULTS.maxDuration,
    pause: options.pause ?? HIGHLIGHT_DEFAULTS.pause,
    threshold: options.threshold ?? HIGHLIGHT_DEFAULTS.threshold,
    pad: options.pad ?? HIGHLIGHT_DEFAULTS.pad,
    leadChars: options.leadChars ?? HIGHLIGHT_DEFAULTS.leadChars,
    keywords: options.keywords ?? HIGHLIGHT_DEFAULTS.keywords,
    budget: options.budget ?? null,
    count: options.count ?? null,
  };
  const silence = [...(input.silence ?? [])].sort((a, b) => a.from - b.from);
  const utterances = toUtterances(input, opts.pause);
  const hasTranscript = (input.tokens ?? []).length > 0;
  const empty: HighlightResult = {
    duration: round(input.duration, 3),
    candidates: [],
    selected_duration: 0,
    signals: { transcript: hasTranscript, silence: silence.length > 0, utterances: utterances.length, boundaries: 0 },
    options: opts,
  };
  if (utterances.length === 0) return empty;

  const boundaries = scoreBoundaries(utterances);
  const cuts = splitByBoundaries(utterances, boundaries, opts);
  const edges = [0, ...cuts, utterances.length];
  const byIndex = new Map(boundaries.map((b) => [b.index, b]));

  // --- 区間ごとの語の分布（tf-idf の df を作るため先に全部数える） ---
  const groups: { from: number; to: number; counts: Map<string, number> }[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i] as number;
    const to = edges[i + 1] as number;
    groups.push({ from, to, counts: termCounts(utterances.slice(from, to).map((u) => u.text)) });
  }
  const df = new Map<string, number>();
  for (const g of groups) for (const term of g.counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);

  // --- 区間ごとの素の測定値 ---
  const measured = groups.map((g) => {
    const first = utterances[g.from] as Utterance;
    const last = utterances[g.to - 1] as Utterance;
    const start = Math.max(0, first.start - opts.pad);
    const end = Math.min(input.duration, last.end + opts.pad);
    const duration = Math.max(0, end - start);
    const startBoundary = byIndex.get(g.from);
    const endBoundary = byIndex.get(g.to);
    const leadGap = g.from === 0 ? Number.POSITIVE_INFINITY : (startBoundary?.gap ?? 0);
    const trailGap = g.to === utterances.length ? Number.POSITIVE_INFINITY : (endBoundary?.gap ?? 0);
    const text = utterances
      .slice(g.from, g.to)
      .map((u) => u.text)
      .join("");
    const keywords = keywordsFor(g.counts, df, groups.length, opts.keywords);
    return {
      g,
      start,
      end,
      duration,
      startBoundary,
      leadGap,
      trailGap,
      text,
      keywords,
      ratio: silence.length > 0 ? speechRatio(silence, start, end) : 1,
      chars: [...text].length,
    };
  });
  // 話題の寄り具合は絶対値に意味が無い（語数は長さに比例する）ので、
  // **1 秒あたりの重み**にしたうえで全候補のなかの相対値にする
  const focusRaw = measured.map((m) => (m.duration > 0 ? m.keywords.mass / m.duration : 0));
  const focusMax = Math.max(...focusRaw, 1e-9);

  // --- 候補を組み立てる ---
  const raw = measured.map((m, i) => {
    const topicFocus = round(Math.min(1, (focusRaw[i] as number) / focusMax), 3);
    const edgeClarity = round(
      (Math.min(1, Math.min(m.leadGap, PAUSE_SATURATION) / PAUSE_SATURATION) +
        Math.min(1, Math.min(m.trailGap, PAUSE_SATURATION) / PAUSE_SATURATION)) /
        2,
      3,
    );
    const charsPerS = m.duration > 0 ? m.chars / m.duration : 0;
    const density = round(Math.min(1, charsPerS / DENSITY_SATURATION), 3);
    const score =
      W_SEGMENT.speech * m.ratio +
      W_SEGMENT.focus * topicFocus +
      W_SEGMENT.density * density +
      W_SEGMENT.edges * edgeClarity;
    return {
      start: round(m.start, 3),
      end: round(m.end, 3),
      duration: round(m.duration, 3),
      score: round(score, 3),
      speech_ratio: m.ratio,
      lead: leadSentence(m.text, opts.leadChars),
      keywords: m.keywords.terms,
      evidence: {
        lead_silence_s: Number.isFinite(m.leadGap) ? round(m.leadGap, 2) : round(m.start, 2),
        trail_silence_s: Number.isFinite(m.trailGap) ? round(m.trailGap, 2) : round(input.duration - m.end, 2),
        lexical_shift: m.startBoundary?.lexicalShift ?? 0,
        cue: m.startBoundary?.cue ?? null,
        utterances: m.g.to - m.g.from,
        chars: m.chars,
        chars_per_s: round(charsPerS, 2),
        topic_focus: topicFocus,
        edge_clarity: edgeClarity,
        density,
      },
    };
  });

  // --- 順位づけと枠の適用（選ぶのは人なので、枠の外の候補も消さずに返す） ---
  const order = [...raw.keys()].sort((a, b) => {
    const x = raw[a] as (typeof raw)[number];
    const y = raw[b] as (typeof raw)[number];
    return y.score - x.score || x.start - y.start;
  });
  const selected = new Set<number>();
  let used = 0;
  for (const i of order) {
    const item = raw[i] as (typeof raw)[number];
    if (opts.count !== null && selected.size >= opts.count) break;
    if (opts.budget !== null && used + item.duration > opts.budget) continue;
    selected.add(i);
    used += item.duration;
  }
  const rankOf = new Map(order.map((idx, r) => [idx, r + 1]));

  const candidates: HighlightCandidate[] = raw.map((item, i) => ({
    rank: rankOf.get(i) as number,
    selected: selected.has(i),
    ...item,
  }));

  return {
    duration: round(input.duration, 3),
    candidates,
    selected_duration: round(used, 3),
    signals: {
      transcript: hasTranscript,
      silence: silence.length > 0,
      utterances: utterances.length,
      boundaries: boundaries.length,
    },
    options: opts,
  };
}
