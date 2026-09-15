/**
 * 音声の解析パス（docs/04 §11 `audio analyze`、docs/07 §8.3 の `--simple` ダッキング事前解析）。
 *
 * 映像を伴わない 1 パス（`-vn ... -f null -`）で `ebur128` / `volumedetect` / `silencedetect` を通し、
 * 統合ラウドネス・ピーク・無音区間を stderr から拾う。グラフの組み立ては `graph/` に任せ、
 * ここは I/O とパースだけを持つ（`graph/` は純関数のまま）。
 */
import { type Asset, isMediaClip, type Project } from "../core/schema.ts";
import { framesToSeconds } from "../core/time.ts";
import type { DuckWindow } from "./graph/audio.ts";
import { buildGraph } from "./graph/builder.ts";
import type { DuckAnalysis, FilterGraph } from "./graph/types.ts";
import type { Binaries } from "./locate.ts";
import { runFfmpeg } from "./run.ts";

/** 無音区間（秒） */
export interface SilenceSpan {
  from: number;
  to: number;
  duration: number;
}

export interface AudioAnalysis {
  duration: number;
  /** 統合ラウドネス（LUFS）。完全な無音では null */
  integrated_lufs: number | null;
  /** ラウドネスレンジ（LU） */
  lra: number | null;
  /** トゥルーピーク（dBFS） */
  true_peak_dbfs: number | null;
  mean_volume_db: number | null;
  max_volume_db: number | null;
  silence: SilenceSpan[];
  /** 無音でない区間（`silence` の補集合）。ダッキングの発話区間に使う */
  active: DuckWindow[];
}

export interface AnalyzeOptions {
  /** 無音判定のしきい値（dBFS。既定 -40） */
  noiseDb?: number;
  /** 無音とみなす最小の長さ（秒。既定 0.3） */
  minSilence?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_NOISE_DB = -40;
const DEFAULT_MIN_SILENCE = 0.3;
/** 発話区間の前後に足す余白（秒）。コンプレッサのアタック／リリース相当 */
const ACTIVE_PAD = 0.15;
/** この間隔より近い発話区間はまとめる（秒） */
const ACTIVE_MERGE_GAP = 0.25;

// ---------------------------------------------------------------------------
// stderr のパース
// ---------------------------------------------------------------------------

function parseLevel(text: string | undefined): number | null {
  if (text === undefined) return null;
  if (/^-inf$/i.test(text.trim())) return null;
  const v = Number(text);
  return Number.isFinite(v) ? v : null;
}

/** `ebur128` / `volumedetect` / `silencedetect` の出力を 1 つにまとめる */
export function parseAnalysisOutput(lines: readonly string[], duration: number): AudioAnalysis {
  const summaryAt = lines.findLastIndex((l) => /Summary:/.test(l));
  const summary = summaryAt < 0 ? [] : lines.slice(summaryAt);
  const find = (source: readonly string[], re: RegExp): string | undefined => {
    for (const line of source) {
      const m = re.exec(line);
      if (m) return m[1];
    }
    return undefined;
  };
  const silence: SilenceSpan[] = [];
  let openAt: number | null = null;
  for (const line of lines) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) openAt = Number(start[1]);
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end && openAt !== null) {
      const from = Math.max(0, openAt);
      const to = Math.min(duration, Number(end[1]));
      if (to > from) silence.push({ from, to, duration: to - from });
      openAt = null;
    }
  }
  // 最後の無音が閉じないまま終わることがある（末尾まで無音）
  if (openAt !== null && openAt < duration) {
    const from = Math.max(0, openAt);
    silence.push({ from, to: duration, duration: duration - from });
  }
  return {
    duration,
    integrated_lufs: parseLevel(find(summary, /^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS/)),
    lra: parseLevel(find(summary, /^\s*LRA:\s+(-?[\d.]+|-inf)\s+LU/)),
    true_peak_dbfs: parseLevel(find(summary, /^\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS/)),
    mean_volume_db: parseLevel(find(lines, /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/)),
    max_volume_db: parseLevel(find(lines, /max_volume:\s*(-?[\d.]+|-inf)\s*dB/)),
    silence,
    active: activeWindows(silence, duration),
  };
}

