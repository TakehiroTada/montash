/**
 * `GET /api/specs` から Inspector のフォームを組む純関数（docs/06 §2.5, §3.2, §3.6、計画 P3-2）。
 *
 * **Web にコマンド表もエフェクト表も持たない。** 表示する入力欄も、見せる CLI 例も、すべて
 * サーバが返す定義（= `montash schema` / `montash effect presets` と同じもの）から導出する。
 * これにより、プラグインが増やしたエフェクトやコマンドが **Web のコードを 1 行も変えずに** UI に出る
 * （docs/14「Web への UI プラグインコード投入はしない。フォームは spec 駆動のみ」）。
 *
 * React も DOM も触らない（tests/unit/web から直接呼べる）。
 */

import { formatCommand } from "./assets.ts";
import type { ClipLike } from "./timeline.ts";

export { formatCommand };

// ---------------------------------------------------------------------------
// `/api/specs` のレスポンス型（src/server/specs.ts と同じ形）
// ---------------------------------------------------------------------------

export type EffectTarget = "video" | "audio";

export interface EffectParamSpec {
  type: "number" | "string" | "boolean";
  describe: string;
  default?: number | string | boolean;
  min?: number;
  max?: number;
  choices?: string[];
  required?: boolean;
}

export interface EffectSpec {
  name: string;
  target: EffectTarget;
  /** builtin / project / plugin */
  source: string;
  summary: string;
  requires: string[];
  params: Record<string, EffectParamSpec>;
}

export interface CommandOptionSpec {
  type: "string" | "number" | "boolean" | "array";
  describe: string;
  choices?: string[];
  default?: unknown;
  required?: boolean;
  /** 時刻を受け取るオプション（秒 / HH:MM:SS.mmm / f:<frames>） */
  time?: boolean;
  alias?: string;
}

export interface CommandPositionalSpec {
  name: string;
  describe: string;
  type: "string" | "number";
  required?: boolean;
  variadic?: boolean;
  time?: boolean;
}

export interface CommandSpec {
  path: string;
  summary: string;
  description?: string;
  workflows: string[];
  mutates: boolean;
  positionals: CommandPositionalSpec[];
  options: Record<string, CommandOptionSpec>;
  examples: Array<{ cmd: string; note?: string }>;
}

export interface Specs {
  version: string;
  commands: CommandSpec[];
  effects: EffectSpec[];
}

// ---------------------------------------------------------------------------
// エフェクト
// ---------------------------------------------------------------------------

/**
 * そのクリップに掛かる効果の対象。音声トラックのクリップは音声効果、それ以外は映像効果
 * （`src/cli/commands/effect.ts` の `targetOfClip()` と同じ規則）。
 */
export function effectTargetOfTrack(trackKind: string | undefined): EffectTarget {
  return trackKind === "audio" ? "audio" : "video";
}

export function findEffectSpec(specs: Specs | null, target: EffectTarget, name: string): EffectSpec | null {
  return specs?.effects.find((e) => e.target === target && e.name === name) ?? null;
}

/** その対象に掛けられる効果（`effect add` の候補） */
export function availableEffects(specs: Specs | null, target: EffectTarget): EffectSpec[] {
  return specs?.effects.filter((e) => e.target === target) ?? [];
}

/** project.json の `effects[]` の 1 要素 */
export interface EffectRef {
  type: string;
  params?: Record<string, unknown>;
}

/** クリップの `effects[]`（壊れた値は落とす） */
export function clipEffects(clip: ClipLike | null | undefined): EffectRef[] {
  const raw = (clip as { effects?: unknown } | null | undefined)?.effects;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    if (typeof e !== "object" || e === null) return [];
    const type = (e as { type?: unknown }).type;
    if (typeof type !== "string") return [];
    const params = (e as { params?: unknown }).params;
    return [{ type, params: typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {} }];
  });
}

/** 1 つの効果の表示単位。`missing` は `effect list --json` の `missing: true` と同じ意味 */
export interface EffectView {
  /** `effects[]` の位置。`effect set <clip> <index>` の第 2 引数に使う（同名 2 回掛けでも一意） */
  index: number;
  type: string;
  params: Record<string, unknown>;
  spec: EffectSpec | null;
  /** レジストリに定義が無い = プラグイン不足 */
  missing: boolean;
}

export function effectViews(specs: Specs | null, clip: ClipLike | null, target: EffectTarget): EffectView[] {
  return clipEffects(clip).map((ref, index) => {
    const spec = findEffectSpec(specs, target, ref.type);
    return { index, type: ref.type, params: ref.params ?? {}, spec, missing: spec === null };
  });
}

// ---------------------------------------------------------------------------
// パラメータ → 入力欄
// ---------------------------------------------------------------------------

export type ControlKind = "slider" | "number" | "select" | "checkbox" | "text";

