/**
 * エフェクトの解析パス（docs/14 §4 の Level C、docs/07 §3a）。
 *
 * loudnorm / ducking と同じ「**解析は外でやり、結果を値で注入する**」形。
 * これにより `graph/` と `build()` の純粋性が保たれ、`preview` のキャッシュ指紋
 * （`filterComplex` 由来）も壊れない。
 *
 * **プラグインは ffmpeg を直接起動しない。** `probe(filter)` の引数はここが組み立て、
 * プラグインが渡せるのはフィルタ文字列だけ（任意コマンドの実行はできない）。
 */
import { isMediaClip, type Project, type TrackClip } from "../core/schema.ts";
import {
  analysisKey,
  type EffectAnalyzeContext,
  type EffectRef,
  type EffectTarget,
  effectsNeedingAnalysis,
  resolveEffectParams,
} from "../registry/effects.ts";
import type { Binaries } from "./locate.ts";
import { runFfmpeg } from "./run.ts";

/** クリップ ID → （`target:effect` → 解析結果） */
export type EffectAnalyses = Record<string, Record<string, unknown>>;

export interface AnalyzeEffectsOptions {
  /** アセット → 入力パス（プレビューはプロキシに差し替える。グラフと同じ関数を渡す） */
  source: (assetId: string) => string;
  signal?: AbortSignal;
}

function effectsOf(clip: TrackClip): EffectRef[] {
  return ((clip as { effects?: EffectRef[] }).effects ?? []) as EffectRef[];
}

/**
 * 1 本のフィルタを通して stderr を返す（`-f null -` なので出力は捨てる）。
 * 解析フィルタ（`signalstats` / `blackdetect` / `cropdetect` など）の想定。
 */
async function probeFilter(
  bins: Binaries,
  source: string,
  srcIn: number,
  srcOut: number,
  fpsArg: string,
  filter: string,
  signal?: AbortSignal,
): Promise<string> {
  // `runFfmpeg` は stderr の末尾 N 行しか保持しないので、解析では全行を集める
  const lines: string[] = [];
  await runFfmpeg(
    bins,
    [
      "-i",
      source,
      "-an",
      "-vf",
      `fps=${fpsArg},trim=start_frame=${srcIn}:end_frame=${srcOut},${filter}`,
      "-f",
      "null",
      "-",
    ],
    { onStderrLine: (line) => lines.push(line), ...(signal ? { signal } : {}) },
  );
  return lines.join("\n");
}

/**
 * プロジェクト内の「解析が要るエフェクト」をすべて走らせる。
 *
 * 同じクリップで同じ効果を 2 度掛けても解析は 1 回（`analysisKey` で共有）。
 * 解析を持つエフェクトが 1 つも無ければ **ffmpeg を 1 度も起動しない**。
 */
export async function analyzeEffects(
  project: Project,
  bins: Binaries,
  opts: AnalyzeEffectsOptions,
): Promise<EffectAnalyses> {
  const out: EffectAnalyses = {};
  const fpsArg = `${project.settings.fps.num}/${project.settings.fps.den}`;

  for (const track of project.tracks) {
    const target: EffectTarget = track.kind === "audio" ? "audio" : "video";
    for (const clip of track.clips) {
      const effects = effectsOf(clip);
      const needing = effectsNeedingAnalysis(target, effects);
      if (needing.length === 0) continue;
      if (!isMediaClip(clip)) continue; // 解析は素材を読むので、アセットを持つクリップだけ

      const source = opts.source(clip.asset);
      for (const spec of needing) {
        const ref = effects.find((e) => e.type === spec.name);
        if (!ref) continue;
        const ctx: EffectAnalyzeContext = {
          fps: project.settings.fps,
          resolution: project.settings.resolution,
          frames: clip.out_f - clip.in_f,
          sampleRate: project.settings.sample_rate,
          source,
          srcIn: clip.in_f,
          srcOut: clip.out_f,
          probe: (filter) => probeFilter(bins, source, clip.in_f, clip.out_f, fpsArg, filter, opts.signal),
        };
        const params = resolveEffectParams(spec, ref.params ?? {});
        const result = await spec.analyze?.(params, ctx);
        const bag = out[clip.id] ?? {};
        bag[analysisKey(target, spec.name)] = result;
        out[clip.id] = bag;
      }
    }
  }
  return out;
}

/** 解析が 1 つでも要るか（要らなければ解析パスごと省ける） */
export function needsEffectAnalysis(project: Project): boolean {
  for (const track of project.tracks) {
    const target: EffectTarget = track.kind === "audio" ? "audio" : "video";
    for (const clip of track.clips) {
      if (effectsNeedingAnalysis(target, effectsOf(clip)).length > 0) return true;
    }
  }
  return false;
}
