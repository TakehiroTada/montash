/**
 * ジェネレータレジストリ（`docs/plans/2026-09-15-plugin-architecture.md` P1-4、docs/05 §6.4）。
 *
 * ジェネレータは「アセットを参照せず、自分で映像／音声を作るクリップ」の種別。
 * かつて `GeneratorClipSchema.generator` は `z.enum(["color", "hold"])` で**種類が固定**されていて、
 * 本体を書き換えない限り新しい生成クリップを足せなかった。ここでレジストリに載せ替え、
 * **組み込みの `color` / `hold` も外部プラグインとまったく同じ契約**（`defineGenerator`）で書く。
 *
 * クリップ種別（D-14）と同じ扱いにする:
 *   - 未登録のジェネレータでも **project.json は開けて保存できる**（`generator` は `z.string()`）
 *   - `validate` は警告（`W_UNKNOWN_CLIP_TYPE`）だけ
 *   - **レンダーしようとしたときにだけ** `E_PLUGIN_MISSING` で止まる
 *
 * 種別ごとの意味検査（`hold` が `params.from_clip` を必要とする、など）は `validate()` フックとして
 * **仕様の隣**に置く。`core/validate.ts` に種別名を直書きすると「組み込みだけができること」が残り、
 * プラグインが供給するジェネレータは自分のパラメータを検査できなくなるため（14 章の方針）。
 *
 * このモジュールは純関数だけを持つ（`node:fs` / `Bun.spawn` を import しない）。
 */