export interface EffectField {
  name: string;
  describe: string;
  control: ControlKind;
  /** 現在値（未設定なら既定値、既定値も無ければ型ごとの初期値） */
  value: number | string | boolean;
  /** project.json に実際に書かれているか（既定値の表示と区別する） */
  present: boolean;
  required: boolean;
  min?: number;
  max?: number;
  step?: number;
  choices?: string[];
}

/** スライダーの刻み。`max - min` の 1/100 を超えない「きりの良い」値を選ぶ */
const STEP_LADDER = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100];

/**
 * 刻み幅を決める。
 * min / max / default がすべて整数のパラメータ（`steps`, `size`, `sigma` など）は 1 刻みにする。
 * 整数かどうかを宣言する語彙が `EffectParamSpec` に無いための推定だが、外すと
 * `steps=1.5` のような ffmpeg が受け付けない値をスライダーが作ってしまうため、ここで潰しておく。
 */
export function sliderStep(p: EffectParamSpec): number {
  const min = p.min ?? 0;
  const max = p.max ?? 1;
  const integral =
    Number.isInteger(min) && Number.isInteger(max) && typeof p.default === "number" && Number.isInteger(p.default);
  if (integral) return 1;
  const target = (max - min) / 100;
  let step = STEP_LADDER[0] as number;
  for (const s of STEP_LADDER) if (s <= target) step = s;
  return step;
}

export function controlOf(p: EffectParamSpec): ControlKind {
  if (p.type === "boolean") return "checkbox";
  if (p.type === "string") return p.choices && p.choices.length > 0 ? "select" : "text";
  // number: 範囲が分かっているものだけスライダーにする（上限なしのスライダーは意味を成さない）
  return p.min !== undefined && p.max !== undefined ? "slider" : "number";
}

function initialValue(p: EffectParamSpec): number | string | boolean {
  if (p.default !== undefined) return p.default;
  if (p.type === "boolean") return false;
  if (p.type === "number") return p.min ?? 0;
  return p.choices?.[0] ?? "";
}

/**
 * 効果 1 つぶんの入力欄を、パラメータ定義の宣言順に組む。
 * 値は `params` にあればそれ、無ければ定義の既定値（`present: false` で区別できる）。
 */
export function effectFields(spec: EffectSpec, params: Readonly<Record<string, unknown>> = {}): EffectField[] {
  return Object.entries(spec.params).map(([name, p]) => {
    const raw = params[name];
    const present = raw !== undefined && typeof raw === p.type;
    const control = controlOf(p);
    return {
      name,
      describe: p.describe,
      control,
      value: present ? (raw as number | string | boolean) : initialValue(p),
      present,
      required: p.required === true,
      ...(p.min !== undefined ? { min: p.min } : {}),
      ...(p.max !== undefined ? { max: p.max } : {}),
      ...(control === "slider" ? { step: sliderStep(p) } : {}),
      ...(p.choices ? { choices: [...p.choices] } : {}),
    };
  });
}

/**
 * 未知のパラメータ（定義に無いのに project.json に書かれているもの）。
 * プラグインを外した状態でも値を失わないことを見せるため、読み取り専用で並べる。
 */
export function unknownParams(spec: EffectSpec | null, params: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(params).filter((k) => !spec || spec.params[k] === undefined);
}

// ---------------------------------------------------------------------------
// コマンドの組み立て（docs/06 §1.1: Web の状態変更は必ずコマンド発行）
// ---------------------------------------------------------------------------

/** 値をオプション引数に変える。boolean の false は yargs の否定形 `--no-<name>` */
export function paramFlag(name: string, value: number | string | boolean): string[] {
  if (typeof value === "boolean") return [value ? `--${name}` : `--no-${name}`];
  return [`--${name}`, String(value)];
}

/**
 * `effect set <clip> <index> --<param> <value>`。
 * 効果は**名前ではなく index** で指す（同じ効果を 2 回掛けたときに取り違えないため。
 * `effect set` は `/^\d+$/` を index として受ける）。
 */
export function effectSetArgs(
  clipId: string,
  effectIndex: number,
  param: string,
  value: number | string | boolean,
): string[] {
  return ["effect", "set", clipId, String(effectIndex), ...paramFlag(param, value)];
}

export function effectRemoveArgs(clipId: string, effectIndex: number): string[] {
  return ["effect", "remove", clipId, String(effectIndex)];
}

export function effectAddArgs(clipId: string, effect: string): string[] {
  return ["effect", "add", clipId, effect];
}

// ---------------------------------------------------------------------------
// 許可リスト（docs/06 §3.3）
// ---------------------------------------------------------------------------

/**
 * `GET /api/cli/allowlist` の照合。サーバの `checkAllowlist()` と同じ規則
 * （`args[0]`、または `args[0] args[1]` の一致）。
 */
export function isCommandAllowed(allowlist: readonly string[], path: string): boolean {
  const [a0, a1] = path.split(" ");
  if (a0 === undefined) return false;
  if (allowlist.includes(a0)) return true;
  return a1 !== undefined && allowlist.includes(`${a0} ${a1}`);
}

export interface EditabilityInput {
  allowlist: readonly string[];
  readOnly: boolean;
}

