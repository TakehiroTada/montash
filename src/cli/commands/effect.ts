/**
 * エフェクトコマンド（docs/04 §effect、W-18）。
 *
 * 効果そのものは `src/registry/effects.ts` のレジストリが持つ。ここは
 * 「どのクリップの `effects[]` をどう並べ替えるか」だけを扱う薄い層で、
 * **引数の定義はレジストリのパラメータ定義から導出する**（AviUtl の「トラックバーを
 * 登録すると UI が出る」に相当。docs/14）。
 *
 * yargs は静的なオプション定義を要求するので、`--sigma 12` のような「効果ごとに違う引数」は
 * **登録済みエフェクトのパラメータの和集合**として宣言する（`collectParamOrigins()`）。
 * 実際にどれを受け取るかは効果ごとに `paramsFromArgs()` で絞り、範囲と型は
 * `resolveEffectParams()` が検査する。
 *
 * TODO(Phase 2): プラグインが後から登録したエフェクトのパラメータもオプションに載せるため、
 * ここの spec 組み立てを `registry/commands.ts` の実行時合成に寄せる。
 */
import { findClip } from "../../core/clip-editing.ts";
import type { TrackClip } from "../../core/schema.ts";
import {
  collectParamOrigins,
  type EffectRef,
  type EffectSpec,
  type EffectTarget,
  effectRegistry,
  paramsFromArgs,
  resolveEffectParams,
} from "../../registry/effects.ts";
import { defineCommand, type OptionSpec } from "../define-command.ts";
import { MontashError } from "../errors.ts";
import { runMutation } from "../mutate.ts";

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/**
 * 掛けられる効果の対象をトラック種別から決める。
 * 音声トラックのクリップは音声効果、それ以外（video / text）は映像効果。
 */
function targetOfClip(trackKind: string): EffectTarget {
  return trackKind === "audio" ? "audio" : "video";
}

function effectsOf(clip: TrackClip): EffectRef[] {
  const current = (clip as { effects?: EffectRef[] }).effects;
  if (!Array.isArray(current)) {
    (clip as { effects?: EffectRef[] }).effects = [];
    return (clip as { effects: EffectRef[] }).effects;
  }
  return current;
}

/** 名前（または 0 始まりの index）で効果を特定する */
function indexOfEffect(effects: readonly EffectRef[], key: string, clipId: string): number {
  if (/^\d+$/.test(key)) {
    const i = Number(key);
    if (i < 0 || i >= effects.length)
      throw new MontashError("E_EFFECT_NOT_FOUND", `clip "${clipId}" has no effect at index ${i}`, {
        hint: `The clip has ${effects.length} effect(s). Run \`montash effect list ${clipId} --json\`.`,
        detail: { clip: clipId, index: i, count: effects.length },
      });
    return i;
  }
  const found = effects.findIndex((e) => e.type === key);
  if (found < 0)
    throw new MontashError("E_EFFECT_NOT_FOUND", `clip "${clipId}" has no effect "${key}"`, {
      hint:
        effects.length > 0
          ? `Applied effects: ${effects.map((e) => e.type).join(", ")}.`
          : `The clip has no effects. Run \`montash effect add ${clipId} <name>\` first.`,
      detail: { clip: clipId, effect: key, applied: effects.map((e) => e.type) },
    });
  return found;
}

/** 効果ごとのパラメータを、和集合オプションとして宣言する */
function paramOptions(): Record<string, OptionSpec> {
  const out: Record<string, OptionSpec> = {};
  for (const target of ["video", "audio"] as const) {
    for (const origin of collectParamOrigins(target)) {
      const existing = out[origin.name];
      const type = origin.conflicting ? "string" : origin.spec.type;
      const describe = `${origin.spec.describe} [${origin.effects.join(", ")}]`;
      if (existing) {
        // 映像と音声で同名パラメータがある場合も string に寄せる
        out[origin.name] = {
          type: existing.type === type ? existing.type : "string",
          describe: `${existing.describe.replace(/ \[[^\]]*\]$/, "")} [${origin.effects.join(", ")}]`,
        };
        continue;
      }
      out[origin.name] = { type, describe };
    }
  }
  return out;
}