/** 無音区間の補集合（前後に余白を付け、近すぎるものはまとめる） */
export function activeWindows(silence: readonly SilenceSpan[], duration: number): DuckWindow[] {
  const spans: DuckWindow[] = [];
  let cursor = 0;
  for (const s of [...silence].sort((a, b) => a.from - b.from)) {
    if (s.from > cursor) spans.push({ from: cursor, to: Math.min(s.from, duration) });
    cursor = Math.max(cursor, s.to);
  }
  if (cursor < duration) spans.push({ from: cursor, to: duration });
  const out: DuckWindow[] = [];
  for (const span of spans) {
    const padded = { from: Math.max(0, span.from - ACTIVE_PAD), to: Math.min(duration, span.to + ACTIVE_PAD) };
    if (padded.to - padded.from < 0.05) continue;
    const last = out.at(-1);
    if (last && padded.from - last.to <= ACTIVE_MERGE_GAP) last.to = Math.max(last.to, padded.to);
    else out.push(padded);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 解析パスの実行
// ---------------------------------------------------------------------------

/** 音声グラフの出力に解析フィルタを足した `-f null -` の引数を組み立てる */
export function analysisArgs(graph: FilterGraph, opts: AnalyzeOptions = {}): string[] {
  const noise = opts.noiseDb ?? DEFAULT_NOISE_DB;
  const minSilence = opts.minSilence ?? DEFAULT_MIN_SILENCE;
  const label = "Aana";
  const chain = `${graph.mapAudio}ebur128=peak=true,volumedetect,silencedetect=noise=${noise}dB:d=${minSilence}[${label}]`;
  return [
    ...graph.inputs.flat(),
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    `${graph.filterComplex};${chain}`,
    "-map",
    `[${label}]`,
    "-vn",
    "-c:a",
    "pcm_s16le",
    "-f",
    "null",
    "-",
  ];
}

/** 組み立て済みの音声グラフを 1 パス走らせて解析結果を返す */
export async function analyzeGraph(
  bins: Binaries,
  graph: FilterGraph,
  duration: number,
  opts: AnalyzeOptions = {},
): Promise<AudioAnalysis> {
  const lines: string[] = [];
  await runFfmpeg(bins, analysisArgs(graph, opts), {
    onStderrLine: (l) => lines.push(l),
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  return parseAnalysisOutput(lines, duration);
}

/**
 * プロジェクトの一部（1 トラック、1 クリップ、素材 1 つ）だけを鳴らした音声グラフを作る。
 * 対象以外の音声トラック・クリップを muted にした複製を作るので、実際のレンダーと同じ経路を通る。
 */
export function isolateAudio(project: Project, keep: { track?: string; clip?: string }): Project {
  const copy = structuredClone(project);
  for (const track of copy.tracks) {
    if (track.kind !== "audio") continue;
    if (keep.track !== undefined && track.id !== keep.track) {
      track.muted = true;
      continue;
    }
    track.muted = false;
    if (keep.clip === undefined) continue;
    for (const clip of track.clips) {
      if (isMediaClip(clip) && clip.audio) clip.audio.muted = clip.id !== keep.clip;
    }
  }
  return copy;
}

export interface AnalyzeTargetOptions extends AnalyzeOptions {
  source: (asset: Asset) => string;
}

/** トラック／クリップ単位の解析（プロジェクトの音声グラフを対象だけに絞って実行する） */
export async function analyzeProjectAudio(
  bins: Binaries,
  project: Project,
  total: number,
  keep: { track?: string; clip?: string },
  opts: AnalyzeTargetOptions,
): Promise<AudioAnalysis> {
  const graph = buildGraph(isolateAudio(project, keep), {
    resolution: project.settings.resolution,
    source: opts.source,
    video: false,
  });
  return analyzeGraph(bins, graph, framesToSeconds(total, project.settings.fps), opts);
}

/**
 * `--simple` ダッキングの事前解析（docs/07 §8.3）。
 * サイドチェイントラックだけを鳴らして発話区間とピーク音量を測り、ducking ID ごとに返す。
 */
export async function analyzeDucking(
  bins: Binaries,
  project: Project,
  total: number,
  opts: AnalyzeTargetOptions,
): Promise<Record<string, DuckAnalysis>> {
  const simple = project.audio.ducking.filter((d) => d.simple === true);
  if (!simple.length) return {};
  const byTrack = new Map<string, DuckAnalysis>();
  const out: Record<string, DuckAnalysis> = {};
  for (const duck of simple) {
    let analysis = byTrack.get(duck.sidechain);
    if (!analysis) {
      const measured = await analyzeProjectAudio(bins, project, total, { track: duck.sidechain }, opts);
      analysis = { windows: measured.active, level_db: measured.max_volume_db ?? -6 };
      byTrack.set(duck.sidechain, analysis);
    }
    out[duck.id] = analysis;
  }
  return out;
}