/**
 * そのコマンドを Web から実行できるか。できないなら入力を無効化して**理由を見せる**
 * （docs/06 §3.3。`serve --read-only`、または許可リストに無い場合）。
 */
export function commandDisabledReason(path: string, input: EditabilityInput): string | null {
  if (input.readOnly)
    return `サーバが --read-only で動作しているため、Web からは変更できません（montash ${path} をどうぞ）。`;
  if (!isCommandAllowed(input.allowlist, path))
    return `montash ${path} は Web の許可リストに無いため実行できません。CLI で実行してください。`;
  return null;
}

// ---------------------------------------------------------------------------
// CLI 例（docs/06 §3.6 は `/api/cli-examples` を `/api/specs` に置き換えた）
// ---------------------------------------------------------------------------

/** 第 1 位置引数がクリップ ID のコマンド（= 選択中のクリップに対して打てるコマンド） */
export function clipCommands(specs: Specs | null): CommandSpec[] {
  return (specs?.commands ?? []).filter((c) => {
    const first = c.positionals[0];
    return c.mutates && first !== undefined && /^clip IDs?$/i.test(first.describe.trim());
  });
}

/** そのコマンドが「別のクリップ」を値に取るオプションを持つか（例を埋められないので出さない） */
function referencesAnotherClip(spec: CommandSpec, tokens: readonly string[]): boolean {
  return tokens.some((t) => {
    if (!t.startsWith("--")) return false;
    const opt = spec.options[t.slice(2)];
    return opt !== undefined && opt.type === "string" && !opt.time && /\bclip\b/i.test(opt.describe);
  });
}

/**
 * 選択中のクリップに対する CLI 例を、**サーバから来たコマンド定義の `examples` から**組む。
 *
 *   - 第 1 位置引数（クリップ ID）を選択中の ID に差し替える
 *   - `time: true` のオプションの**絶対**時刻は再生ヘッド（`f:<n>`）に差し替える
 *     （`+0.5` のような相対指定はそのまま。意味が変わってしまうため）
 *   - `--json` は落とす（人間がコピーして打つための例なので）
 *   - 別のクリップ ID を要求する例（`clip move c3 --before c2`）は埋めようがないので出さない
 *
 * ハードコードしていたときと違い、`effect add` のようにあとから増えたコマンドも自動で並ぶ。
 */
export function clipCliExamples(specs: Specs | null, clipId: string, playheadF: number): string[] {
  const at = `f:${Math.max(0, Math.floor(Number.isFinite(playheadF) ? playheadF : 0))}`;
  const out: string[] = [];
  for (const spec of clipCommands(specs)) {
    const words = spec.path.split(" ");
    for (const example of spec.examples) {
      const tokens = example.cmd.split(/\s+/).filter(Boolean);
      if (tokens[0] !== "montash") continue;
      const rest = tokens.slice(1);
      if (words.some((w, i) => rest[i] !== w)) continue;
      const tail = rest.slice(words.length);
      if (referencesAnotherClip(spec, tail)) continue;

      const filled: string[] = [];
      let clipDone = false;
      for (let i = 0; i < tail.length; i++) {
        const token = tail[i] as string;
        if (token === "--json") continue;
        if (!clipDone && !token.startsWith("-")) {
          filled.push(clipId);
          clipDone = true;
          continue;
        }
        filled.push(token);
        // `--at 00:00:08.000` のような絶対時刻は再生ヘッドに寄せる
        const opt = token.startsWith("--") ? spec.options[token.slice(2)] : undefined;
        const value = tail[i + 1];
        if (opt?.time && value !== undefined && !value.startsWith("-")) {
          filled.push(value.startsWith("+") ? value : at);
          i++;
        }
      }
      if (!clipDone) continue;
      out.push(formatCommand([...words, ...filled]));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// クリップのプロパティ表示
// ---------------------------------------------------------------------------

export interface PropertyRow {
  key: string;
  value: string;
}

const HIDDEN_KEYS = new Set(["id", "effects"]);

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * クリップのプロパティ行。**種別ごとの固定リストを持たない**（持つと、プラグインが供給する
 * クリップやフィールドが画面から消える）。クリップが実際に持つキーをそのまま並べ、
 * サーバが計算した区間（`computed`）だけを先頭に足す。
 */
export function clipPropertyRows(
  clip: ClipLike,
  trackId: string,
  span: { start_f: number; end_f: number; duration_f: number },
): PropertyRow[] {
  const rows: PropertyRow[] = [
    { key: "track", value: trackId },
    { key: "start_f", value: String(span.start_f) },
    { key: "end_f", value: String(span.end_f) },
    { key: "duration_f", value: String(span.duration_f) },
  ];
  for (const key of Object.keys(clip).sort()) {
    if (HIDDEN_KEYS.has(key)) continue;
    if (key === "start_f") continue; // computed 側を正とする
    rows.push({ key, value: formatValue(clip[key]) });
  }
  return rows;
}