function describeEffect(ref: EffectRef, index: number, spec: EffectSpec | undefined) {
  return {
    index,
    type: ref.type,
    params: ref.params ?? {},
    ...(spec ? { summary: spec.summary, source: spec.name } : { missing: true }),
  };
}

// ---------------------------------------------------------------------------
// effect presets
// ---------------------------------------------------------------------------

interface PresetsArgs extends Record<string, unknown> {
  target?: string;
}

export const effectPresets = defineCommand<PresetsArgs>({
  path: "effect presets",
  summary: "list the effects that are available (built-in and from plugins)",
  workflows: ["W-18"],
  noProject: true,
  options: {
    target: { type: "string", describe: "only video or audio effects", choices: ["video", "audio"] },
  },
  examples: [
    { cmd: "montash effect presets", note: "every registered effect" },
    { cmd: "montash effect presets --target video --json", note: "machine-readable, for AI" },
  ],
  handler(_ctx, args) {
    const targets: EffectTarget[] = args.target ? [args.target as EffectTarget] : ["video", "audio"];
    const result = targets.flatMap((target) =>
      effectRegistry(target)
        .entries()
        .map((e) => ({
          name: e.name,
          target,
          source: e.source,
          summary: e.value.summary,
          requires: e.value.requires ?? [],
          params: Object.fromEntries(
            Object.entries(e.value.params ?? {}).map(([k, p]) => [
              k,
              {
                type: p.type,
                describe: p.describe,
                ...(p.default !== undefined ? { default: p.default } : {}),
                ...(p.min !== undefined ? { min: p.min } : {}),
                ...(p.max !== undefined ? { max: p.max } : {}),
                ...(p.choices ? { choices: [...p.choices] } : {}),
                ...(p.required ? { required: true } : {}),
              },
            ]),
          ),
        })),
    );
    return {
      result,
      human: () =>
        result.length === 0
          ? "no effects are registered"
          : result
              .map((e) => {
                const params = Object.entries(e.params)
                  .map(([k, p]) => `--${k} <${p.type}>`)
                  .join(" ");
                return `${e.name.padEnd(12)} ${e.target.padEnd(6)} ${e.source.padEnd(8)} ${e.summary}${params ? `\n${" ".repeat(30)}${params}` : ""}`;
              })
              .join("\n"),
    };
  },
});

// ---------------------------------------------------------------------------
// effect list
// ---------------------------------------------------------------------------

interface ListArgs extends Record<string, unknown> {
  clip: string;
}

export const effectList = defineCommand<ListArgs>({
  path: "effect list",
  summary: "list the effects applied to a clip, in the order they are applied",
  workflows: ["W-18"],
  positionals: [{ name: "clip", describe: "clip ID", required: true }],
  examples: [{ cmd: "montash effect list c1 --json" }],
  async handler(ctx, args) {
    const { loadProject } = await import("../../core/project.ts");
    const project = await loadProject(ctx.requireProjectDir());
    const { track, clip } = findClip(project, String(args.clip));
    const target = targetOfClip(track.kind);
    const registry = effectRegistry(target);
    const effects = effectsOf(clip).map((ref, i) => describeEffect(ref, i, registry.get(ref.type)));
    return {
      result: { clip: clip.id, track: track.id, target, effects },
      op: null,
      commit: null,
      head: null,
      human: () =>
        effects.length === 0
          ? `${clip.id}: no effects`
          : effects
              .map((e) => {
                const params = Object.entries(e.params)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(" ");
                return `${String(e.index).padEnd(3)} ${e.type.padEnd(12)} ${params}${"missing" in e ? "   (plugin missing)" : ""}`;
              })
              .join("\n"),
    };
  },
});

// ---------------------------------------------------------------------------
// effect add / set / remove
// ---------------------------------------------------------------------------

interface MutateArgs extends Record<string, unknown> {
  clip: string;
  effect: string;
  index?: number;
}

const indexOption: OptionSpec = {
  type: "number",
  describe: "position in the effect chain (0 = first). default: append",
};

