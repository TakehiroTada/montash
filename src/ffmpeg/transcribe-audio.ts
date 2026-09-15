/**
 * 書き起こし用の音声を書き出す（docs/03 W-22）。
 *
 * whisper.cpp は **16kHz モノラルの WAV** しか受け取らない。実地では
 * `montash render audio` → ffmpeg で 16kHz 化、という 2 手を踏んでいたので、ここで 1 手にまとめる。
 * タイムライン全体のミックスは既存の `render audio` と同じ経路（`buildRenderPlan`）を使い、
 * 出力段のプリセットだけ 16kHz モノラル PCM に差し替える。
 */
import type { Project } from "../core/schema.ts";
import type { Binaries } from "./locate.ts";
import { BUILTIN_PRESETS, type PresetSpec } from "./presets.ts";
import { buildRenderPlan } from "./render.ts";
import { runFfmpeg } from "./run.ts";

/** whisper.cpp が要求するサンプリングレート */
export const ASR_SAMPLE_RATE = 16000;

/** 書き起こし用の出力段（16kHz モノラル PCM の WAV） */
export const ASR_PRESET_NAME = "transcribe-wav";
export const ASR_PRESET: PresetSpec = {
  format: "wav",
  ext: ".wav",
  resolution: null,
  video: null,
  audio: { codec: "pcm_s16le", extra: ["-ar", String(ASR_SAMPLE_RATE), "-ac", "1"] },
  note: "16kHz mono PCM for speech recognition",
};

export interface ExtractAudioOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface ExtractAudioResult {
  /** ffmpeg に渡した引数（`result.command` に載せる） */
  args: string[];
  durationMs: number;
}

/**
 * タイムラインのミックスを 16kHz モノラル WAV に書き出す。
 *
 * ラウドネス正規化やダッキングの事前パスは走らせない（認識精度には効かず、時間だけ掛かるため）。
 */
export async function extractTimelineAudio(
  bins: Binaries,
  dir: string,
  project: Project,
  output: string,
  opts: ExtractAudioOptions = {},
): Promise<ExtractAudioResult> {
  const plan = await buildRenderPlan(project, dir, output, {
    preset: ASR_PRESET_NAME,
    presets: { ...(BUILTIN_PRESETS as Record<string, PresetSpec>), [ASR_PRESET_NAME]: ASR_PRESET },
    bins,
  });
  const args = ["-y", ...plan.args];
  const run = await runFfmpeg(bins, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  return { args, durationMs: run.durationMs };
}

/** 1 つのファイル（素材）を 16kHz モノラル WAV に変換する */
export async function extractFileAudio(
  bins: Binaries,
  input: string,
  output: string,
  opts: ExtractAudioOptions = {},
): Promise<ExtractAudioResult> {
  const args = [
    "-y",
    "-i",
    input,
    "-vn",
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(ASR_SAMPLE_RATE),
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    output,
  ];
  const run = await runFfmpeg(bins, args, {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  return { args, durationMs: run.durationMs };
}
