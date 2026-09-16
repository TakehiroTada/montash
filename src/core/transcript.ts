/**
 * 書き起こしトークンの保存・読み直しと、語の置換（純関数。docs/03 W-24, docs/04 §12）。
 *
 * 実地で分かったのはこうだ。whisper は固有名詞を外す（「フロントエンド運用」→「フロント演動」、
 * 「山笠」→「山傘」）。`--vocabulary`（エンジンの `--prompt`）を渡しても拾わないことがある。
 * それでも直せる経路は「SRT を人が開いて直す」しか無かった。**SRT は整形の結果**なので、
 * 語を 1 つ直すと 2 行 × 20 字の折り返しが崩れ、折り返しをやり直す手段が無い（実際
 * 「フロント演動」→「フロントエンド運用」で 2 文字増えて行があふれた）。
 *
 * そこで**整形前のトークン列**を扱えるようにする。ここが持つのは 2 つだけ:
 *
 *   1. **トークン列の保存形式**（`subtitle generate --save-transcript` / `--from-transcript`）。
 *      エンジンを再実行せずに整形だけやり直せる（21 分の会議で whisper は数分掛かる）。
 *   2. **語の置換**（`--replace "フロント演動=フロントエンド運用"`）。整形の**前**に当てるので、
 *      語が長くなっても `formatTranscript()` が折り返しをやり直す。
 *
 * **何を誤りと見なすかは montash が決めない**（docs/13 D-23 で引いた線と同じ）。置換規則を書くのは
 * 人（または人の指示を受けた AI）で、ここがやるのは言われたとおりに置き換えることだけ。
 * 辞書も推測も持たない。
 *
 * 外部プロセスにも I/O にも依存しない純関数として書き、単体テストで固定する
 * （`formatTranscript()` と同じ作法）。
 */
import { z } from "zod";
import { cleanTokens, type TranscriptToken } from "./subtitle-format.ts";

// ---------------------------------------------------------------------------
// 置換規則
// ---------------------------------------------------------------------------

/** 置換規則 1 つ。`from` を `to` にする。作るのは人で、montash は中身を判断しない */
export interface ReplaceRule {
  from: string;
  to: string;
}

/** 実際に何回当たったか（0 回なら規則が古いか綴りが違う。呼び出し側が警告する） */
export interface ReplaceStat extends ReplaceRule {
  count: number;
}

export interface ReplaceOutcome {
  tokens: TranscriptToken[];
  applied: ReplaceStat[];
}

/**
 * `"フロント演動=フロントエンド運用"` を 1 つの規則にする（純関数）。
 *
 * 区切りは**最初の `=`**（置換後の文字列に `=` が入っても困らないように）。
 * `to` は空でよい（語を丸ごと落とす）。`from` が空なら使い道が無いので `null` を返す。
 * カンマでは割らない: 置換後の文字列にカンマが入りうるので、複数指定は `--replace` を並べる。
 */
export function parseReplaceRule(input: string): ReplaceRule | null {
  const eq = input.indexOf("=");
  if (eq < 0) return null;
  const from = input.slice(0, eq).trim();
  const to = input.slice(eq + 1).trim();
  return from === "" ? null : { from, to };
}

/**
 * 置換規則のファイル（1 行 1 規則）を読む（純関数）。
 * `#` で始まる行と空行は無視する。人が手で書いて育てる前提の形。
 */
export function parseReplaceFile(text: string): { rules: ReplaceRule[]; invalid: { line: number; text: string }[] } {
  const rules: ReplaceRule[] = [];
  const invalid: { line: number; text: string }[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).trim();
    if (raw === "" || raw.startsWith("#")) continue;
    const rule = parseReplaceRule(raw);
    if (rule === null) invalid.push({ line: i + 1, text: raw });
    else rules.push(rule);
  }
  return { rules, invalid };
}

// ---------------------------------------------------------------------------
// 置換（時刻の割り当てがここの肝）
// ---------------------------------------------------------------------------

/** 1 文字ぶんの時刻。トークンの中は等分で按分する（`subtitle-format.ts` の expand() と同じ） */
interface CharSlot {
  ch: string;
  /** 元のトークン番号 */
  token: number;
  startMs: number;
  endMs: number;
}