export const effectAdd = defineCommand<MutateArgs>({
  path: "effect add",
  summary: "apply an effect to a clip",
  workflows: ["W-18"],
  mutates: true,
  positionals: [
    { name: "clip", describe: "clip ID", required: true },
    { name: "effect", describe: "effect name (see `montash effect presets`)", required: true },
  ],
  options: { index: indexOption, ...paramOptions() },
  examples: [
    { cmd: "montash effect add c1 color --saturation 1.2", note: "boost saturation on one clip" },
    { cmd: "montash effect add c1 color --brightness 0.1 --dry-run", note: "show the ffmpeg filter first" },
  ],
  async handler(ctx, args) {
    return runMutation(ctx, ({ project }) => {
      const { track, clip } = findClip(project, String(args.clip));
      const target = targetOfClip(track.kind);
      const spec = effectRegistry(target).require(String(args.effect));
      const params = paramsFromArgs(spec, args);
      // 範囲・型をここで検査しておく（レンダーまで持ち越さない）
      resolveEffectParams(spec, params);

      const effects = effectsOf(clip);
      const ref: EffectRef = { type: spec.name, params };
      const at = args.index === undefined ? effects.length : Math.max(0, Math.min(Number(args.index), effects.length));
      effects.splice(at, 0, ref);

      return {
        result: { clip: clip.id, effect: spec.name, index: at, params },
        summary: `apply ${spec.name} to ${clip.id}`,
        affects: { clips: [clip.id], range_f: null },
        human: `${clip.id}  +${spec.name}${
          Object.keys(params).length
            ? ` (${Object.entries(params)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(" ")})`
            : ""
        }`,
      };
    });
  },
});

export const effectSet = defineCommand<MutateArgs>({
  path: "effect set",
  summary: "change the parameters (or the order) of an effect already applied",
  workflows: ["W-18"],
  mutates: true,
  positionals: [
    { name: "clip", describe: "clip ID", required: true },
    { name: "effect", describe: "effect name, or its index in the chain", required: true },
  ],
  options: { index: { ...indexOption, describe: "move the effect to this position" }, ...paramOptions() },
  examples: [
    { cmd: "montash effect set c1 color --saturation 1.05", note: "adjust without re-applying" },
    { cmd: "montash effect set c1 color --index 0", note: "apply it first in the chain" },
  ],
  async handler(ctx, args) {
    return runMutation(ctx, ({ project }) => {
      const { track, clip } = findClip(project, String(args.clip));
      const target = targetOfClip(track.kind);
      const effects = effectsOf(clip);
      const at = indexOfEffect(effects, String(args.effect), clip.id);
      const ref = effects[at]!;
      const spec = effectRegistry(target).require(ref.type);

      const incoming = paramsFromArgs(spec, args);
      const params = { ...(ref.params ?? {}), ...incoming };
      resolveEffectParams(spec, params);
      ref.params = params;

      let moved = at;
      if (args.index !== undefined) {
        moved = Math.max(0, Math.min(Number(args.index), effects.length - 1));
        effects.splice(at, 1);
        effects.splice(moved, 0, ref);
      }
      const changed = Object.keys(incoming).length > 0 || moved !== at;

      return {
        result: { clip: clip.id, effect: ref.type, index: moved, params },
        summary: `update ${ref.type} on ${clip.id}`,
        affects: { clips: [clip.id], range_f: null },
        changed,
        human: `${clip.id}  ${ref.type}  ${Object.entries(params)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(" ")}`,
      };
    });
  },
});

interface RemoveArgs extends Record<string, unknown> {
  clip: string;
  effect: string;
}

export const effectRemove = defineCommand<RemoveArgs>({
  path: "effect remove",
  summary: "remove an effect from a clip",
  workflows: ["W-18"],
  mutates: true,
  positionals: [
    { name: "clip", describe: "clip ID", required: true },
    { name: "effect", describe: "effect name, or its index in the chain", required: true },
  ],
  examples: [{ cmd: "montash effect remove c1 color" }],
  async handler(ctx, args) {
    return runMutation(ctx, ({ project }) => {
      const { clip } = findClip(project, String(args.clip));
      const effects = effectsOf(clip);
      const at = indexOfEffect(effects, String(args.effect), clip.id);
      const [removed] = effects.splice(at, 1);
      return {
        result: { clip: clip.id, effect: removed?.type, index: at },
        summary: `remove ${removed?.type} from ${clip.id}`,
        affects: { clips: [clip.id], range_f: null },
        human: `${clip.id}  -${removed?.type}`,
      };
    });
  },
});
