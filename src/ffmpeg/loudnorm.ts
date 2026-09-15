/**
 * ラウドネス正規化の 2 パス（docs/07 §8.4）。
 *
 * 1. パス 1: 音声グラフだけ（`-vn`）で `loudnorm=I=..:TP=..:LRA=..:print_format=json -f null -` を実行し、
 *    stderr の JSON から measured 値を取る。
 * 2. パス 2: `graph/audio.ts` が `[Aout]` の末尾に `measured_*` と `linear=true` を付けた `loudnorm` を挿す。
 *
 * ここは I/O（ffmpeg 実行とパース）だけを持ち、フィルタ文字列の組み立ては `graph/audio.ts` にある。
 */
import type { Warning } from "../cli/errors.ts";
import { warning } from "../cli/errors.ts";
import { timelineDurationF } from "../core/assets.ts";
import type { Asset, Project } from "../core/schema.ts";
import { framesToSeconds } from "../core/time.ts";
import { analyzeDucking } from "./audio-analysis.ts";
import type { LoudnormMeasured, LoudnormSpec } from "./graph/audio.ts";
import { buildGraph } from "./graph/builder.ts";
import type { DuckAnalysis, FilterGraph } from "./graph/types.ts";
import type { Binaries } from "./locate.ts";
import { runFfmpeg } from "./run.ts";

export interface LoudnormTarget {
  i: number;
  tp: number;
  lra: number;
}

/** パス 1 の引数（`print_format=json` の `loudnorm` を音声出力の末尾に足して `-f null -`） */
export function measureArgs(graph: FilterGraph, target: LoudnormTarget): string[] {
  const filter = `loudnorm=I=${target.i}:TP=${target.tp}:LRA=${target.lra}:print_format=json`;
  return [
    ...graph.inputs.flat(),
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    `${graph.filterComplex};${graph.mapAudio}${filter}[Alnm]`,
    "-map",
    "[Alnm]",
    "-vn",
    "-c:a",
    "pcm_s16le",
    "-f",
    "null",
    "-",
  ];
}

/** stderr 末尾の JSON ブロック（`{ "input_i": ... }`）を取り出す */
export function parseLoudnormJson(lines: readonly string[]): LoudnormMeasured | null {
  const open = lines.findLastIndex((l) => l.trim() === "{");
  if (open < 0) return null;
  const close = lines.findIndex((l, i) => i > open && l.trim() === "}");
  if (close < 0) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(lines.slice(open, close + 1).join("\n")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const value = (key: string): number => Number(parsed[key]);
  const measured: LoudnormMeasured = {
    input_i: value("input_i"),
    input_tp: value("input_tp"),
    input_lra: value("input_lra"),
    input_thresh: value("input_thresh"),
    target_offset: value("target_offset"),
  };
  // 無音（-inf）や欠損があれば 2 パス目に使えない
  if (Object.values(measured).some((v) => !Number.isFinite(v))) return null;
  return measured;
}

/** パス 1（測定）。無音などで測れなかった場合は null */
export async function measureLoudnorm(
  bins: Binaries,
  graph: FilterGraph,
  target: LoudnormTarget,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LoudnormMeasured | null> {
  const lines: string[] = [];
  await runFfmpeg(bins, measureArgs(graph, target), {
    onStderrLine: (l) => lines.push(l),
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeoutMs: opts.timeoutMs ?? 600_000,
  });
  return parseLoudnormJson(lines);
}

// ---------------------------------------------------------------------------
// レンダー前の音声準備（ダッキング解析 + loudnorm 測定）
// ---------------------------------------------------------------------------

/** `buildGraph` に渡す音声パスの結果（docs/07 §8.3, §8.4） */
export interface AudioPasses {
  ducking?: Record<string, DuckAnalysis> | undefined;
  loudnorm?: LoudnormSpec | undefined;
}

export interface PrepareAudioOptions {
  source: (asset: Asset) => string;
  /** 正規化を測定せず 1 パスにする（プレビュー。docs/07 §8.4-3） */
  singlePass?: boolean;
  /** false なら ffmpeg を一切動かさない（`--dry-run`）。正規化は 1 パス扱いで計画だけ返す */
  measure?: boolean;
  /** 正規化そのものを行わない（`--dry-run` や `settings.preview.normalize=false`） */
  skipNormalize?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * レンダー前に音声の事前パスを走らせる。
 * `--simple` ダッキングの発話区間解析 → `loudnorm` の測定（パス 1）の順で、どちらも `-vn` の音声だけ。
 */
export async function prepareAudio(
  bins: Binaries,
  project: Project,
  opts: PrepareAudioOptions,
): Promise<{ passes: AudioPasses; warnings: Warning[] }> {
  const warnings: Warning[] = [];
  const total = timelineDurationF(project);
  const passes: AudioPasses = {};
  if (!total) return { passes, warnings };
  const normalizeTarget = (): LoudnormTarget => ({
    i: project.audio.normalize.i,
    tp: project.audio.normalize.tp,
    lra: project.audio.normalize.lra,
  });
  const wantNormalize = project.audio.normalize.enabled && !opts.skipNormalize;

  // `--dry-run`: 事前パスを走らせずに計画だけ返す
  if (opts.measure === false) {
    if (project.audio.ducking.some((d) => d.simple === true))
      warnings.push(
        warning("W_DUCK_ANALYSIS_MISSING", "--simple ducking needs a sidechain analysis pass; not run for a plan"),
      );
    if (wantNormalize) {
      passes.loudnorm = normalizeTarget();
      warnings.push(
        warning("W_NORMALIZE_SINGLE_PASS", "the plan shows a one-pass loudnorm; `montash render` measures first"),
      );
    }
    return { passes, warnings };
  }

  const ducking = await analyzeDucking(bins, project, total, {
    source: opts.source,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (Object.keys(ducking).length) passes.ducking = ducking;

  if (!wantNormalize) return { passes, warnings };
  const target = normalizeTarget();
  if (opts.singlePass) {
    passes.loudnorm = target;
    warnings.push(
      warning("W_NORMALIZE_SINGLE_PASS", "loudness normalization runs in one dynamic pass (no measurement)", {
        hint: "`montash render` measures first and applies a linear correction (docs/07 §8.4).",
      }),
    );
    return { passes, warnings };
  }

  // パス 1: 正規化なしの音声グラフを測定する
  const graph = buildGraph(project, {
    resolution: project.settings.resolution,
    source: opts.source,
    video: false,
    ...(passes.ducking ? { ducking: passes.ducking } : {}),
  });
  const measured = await measureLoudnorm(bins, graph, target, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (!measured) {
    warnings.push(
      warning("W_NORMALIZE_SKIPPED", "loudness could not be measured (silent timeline?); audio is left as is", {
        hint: "Run `montash audio analyze A1 --json` to check the levels.",
      }),
    );
    return { passes, warnings };
  }
  passes.loudnorm = { ...target, measured };
  return { passes, warnings };
}

/** 測定結果の要約（レンダーの結果 JSON に載せる） */
export function describeLoudnorm(spec: LoudnormSpec | undefined, project: Project) {
  if (!spec) return null;
  return {
    target_i: spec.i,
    target_tp: spec.tp,
    target_lra: spec.lra,
    measured: spec.measured ?? null,
    passes: spec.measured ? 2 : 1,
    duration: framesToSeconds(timelineDurationF(project), project.settings.fps),
  };
}
