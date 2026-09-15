/**
 * エフェクトレジストリ（docs/13 D-15、`docs/plans/2026-09-15-plugin-architecture.md` P0-3）。
 *
 * montash のエフェクトは **ピクセルを触らない**。`params` から **ffmpeg のフィルタ片を返す純関数**
 * （`build()`）として定義し、レンダー時にクリップのフィルタチェーンへ差し込む（14 章の方針）。
 * これにより:
 *   - `preview` のセグメントキャッシュは `filterComplex` 由来の指紋なので**自動的に正しく無効化**される
 *   - `--dry-run` でそのままフィルタ文字列を確認できる
 *   - `graph/` の純粋性（`node:fs` も `Bun.spawn` も持ち込まない）が保たれる
 *
 * 組み込みのエフェクトも**例外なくこのレジストリを通す**（`color` が最初の実例）。
 * プラグインからの登録経路は Phase 2 で、`register(name, spec, "plugin")` を呼ぶのがローダになる。
 *
 * I/O を要するエフェクト（事前解析が必要なもの）は、ダッキングや loudnorm と同じく
 * 「解析結果を値で `GraphOptions` に注入する」形にする（Phase 2 の Level C）。
 */
import { MontashError } from "../cli/errors.ts";
import type { Fps, Resolution } from "../core/schema.ts";
import { createRegistry, type Registry } from "./index.ts";
import { registerRequirements } from "./requirements.ts";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

export type EffectTarget = "video" | "audio";

/**
 * パラメータ定義。これ 1 つから CLI オプション・`schema`・`help`・Web のフォームを導出する
 * （AviUtl の「トラックバーを登録すると UI が出る」に相当。Phase 1 で `effect` コマンドが使う）。
 */
export interface EffectParamSpec {
  type: "number" | "string" | "boolean";
  describe: string;
  default?: number | string | boolean;
  /** number のとき */
  min?: number;
  max?: number;
  /** string のとき */
  choices?: readonly string[];
  required?: boolean;
}

/** `build()` に渡る読み取り専用の文脈（I/O は一切渡さない） */
export interface EffectBuildContext {
  fps: Fps;
  resolution: Resolution;
  /** クリップがタイムライン上で占めるフレーム数 */
  frames: number;
  /** 音声のサンプルレート */
  sampleRate: number;
}

export interface EffectSpec {
  name: string;
  target: EffectTarget;
  summary: string;
  params?: Record<string, EffectParamSpec>;
  /** 必要な ffmpeg フィルタ（`doctor` が検査する） */
  requires?: readonly string[];
  /**
   * パラメータ → フィルタ片の配列（純関数）。
   * 受け取る `params` は既定値の適用と範囲検査が済んでいる。
   */
  build(params: Readonly<Record<string, unknown>>, ctx: EffectBuildContext): string[];
}

export function defineEffect(spec: EffectSpec): EffectSpec {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new Error(`invalid effect name: "${spec.name}"`);
  return spec;
}

// ---------------------------------------------------------------------------
// レジストリ
// ---------------------------------------------------------------------------

function notFound(target: EffectTarget) {
  return (name: string, known: readonly string[]): MontashError =>
    new MontashError("E_PLUGIN_MISSING", `unknown ${target} effect '${name}'`, {
      hint:
        known.length > 0
          ? `No registered plugin provides it. Known ${target} effects: ${known.join(", ")}.`
          : "No registered plugin provides it.",
      detail: { effect: name, target, known: [...known] },
    });
}

// ---------------------------------------------------------------------------
// 組み込みエフェクト
//
// **組み込みも外部プラグインとまったく同じ契約で書く**（`defineEffect` + 純関数の `build()`）。
// こうしておくと契約が常に実コードで検証され、「組み込みだけができること」が生まれない。
// ---------------------------------------------------------------------------

