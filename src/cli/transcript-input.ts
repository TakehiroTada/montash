/**
 * 書き起こしトークンの保存・読み直しと語の置換を、コマンドから使うための I/O 層（docs/03 W-24）。
 *
 * 判断は何も持たない。純関数は `core/transcript.ts` にあり、ここはファイルを読み書きして
 * `MontashError` に変換するだけ。`subtitle generate` と `suggest highlights` の両方が使う
 * （どちらも同じエンジンを回すので、1 度起こした書き起こしを使い回せると効く）。
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "../core/project.ts";
import type { TranscriptToken } from "../core/subtitle-format.ts";
import {
  parseReplaceFile,
  parseReplaceRule,
  parseTranscript,
  type ReplaceRule,
  type ReplaceStat,
  serializeTranscript,
  type TranscriptFile,
  type TranscriptMeta,
} from "../core/transcript.ts";
import type { OptionSpec } from "./define-command.ts";
import { ExitCode, errors, MontashError, type Warning, warning } from "./errors.ts";

/**
 * `subtitle generate` と `suggest highlights` で共通の 4 つ。
 * 「起こす」と「直す」を分けるのがこの 4 つの役目で、どちらのコマンドでも意味は同じ。
 */
export const TRANSCRIPT_OPTIONS: Record<string, OptionSpec> = {
  "save-transcript": {
    type: "string",
    describe: "also write the transcript tokens as JSON (reusable with --from-transcript)",
  },
  "from-transcript": {
    type: "string",
    describe: "read the tokens from a saved transcript instead of running the engine (no engine needed)",
  },
  replace: {
    type: "array",
    describe: 'fix a misheard word before formatting ("フロント演動=フロントエンド運用"; repeat for more)',
  },
  "replace-file": {
    type: "string",
    describe: "read replacements from a file (one `wrong=right` per line, `#` comments)",
  },
};

/**
 * `--replace` と `--replace-file` を 1 本の規則列にする。
 * 順序は **`--replace-file` の中身 → `--replace`**（コマンドラインで書いたほうが後に当たる）。
 */
export async function collectReplaceRules(input: {
  replace: unknown;
  replaceFile: string | undefined;
}): Promise<ReplaceRule[]> {
  const rules: ReplaceRule[] = [];
  if (input.replaceFile !== undefined) {
    const file = Bun.file(input.replaceFile);
    if (!(await file.exists()))
      throw new MontashError("E_REPLACE_FILE_NOT_FOUND", `replacement file not found: ${input.replaceFile}`, {
        hint: "Write one `wrong=right` per line (`#` starts a comment), or pass the rules with --replace.",
        exitCode: ExitCode.IO,
        detail: { path: input.replaceFile },
      });
    const { rules: parsed, invalid } = parseReplaceFile(await file.text());
    if (invalid.length > 0)
      throw errors.usage(
        `${input.replaceFile}:${invalid[0]?.line}: a replacement needs "wrong=right" (got "${invalid[0]?.text}")`,
        "One rule per line. The first `=` separates the two sides; lines starting with `#` are comments.",
      );
    rules.push(...parsed);
  }
  const list = input.replace === undefined ? [] : Array.isArray(input.replace) ? input.replace : [input.replace];
  for (const raw of list) {
    const rule = parseReplaceRule(String(raw));
    if (rule === null)
      throw errors.usage(
        `--replace needs "wrong=right" (got "${String(raw)}")`,
        'The first `=` separates the two sides: --replace "フロント演動=フロントエンド運用". Repeat the option for more.',
      );
    rules.push(rule);
  }
  return rules;
}

/** 保存した書き起こしを読む */
export async function loadTranscript(path: string): Promise<TranscriptFile> {
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw new MontashError("E_TRANSCRIPT_NOT_FOUND", `transcript not found: ${path}`, {
      hint: "Write one first with `montash subtitle generate --save-transcript <path>`.",
      exitCode: ExitCode.IO,
      detail: { path },
    });
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (e) {
    throw new MontashError("E_TRANSCRIPT_INVALID", `cannot parse ${path} as JSON`, {
      hint: "Pass a file written by `montash subtitle generate --save-transcript`.",
      cause: e,
      detail: { path },
    });
  }
  const parsed = parseTranscript(raw);
  if ("error" in parsed)
    throw new MontashError("E_TRANSCRIPT_INVALID", `${path} is not a montash transcript (${parsed.error})`, {
      hint: "Pass a file written by `montash subtitle generate --save-transcript`.",
      detail: { path, problem: parsed.error },
    });
  if (parsed.file.tokens.length === 0)
    throw new MontashError("E_TRANSCRIPT_EMPTY", `${path} has no tokens`, {
      hint: "Re-run the engine (`montash subtitle generate --save-transcript <path>`) on audio that has speech.",
      detail: { path },
    });
  return parsed.file;
}

/** 書き起こしトークンを保存する（`--save-transcript`） */
export async function saveTranscript(
  path: string,
  tokens: readonly TranscriptToken[],
  meta: TranscriptMeta,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, serializeTranscript(tokens, meta));
}

/** 1 度も当たらなかった規則は、綴り違いか当て済みかのどちらか。黙って捨てずに知らせる */
export function unusedRulesWarning(applied: readonly ReplaceStat[]): Warning | null {
  const unused = applied.filter((a) => a.count === 0);
  if (unused.length === 0) return null;
  return warning(
    "W_REPLACE_UNUSED",
    `${unused.length} replacement(s) matched nothing: ${unused.map((u) => `"${u.from}"`).join(", ")}`,
    {
      hint: "Check the spelling against the transcript itself (the `text` field of the saved transcript), or drop the rule.",
      detail: { unused: unused.map((u) => ({ from: u.from, to: u.to })) },
    },
  );
}