/**
 * トークン列を文字ごとに展開する。トークンの内側の時刻は文字数で等分する
 * （エンジンは文字単位の時刻を返さないので、整形側（`formatTranscript()`）と同じ近似を使う）。
 */
function toChars(tokens: readonly TranscriptToken[]): CharSlot[] {
  const out: CharSlot[] = [];
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t] as TranscriptToken;
    const chars = [...token.text];
    const span = Math.max(0, token.endMs - token.startMs);
    for (let k = 0; k < chars.length; k++) {
      out.push({
        ch: chars[k] as string,
        token: t,
        startMs: token.startMs + (span * k) / chars.length,
        endMs: token.startMs + (span * (k + 1)) / chars.length,
      });
    }
  }
  return out;
}

/**
 * 置換に触れなかった文字を、**元のトークンのまま**（時刻をそのまま）戻す。
 * トークンの一部だけが残ったときは、その文字たちの按分した時刻で 1 トークンにする。
 */
function flush(buffer: readonly CharSlot[], tokens: readonly TranscriptToken[], out: TranscriptToken[]): void {
  let i = 0;
  while (i < buffer.length) {
    const token = (buffer[i] as CharSlot).token;
    let j = i;
    while (j < buffer.length && (buffer[j] as CharSlot).token === token) j++;
    const slice = buffer.slice(i, j);
    const original = tokens[token] as TranscriptToken;
    const text = slice.map((c) => c.ch).join("");
    // トークンを丸ごと残せたなら、元の時刻をそのまま使う（按分の誤差を持ち込まない）
    if (text === original.text) out.push({ ...original });
    else
      out.push({
        text,
        startMs: Math.round((slice[0] as CharSlot).startMs),
        endMs: Math.round((slice.at(-1) as CharSlot).endMs),
      });
    i = j;
  }
}

/**
 * 1 つの規則をトークン列に当てる（純関数）。
 *
 * **置換したトークンの時刻**: 置き換えた文字たちが占めていた時間をそのまま引き継ぐ。
 * 開始は「消えた最初の文字の開始」、終了は「消えた最後の文字の終了」。
 * 「フロント演動」（2 トークン、2400〜3200ms）を「フロントエンド運用」にすれば、
 * 新しい 1 トークンが 2400〜3200ms を占める。**文字数が変わっても話している時刻は動かない**ので、
 * 字幕の出るタイミングは置換の前後で変わらず、変わるのは折り返しだけになる。
 * 触れなかったトークンは 1 つも書き換えない（`flush()`）。
 *
 * 置換結果は再走査しない（`to` が `from` を含んでも無限には回らない）。
 */
function applyRule(
  tokens: readonly TranscriptToken[],
  rule: ReplaceRule,
): { tokens: TranscriptToken[]; count: number } {
  const chars = toChars(tokens);
  const needle = [...rule.from];
  const out: TranscriptToken[] = [];
  let buffer: CharSlot[] = [];
  let count = 0;
  let i = 0;
  // chars は「文字（コードポイント）」単位なので、検索も文字単位で行う（サロゲート対を割らない）
  while (i < chars.length) {
    if (matchesAt(chars, i, needle)) {
      flush(buffer, tokens, out);
      buffer = [];
      const first = chars[i] as CharSlot;
      const last = chars[i + needle.length - 1] as CharSlot;
      if (rule.to !== "")
        out.push({ text: rule.to, startMs: Math.round(first.startMs), endMs: Math.round(last.endMs) });
      i += needle.length;
      count++;
      continue;
    }
    buffer.push(chars[i] as CharSlot);
    i++;
  }
  flush(buffer, tokens, out);
  return { tokens: count === 0 ? tokens.map((t) => ({ ...t })) : out, count };
}

function matchesAt(chars: readonly CharSlot[], at: number, needle: readonly string[]): boolean {
  if (needle.length === 0 || at + needle.length > chars.length) return false;
  for (let k = 0; k < needle.length; k++) {
    if ((chars[at + k] as CharSlot).ch !== needle[k]) return false;
  }
  return true;
}