/**
 * 色補正。`clip.video.color` の実体でもある（従来 `graph/video.ts` の `colorFilter()` にあったもの）。
 * 出力は従来と 1 文字も変えない: 指定されたキーだけを固定順に並べた `eq=`。
 */
export const colorEffect: EffectSpec = defineEffect({
  name: "color",
  target: "video",
  summary: "adjust brightness / contrast / saturation / gamma (eq)",
  requires: ["eq"],
  params: {
    brightness: { type: "number", describe: "-1.0 .. 1.0", min: -1, max: 1 },
    contrast: { type: "number", describe: "-1000 .. 1000 (1.0 = unchanged)", min: -1000, max: 1000 },
    saturation: { type: "number", describe: "0.0 .. 3.0 (1.0 = unchanged)", min: 0, max: 3 },
    gamma: { type: "number", describe: "0.1 .. 10.0 (1.0 = unchanged)", min: 0.1, max: 10 },
  },
  build(params) {
    const parts = (["brightness", "contrast", "saturation", "gamma"] as const)
      .filter((k) => typeof params[k] === "number")
      .map((k) => `${k}=${params[k] as number}`);
    return parts.length > 0 ? [`eq=${parts.join(":")}`] : [];
  },
});

const BUILTIN_VIDEO_EFFECTS: Readonly<Record<string, EffectSpec>> = { [colorEffect.name]: colorEffect };
const BUILTIN_AUDIO_EFFECTS: Readonly<Record<string, EffectSpec>> = {};

export const videoEffects: Registry<EffectSpec> = createRegistry<EffectSpec>({
  label: "video effect",
  sorted: true,
  builtin: BUILTIN_VIDEO_EFFECTS,
  notFound: notFound("video"),
});

export const audioEffects: Registry<EffectSpec> = createRegistry<EffectSpec>({
  label: "audio effect",
  sorted: true,
  builtin: BUILTIN_AUDIO_EFFECTS,
  notFound: notFound("audio"),
});

// 組み込みが必要とする ffmpeg フィルタを `doctor` の検査対象に載せる
for (const spec of [...Object.values(BUILTIN_VIDEO_EFFECTS), ...Object.values(BUILTIN_AUDIO_EFFECTS)])
  if (spec.requires?.length)
    registerRequirements(`effect:${spec.target}:${spec.name}`, { filters: spec.requires }, "builtin");

export function effectRegistry(target: EffectTarget): Registry<EffectSpec> {
  return target === "video" ? videoEffects : audioEffects;
}

/** 組み込み・プラグインを登録する。`requires` は `doctor` の検査対象に合成される */
export function registerEffect(spec: EffectSpec, source: "builtin" | "plugin" = "builtin"): void {
  effectRegistry(spec.target).register(spec.name, spec, source);
  if (spec.requires && spec.requires.length > 0)
    registerRequirements(`effect:${spec.target}:${spec.name}`, { filters: spec.requires }, source);
}

// ---------------------------------------------------------------------------
// パラメータの解決
// ---------------------------------------------------------------------------

/**
 * 既定値を当て、型と範囲を検査した `params` を返す（純関数）。
 * 未知のキーは**落とさずそのまま通す**（プラグインが後から意味を足せるように）。
 */
export function resolveEffectParams(
  spec: EffectSpec,
  raw: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [key, p] of Object.entries(spec.params ?? {})) {
    const value = raw[key];
    if (value === undefined) {
      if (p.required) throw paramError(spec, key, "is required");
      if (p.default !== undefined) out[key] = p.default;
      continue;
    }
    if (p.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw paramError(spec, key, "must be a number");
      if (p.min !== undefined && value < p.min) throw paramError(spec, key, `must be >= ${p.min}`);
      if (p.max !== undefined && value > p.max) throw paramError(spec, key, `must be <= ${p.max}`);
    } else if (p.type === "boolean") {
      if (typeof value !== "boolean") throw paramError(spec, key, "must be a boolean");
    } else {
      if (typeof value !== "string") throw paramError(spec, key, "must be a string");
      if (p.choices && !p.choices.includes(value))
        throw paramError(spec, key, `must be one of: ${p.choices.join(", ")}`);
    }
  }
  return out;
}

