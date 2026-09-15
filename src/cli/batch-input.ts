/**
 * `montash batch` の入力（JSON Lines）の読み取り（docs/04 §16）。
 *
 * 1 行 1 コマンド。次の 3 つの書き方を受け付ける:
 *
 *   {"args": ["clip", "add", "--asset", "clip_a", "--at", "end"]}   ← 正（AI はこれを書く）
 *   ["clip", "add", "--asset", "clip_a", "--at", "end"]             ← 素の配列
 *   clip add --asset clip_a --at end                                ← 素の bash 行（先頭の montash は省略可）
 *
 * 空行と `#` で始まる行は読み飛ばす。解釈できない行は **1 行も実行する前に** `E_BATCH_PARSE` で
 * 失敗させる（途中まで実行してから構文エラーで止まるのが一番たちが悪いため）。
 */
import { MontashError } from "./errors.ts";

export interface BatchLine {
  /** ファイル中の行番号（1 始まり。人間・AI が直す場所を特定できるように） */
  line: number;
  /** 実行順（読み飛ばした行を除いた通し番号。1 始まり） */
  index: number;
  /** 元の行（トリム済み） */
  raw: string;
  /** montash に渡す引数列 */
  args: string[];
  /** 書式 */
  form: "json" | "shell";
}

const FORMAT_HINT =
  'Each line is one command: {"args": ["clip", "add", "--asset", "a", "--at", "end"]} ' +
  "or a plain shell line (`clip add --asset a --at end`). Blank lines and lines starting with # are ignored.";

function parseError(line: number, raw: string, message: string): MontashError {
  return new MontashError("E_BATCH_PARSE", `line ${line}: ${message}`, {
    hint: FORMAT_HINT,
    detail: { line, raw },
  });
}

/**
 * 素の bash 行を引数列に割る。`'...'` / `"..."` と `\` エスケープだけを解釈する
 * （変数展開・グロブ・パイプは意図的に扱わない。batch はシェルではない）。
 */
export function splitShellLine(raw: string, line: number): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (quote === null && (c === " " || c === "\t")) {
      if (started) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    if (c === "\\" && quote !== "'" && i + 1 < raw.length) {
      cur += raw[++i] as string;
      started = true;
      continue;
    }
    if (quote === null && (c === '"' || c === "'")) {
      quote = c;
      started = true;
      continue;
    }
    if (quote !== null && c === quote) {
      quote = null;
      continue;
    }
    cur += c;
    started = true;
  }
  if (quote !== null) throw parseError(line, raw, `unterminated ${quote === '"' ? "double" : "single"} quote`);
  if (started) out.push(cur);
  return out;
}

function toArgs(value: unknown, line: number, raw: string): string[] {
  if (typeof value === "string") return splitShellLine(value, line);
  if (!Array.isArray(value)) throw parseError(line, raw, '"args" must be an array of strings (or one command string)');
  return value.map((v) => {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    throw parseError(line, raw, `"args" must contain only strings (got ${JSON.stringify(v)})`);
  });
}

/** 1 行を引数列にする（空行・コメントは null） */
export function parseBatchLine(raw: string, line: number): { args: string[]; form: "json" | "shell" } | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw parseError(line, trimmed, `not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    const args = Array.isArray(parsed)
      ? toArgs(parsed, line, trimmed)
      : toArgs((parsed as { args?: unknown; cmd?: unknown }).args ?? (parsed as { cmd?: unknown }).cmd, line, trimmed);
    if (args.length === 0) throw parseError(line, trimmed, '"args" is empty');
    return { args, form: "json" };
  }

  const args = splitShellLine(trimmed, line);
  // `montash clip add ...` のように書かれていても受け付ける（人間がコピペする書き方）
  if (args[0] === "montash") args.shift();
  if (args.length === 0) throw parseError(line, trimmed, "no command on this line");
  return { args, form: "shell" };
}

/** ファイル全体を実行する行の列にする。空行・コメントは落とす */
export function parseBatchInput(text: string): BatchLine[] {
  const out: BatchLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] as string).replace(/\r$/, "");
    const parsed = parseBatchLine(raw, i + 1);
    if (parsed === null) continue;
    out.push({ line: i + 1, index: out.length + 1, raw: raw.trim(), args: parsed.args, form: parsed.form });
  }
  return out;
}
