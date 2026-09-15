/**
 * トランジションレジストリ（`docs/plans/2026-09-15-plugin-architecture.md` P1-4、docs/05 §7、docs/07 §4.2）。
 *
 * トランジションは **すでに実質開いている**: `tr.type` は `xfade=transition=` にそのまま渡されていて、
 * montash 側が種類を知っている必要は無い（グラフの形は種類によらず同じ）。
 * したがってこのレジストリは「種類を閉じる」ためのものではなく、散らばっていた 3 つを 1 か所に集めるためのもの:
 *
 *   1. **別名表**（`crossfade` → `fade`）。従来は `cli/commands/transition.ts` にベタ書きで、
 *      CLI を通さずに書かれた `project.json` では解決されなかった
 *   2. **パラメータの検査**。従来は `graph/transitions.ts` の 1 本のホワイトリスト
 *      （`/^[A-Za-z0-9_.+*\/() -]*$/`）だけで、色（`#rrggbb` の `#`）も式（`,` を含む）も渡せなかった
 *   3. **`requires`**（`xfade`）。`doctor` の検査対象に載せる
 *
 * **未登録の `type` は従来どおり `xfade` へ素通しする**（後方互換）。ffmpeg の `xfade` は 50 種以上を持ち、
 * その一覧は ffmpeg のバージョンで増える。本体に列挙を抱えると二重管理になるうえ、
 * 「今まで動いていた `--type` が通らなくなる」破壊的変更になる。クリップ種別（D-14）と違い、
 * **本体が知らなくても ffmpeg がグラフを解釈できる**ので、レンダーを止める理由が無い。
 * 登録済みの種類は「別名・パラメータ仕様・`requires` が付いているもの」という位置づけ。
 *
 * このモジュールは純関数だけを持つ（`node:fs` / `Bun.spawn` を import しない）。
 */
import { MontashError } from "../cli/errors.ts";
import { createRegistry, type Registry } from "./index.ts";
import { registerRequirements } from "./requirements.ts";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/**
 * `transitions[].params` の 1 件。`xfade` のオプションにそのまま渡る。
 *
 * - `number`: 数値
 * - `string`: 従来と同じ許可文字（英数字と簡単な算術）
 * - `color`: `#rrggbb` / `#rrggbbaa` / 色名
 * - `expr`: ffmpeg の式。`,` や `:` を含むのでシングルクォートで包んで渡す
 */
export type TransitionParamType = "number" | "string" | "color" | "expr";

export interface TransitionParamSpec {
  type: TransitionParamType;
  describe: string;
  min?: number;
  max?: number;
  choices?: readonly string[];
  required?: boolean;
}

export interface TransitionSpec {
  name: string;
  summary: string;
  /** 別名なら正規名（`xfade=transition=` にはこちらを渡す）。正規エントリでは undefined */
  aliasOf?: string;
  params?: Record<string, TransitionParamSpec>;
  /** 必要な ffmpeg フィルタ（`doctor` が検査する） */
  requires?: readonly string[];
}

/** xfade の transition 名として受理する形（従来 `cli/commands/transition.ts` にあった検査） */
export const TRANSITION_NAME_RE = /^[a-z][a-z0-9_]*$/;

export function defineTransition(spec: TransitionSpec): TransitionSpec {
  if (!TRANSITION_NAME_RE.test(spec.name)) throw new Error(`invalid transition name: "${spec.name}"`);
  return { requires: ["xfade"], ...spec };
}

// ---------------------------------------------------------------------------
// 組み込みトランジション
//
// docs/04 §8 が `--type` の例として挙げている種類 + `custom`（式を渡すもの）。
// ffmpeg が持つ残りの xfade も **素通しでそのまま使える**（上のコメント参照）。
// ---------------------------------------------------------------------------

interface BuiltinEntry {
  name: string;
  summary: string;
  aliases?: readonly string[];
  params?: Record<string, TransitionParamSpec>;
}