function paramError(spec: EffectSpec, key: string, what: string): MontashError {
  return new MontashError("E_USAGE", `effect '${spec.name}': ${key} ${what}`, {
    detail: { effect: spec.name, param: key },
  });
}

// ---------------------------------------------------------------------------
// 展開
// ---------------------------------------------------------------------------

/** project.json の `effects[]` の 1 要素（`core/schema.ts` の EffectSchema と同じ形） */
export interface EffectRef {
  type: string;
  params?: Record<string, unknown>;
  keyframes?: unknown[];
}

/**
 * クリップの `effects[]` を **配列順に** フィルタ片へ展開する（純関数）。
 * 未登録の種別は `E_PLUGIN_MISSING`、キーフレームは Phase 2 以降なので `E_NOT_IMPLEMENTED`。
 */
export function buildEffectFilters(
  target: EffectTarget,
  effects: readonly EffectRef[] | undefined,
  ctx: EffectBuildContext,
): string[] {
  if (!effects || effects.length === 0) return [];
  const registry = effectRegistry(target);
  const out: string[] = [];
  for (const ref of effects) {
    if (ref.keyframes && ref.keyframes.length > 0)
      throw new MontashError("E_NOT_IMPLEMENTED", `effect '${ref.type}': keyframes are not implemented yet`, {
        hint: "See docs/09-roadmap.md (F-FX-8).",
      });
    const spec = registry.require(ref.type);
    out.push(...spec.build(resolveEffectParams(spec, ref.params ?? {}), ctx));
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI オプションの導出
//
// AviUtl の「トラックバーを登録すると UI が出る」に相当する部分。パラメータ定義 1 つから
// CLI オプション・`schema`・`help`・（Phase 3 で）Web のフォームを導出する。
// ---------------------------------------------------------------------------

/** パラメータ名 → どのエフェクトが宣言しているか */
export interface ParamOrigin {
  name: string;
  spec: EffectParamSpec;
  /** このパラメータを持つエフェクト名（複数あり得る） */
  effects: string[];
  /** 型が食い違うエフェクトが混在している（その場合は string で受けて実行時に解釈する） */
  conflicting: boolean;
}

/**
 * 登録済みエフェクトのパラメータを名前で束ねる。
 *
 * `effect add <clip> <name> --sigma 12` のように「効果ごとに違う引数」を yargs（静的定義）で
 * 受けるため、**全エフェクトのパラメータの和集合**をオプションとして宣言する。
 * 同名で型が食い違う場合は string に寄せ、値の解釈は `resolveEffectParams()` に任せる。
 */
export function collectParamOrigins(target: EffectTarget): ParamOrigin[] {
  const byName = new Map<string, ParamOrigin>();
  for (const entry of effectRegistry(target).entries()) {
    for (const [name, spec] of Object.entries(entry.value.params ?? {})) {
      const found = byName.get(name);
      if (!found) {
        byName.set(name, { name, spec, effects: [entry.name], conflicting: false });
        continue;
      }
      found.effects.push(entry.name);
      if (found.spec.type !== spec.type) found.conflicting = true;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 文字列で来た値を、パラメータ定義の型に合わせて解釈する（CLI からの入力用） */
export function coerceParamValue(spec: EffectParamSpec, raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (spec.type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (spec.type === "boolean") {
    if (raw === "true" || raw === "") return true;
    if (raw === "false") return false;
  }
  return raw;
}

/** そのエフェクトが受け取るパラメータだけを、CLI の argv から抜き出して型変換する */
export function paramsFromArgs(spec: EffectSpec, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(spec.params ?? {})) {
    const value = args[name];
    if (value === undefined) continue;
    out[name] = coerceParamValue(p, value);
  }
  return out;
}