import { MontashError } from "../cli/errors.ts";
import type { Fps, Resolution } from "../core/schema.ts";
import { createRegistry, type Registry } from "./index.ts";
import { registerRequirements } from "./requirements.ts";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** パラメータ定義（`registry/effects.ts` の `EffectParamSpec` と同じ形） */
export interface GeneratorParamSpec {
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

/** `validate()` に渡る、ジェネレータクリップの読み取り専用ビュー */
export interface GeneratorClipView {
  id: string;
  generator: string;
  params: Readonly<Record<string, unknown>>;
  duration_f: number;
}

/** `validate()` に渡る文脈（I/O は渡さない） */
export interface GeneratorValidateContext {
  fps: Fps;
  resolution: Resolution;
}

/**
 * `validate()` が返す指摘。`core/validate.ts` の `Issue` にそのまま写す。
 * `path` は**クリップからの相対**（`"/params"` のように書く）。
 */
export interface GeneratorIssue {
  level?: "error" | "warning";
  code: string;
  message: string;
  /** クリップのパスに続けるサフィックス（例: `"/params"`） */
  path?: string;
  hint?: string;
  detail?: Record<string, unknown>;
}

export interface GeneratorSpec {
  name: string;
  summary: string;
  params?: Record<string, GeneratorParamSpec>;
  /** 必要な ffmpeg フィルタ（`doctor` が検査する） */
  requires?: readonly string[];
  /** 種別固有の意味検査（純関数）。`core/validate.ts` から呼ばれる */
  validate?(clip: GeneratorClipView, ctx: GeneratorValidateContext): GeneratorIssue[];
}

export function defineGenerator(spec: GeneratorSpec): GeneratorSpec {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new Error(`invalid generator name: "${spec.name}"`);
  return spec;
}

// ---------------------------------------------------------------------------
// 組み込みジェネレータ
// ---------------------------------------------------------------------------

/** 単色（`timeline gaps --fill black` が置く背景クリップ。docs/07 §3 の `color=` ソース） */
export const colorGenerator: GeneratorSpec = defineGenerator({
  name: "color",
  summary: "a solid colour source (gap filler, leader, background)",
  params: {
    color: { type: "string", describe: "#rrggbb, #rrggbbaa or a named colour" },
  },
});

/** 直前クリップの 1 フレームを保持（フリーズフレーム。docs/07 §4.1 の `loop`） */
export const holdGenerator: GeneratorSpec = defineGenerator({
  name: "hold",
  summary: "freeze one frame of another clip for the whole duration",
  params: {
    from_clip: { type: "string", describe: "clip ID to freeze a frame of", required: true },
    at: { type: "string", describe: "which frame to freeze", choices: ["start", "end"], default: "end" },
  },
  validate(clip) {
    // 従来 `core/validate.ts` にあった検査をそのまま移したもの（文面・コードは変えない）
    if (typeof clip.params.from_clip !== "string")
      return [
        {
          code: "E_CLIP_NOT_FOUND",
          message: `hold generator "${clip.id}" needs params.from_clip`,
          path: "/params",
        },
      ];
    return [];
  },
});

const BUILTIN_GENERATORS: Readonly<Record<string, GeneratorSpec>> = {
  [colorGenerator.name]: colorGenerator,
  [holdGenerator.name]: holdGenerator,
};

// ---------------------------------------------------------------------------
// レジストリ
// ---------------------------------------------------------------------------

export const generators: Registry<GeneratorSpec> = createRegistry<GeneratorSpec>({
  label: "generator",
  sorted: true,
  builtin: BUILTIN_GENERATORS,
  notFound: (name, known) =>
    new MontashError("E_PLUGIN_MISSING", `unknown generator '${name}'`, {
      hint: `No registered plugin provides it. Known generators: ${known.join(", ")}.`,
      detail: { generator: name, known: [...known] },
    }),
});

/*
 * 組み込みの 2 種は **`requires` を宣言しない**。
 *
 * `doctor` の必須集合に足すと「無いと `E_FFMPEG_FEATURE_MISSING` で落ちる」意味になるが、
 * ジェネレータクリップは**まだフィルタグラフ側が未実装**（`graph/builder.ts` が `E_NOT_IMPLEMENTED`）で、
 * その ffmpeg フィルタ（`color` / `loop`）が無くても現状できることは何も減らない。
 * 使えない機能のために `doctor` を落とすのは筋が悪いので、宣言はレンダーを実装する PR（docs/09 M3）で足す。
 * 仕組み自体は `registerGenerator()` に通っていて、プラグインが宣言すれば即座に検査対象になる。
 */
for (const spec of Object.values(BUILTIN_GENERATORS))
  if (spec.requires?.length) registerRequirements(`generator:${spec.name}`, { filters: spec.requires }, "builtin");

/** 組み込み・プラグインを登録する。`requires` は `doctor` の検査対象に合成される */
export function registerGenerator(spec: GeneratorSpec, source: "builtin" | "plugin" = "builtin"): void {
  generators.register(spec.name, spec, source);
  if (spec.requires && spec.requires.length > 0)
    registerRequirements(`generator:${spec.name}`, { filters: spec.requires }, source);
}

// ---------------------------------------------------------------------------
// 利用側のヘルパ
// ---------------------------------------------------------------------------

/**
 * レンダー時に呼ぶ。未登録のジェネレータはここで初めて止まる（読み込み・保存は通っている。F-EXT-4）。
 * 未知のクリップ種別（`graph/types.ts` の `pluginMissing()`）と同じ思想・同じエラーコード。
 */
export function assertGeneratorAvailable(clipId: string, name: string): GeneratorSpec {
  const spec = generators.get(name);
  if (spec) return spec;
  throw new MontashError("E_PLUGIN_MISSING", `clip "${clipId}" has unknown generator "${name}"`, {
    hint: `No registered plugin provides generator "${name}". Known generators: ${generators.names().join(", ")}.`,
    detail: { clip: clipId, generator: name, known: generators.names() },
  });
}

/**
 * ジェネレータクリップの意味検査（`core/validate.ts` から呼ぶ純関数）。
 * 未登録の種別は**警告だけ**にする（クリップを保持したまま開けることが F-EXT-4 の要件）。
 */
export function validateGeneratorClip(clip: GeneratorClipView, ctx: GeneratorValidateContext): GeneratorIssue[] {
  const spec = generators.get(clip.generator);
  if (!spec)
    return [
      {
        level: "warning",
        code: "W_UNKNOWN_CLIP_TYPE",
        message: `clip "${clip.id}" has unknown generator "${clip.generator}"`,
        path: "/generator",
        hint: "The clip is kept as-is. Install the plugin that provides this generator before rendering.",
      },
    ];
  return spec.validate?.(clip, ctx) ?? [];
}