const BUILTIN_LIST: readonly BuiltinEntry[] = [
  { name: "fade", summary: "cross dissolve between the two clips", aliases: ["crossfade"] },
  { name: "fadeblack", summary: "fade down to black, then up" },
  { name: "fadewhite", summary: "fade up to white, then down" },
  { name: "dissolve", summary: "random-pixel dissolve" },
  { name: "wipeleft", summary: "wipe towards the left" },
  { name: "wiperight", summary: "wipe towards the right" },
  { name: "wipeup", summary: "wipe towards the top" },
  { name: "wipedown", summary: "wipe towards the bottom" },
  { name: "slideleft", summary: "slide the new clip in from the right" },
  { name: "slideright", summary: "slide the new clip in from the left" },
  { name: "slideup", summary: "slide the new clip in from the bottom" },
  { name: "slidedown", summary: "slide the new clip in from the top" },
  { name: "circleopen", summary: "opening circular iris" },
  { name: "circleclose", summary: "closing circular iris" },
  { name: "pixelize", summary: "pixelate out and back in" },
  { name: "radial", summary: "radial sweep" },
  {
    name: "custom",
    summary: "an xfade expression supplied in params.expr",
    params: {
      expr: { type: "expr", describe: "xfade expression over A, B, X, Y, W, H, P", required: true },
    },
  },
];

function buildBuiltins(): Record<string, TransitionSpec> {
  const out: Record<string, TransitionSpec> = {};
  for (const entry of BUILTIN_LIST) {
    const spec = defineTransition({
      name: entry.name,
      summary: entry.summary,
      ...(entry.params ? { params: entry.params } : {}),
    });
    out[entry.name] = spec;
    for (const alias of entry.aliases ?? [])
      out[alias] = defineTransition({ ...spec, name: alias, aliasOf: entry.name, summary: `alias of ${entry.name}` });
  }
  return out;
}

const BUILTIN_TRANSITIONS = buildBuiltins();

// ---------------------------------------------------------------------------
// レジストリ
// ---------------------------------------------------------------------------

export const transitions: Registry<TransitionSpec> = createRegistry<TransitionSpec>({
  label: "transition",
  sorted: true,
  builtin: BUILTIN_TRANSITIONS,
  notFound: (name, known) =>
    new MontashError("E_PLUGIN_MISSING", `unknown transition '${name}'`, {
      hint: `Known transitions: ${known.join(", ")}.`,
      detail: { transition: name, known: [...known] },
    }),
});

// 組み込みが必要とする ffmpeg フィルタを `doctor` の検査対象に載せる（`xfade`）
for (const spec of Object.values(BUILTIN_TRANSITIONS))
  if (spec.requires?.length) registerRequirements(`transition:${spec.name}`, { filters: spec.requires }, "builtin");

/** 組み込み・プラグインを登録する。`requires` は `doctor` の検査対象に合成される */
export function registerTransition(spec: TransitionSpec, source: "builtin" | "plugin" = "builtin"): void {
  transitions.register(spec.name, spec, source);
  if (spec.requires && spec.requires.length > 0)
    registerRequirements(`transition:${spec.name}`, { filters: spec.requires }, source);
}

/** 正規名（`--help` と hint に出す一覧）。別名は含まない */
export const TRANSITION_NAMES: readonly string[] = BUILTIN_LIST.map((e) => e.name);

// ---------------------------------------------------------------------------
// 別名の解決
// ---------------------------------------------------------------------------

/**
 * 別名を正規名にする。**未登録の名前はそのまま返す**（素通し）。
 * CLI（保存時）とグラフ組み立て（レンダー時）の両方から呼ぶので、
 * CLI を通さずに書かれた `project.json` の `"type": "crossfade"` も正しく `fade` になる。
 */
export function resolveTransitionType(name: string): string {
  return transitions.get(name)?.aliasOf ?? name;
}

/** 正規化済みの名前で仕様を引く（未登録なら undefined） */
export function transitionSpec(name: string): TransitionSpec | undefined {
  const spec = transitions.get(name);
  if (!spec) return undefined;
  return spec.aliasOf ? transitions.get(spec.aliasOf) : spec;
}