/**
 * 置換規則をトークン列へ順に当てる（純関数）。
 *
 * 規則は**渡された順**に当てる（前の規則の結果に次の規則が当たる）。トークンをまたぐ語も置換できる
 * （whisper は「フロント」「演動」のように語を割って返すので、これができないと役に立たない）。
 * 当たった回数を返すので、0 回の規則は呼び出し側が警告できる。
 *
 * 先に `cleanTokens()` を通す: `[_BEG_]` のような特殊トークンが語の間に挟まると一致しなくなるため。
 */
export function applyReplacements(tokens: readonly TranscriptToken[], rules: readonly ReplaceRule[]): ReplaceOutcome {
  let current = cleanTokens(tokens);
  const applied: ReplaceStat[] = [];
  for (const rule of rules) {
    const res = applyRule(current, rule);
    current = res.tokens;
    applied.push({ ...rule, count: res.count });
  }
  return { tokens: current, applied };
}

/** トークン列をそのまま繋いだ本文（保存した書き起こしを人／AI が読むため） */
export function transcriptText(tokens: readonly TranscriptToken[]): string {
  return tokens.map((t) => t.text).join("");
}

// ---------------------------------------------------------------------------
// 保存形式
// ---------------------------------------------------------------------------

export const TRANSCRIPT_FORMAT = "montash.transcript";
export const TRANSCRIPT_VERSION = 1;

const TokenSchema = z.object({
  text: z.string(),
  startMs: z.number().finite(),
  endMs: z.number().finite(),
});

const ReplaceStatSchema = z.object({ from: z.string(), to: z.string(), count: z.number().int().nonnegative() });

/**
 * 保存した書き起こし。**トークン列が本体**で、ほかは何をどう起こしたかの記録（読むときは使わない）。
 * `text` は読みやすさのための派生（AI が grep して誤認識を探すための窓口）で、読み込み時は無視する。
 */
export const TranscriptFileSchema = z.looseObject({
  format: z.literal(TRANSCRIPT_FORMAT),
  version: z.int().positive(),
  generated_at: z.string().optional(),
  engine: z.object({ path: z.string(), source: z.string() }).nullish(),
  model: z.string().nullish(),
  language: z.string().nullish(),
  vocabulary: z.array(z.string()).optional(),
  source: z.string().optional(),
  asset: z.string().nullish(),
  replacements: z.array(ReplaceStatSchema).optional(),
  text: z.string().optional(),
  tokens: z.array(TokenSchema),
});
export type TranscriptFile = z.infer<typeof TranscriptFileSchema>;

export interface TranscriptMeta {
  engine?: { path: string; source: string } | null;
  model?: string | null;
  language?: string | null;
  vocabulary?: readonly string[];
  source?: string;
  asset?: string | null;
  replacements?: readonly ReplaceStat[];
  generatedAt?: string;
}

/** 保存用の JSON 文字列を作る（純関数） */
export function serializeTranscript(tokens: readonly TranscriptToken[], meta: TranscriptMeta = {}): string {
  const file = {
    format: TRANSCRIPT_FORMAT,
    version: TRANSCRIPT_VERSION,
    generated_at: meta.generatedAt ?? new Date().toISOString(),
    engine: meta.engine ?? null,
    model: meta.model ?? null,
    language: meta.language ?? null,
    vocabulary: [...(meta.vocabulary ?? [])],
    source: meta.source ?? "",
    asset: meta.asset ?? null,
    replacements: [...(meta.replacements ?? [])],
    text: transcriptText(tokens),
    tokens: tokens.map((t) => ({ text: t.text, startMs: t.startMs, endMs: t.endMs })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** 保存した書き起こしを読む（純関数）。形が違えば `null` と理由を返す（呼び出し側がエラーにする） */
export function parseTranscript(raw: unknown): { file: TranscriptFile } | { error: string } {
  const parsed = TranscriptFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: issue === undefined ? "unexpected shape" : `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    };
  }
  if (parsed.data.version > TRANSCRIPT_VERSION)
    return { error: `version ${parsed.data.version} is newer than this montash understands (${TRANSCRIPT_VERSION})` };
  return { file: parsed.data };
}