// ---------------------------------------------------------------------------
// パラメータ
// ---------------------------------------------------------------------------

/** 仕様を持たないパラメータの許可文字（従来の検査をそのまま残したもの） */
const PLAIN_VALUE_RE = /^[A-Za-z0-9_.+*/() -]*$/;
const COLOR_VALUE_RE = /^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|[a-zA-Z]+)$/;
/** 式に許す文字。`'` と `\` は ffmpeg のクォートを壊すので除く */
const EXPR_VALUE_RE = /^[A-Za-z0-9_.,:;+\-*/()<>=!&|?%^ ]*$/;

function paramError(transitionId: string, message: string, hint?: string): MontashError {
  return new MontashError("E_USAGE", `transition "${transitionId}": ${message}`, {
    ...(hint !== undefined ? { hint } : {}),
  });
}

/**
 * `params` の 1 件を `key=value` の `value` にする（純関数）。
 *
 * 仕様が無いパラメータは**従来とまったく同じ検査・同じ文面**で通す（既存の出力を変えないため）。
 * 仕様があるものだけ型に応じて広げる（色の `#`、式の `,` / `:`）。
 */
export function transitionParamText(
  transitionId: string,
  key: string,
  value: unknown,
  spec: TransitionParamSpec | undefined,
): string {
  const text = typeof value === "number" || typeof value === "boolean" ? String(value) : String(value ?? "");
  if (!spec) {
    if (!PLAIN_VALUE_RE.test(text))
      throw paramError(
        transitionId,
        `parameter "${key}" has unsupported characters`,
        "xfade parameters may only contain letters, digits and simple arithmetic.",
      );
    return text;
  }
  switch (spec.type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(text);
      if (!Number.isFinite(n)) throw paramError(transitionId, `parameter "${key}" must be a number`);
      if (spec.min !== undefined && n < spec.min)
        throw paramError(transitionId, `parameter "${key}" must be >= ${spec.min}`);
      if (spec.max !== undefined && n > spec.max)
        throw paramError(transitionId, `parameter "${key}" must be <= ${spec.max}`);
      return String(n);
    }
    case "color":
      if (!COLOR_VALUE_RE.test(text))
        throw paramError(
          transitionId,
          `parameter "${key}" is not a colour`,
          "Use #rrggbb, #rrggbbaa or a colour name.",
        );
      return text;
    case "expr":
      if (!EXPR_VALUE_RE.test(text))
        throw paramError(
          transitionId,
          `parameter "${key}" has unsupported characters`,
          "Expressions may not contain quotes or backslashes.",
        );
      // ffmpeg のフィルタ記述では `,` と `:` が区切りなので、式はシングルクォートで包む
      return `'${text}'`;
    default:
      if (spec.choices && !spec.choices.includes(text))
        throw paramError(transitionId, `parameter "${key}" must be one of: ${spec.choices.join(", ")}`);
      if (!PLAIN_VALUE_RE.test(text))
        throw paramError(
          transitionId,
          `parameter "${key}" has unsupported characters`,
          "xfade parameters may only contain letters, digits and simple arithmetic.",
        );
      return text;
  }
}

/**
 * `params` を `:key=value` の並びにする（純関数。先頭にも `:` が付く。空なら空文字）。
 * 登録済みの種類で `required` なパラメータが欠けていれば `E_USAGE`。
 */
export function transitionParamsSuffix(
  transitionId: string,
  type: string,
  params: Readonly<Record<string, unknown>>,
): string {
  const spec = transitionSpec(resolveTransitionType(type));
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new MontashError("E_USAGE", `transition "${transitionId}": invalid parameter name ${JSON.stringify(key)}`);
    parts.push(`${key}=${transitionParamText(transitionId, key, value, spec?.params?.[key])}`);
  }
  for (const [key, p] of Object.entries(spec?.params ?? {}))
    if (p.required && params[key] === undefined)
      throw paramError(transitionId, `type "${type}" needs params.${key}`, p.describe);
  return parts.length ? `:${parts.join(":")}` : "";
}
