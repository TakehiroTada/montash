/**
 * 音声グラフ（docs/07 §8）。
 *
 * `atrim` / `afade` / `adelay` はすべてサンプル指定（`start_sample`/`end_sample`, `ss`/`ns`, `...S`）で、
 * 秒は使わない（ADR-09）。トランジションの `audio: crossfade` は §8.2 の `acrossfade` で畳み込む。
 */
import { MontashError } from "../../cli/errors.ts";
import type { GraphContext } from "./types.ts";

/** 名前付き音声ストリーム（ラベルとサンプル数） */
export interface AudioStream {
  label: string;
  samples: number;
}

export interface AudioFade {
  in_f: number;
  out_f: number;
  curve: string;
}

export interface AudioClipSpec {
  /** 入力ストリーム指定（"3:a:0"） */
  stream: string;
  /** 素材の切り出し開始サンプル */
  startSample: number;
  /** 素材から読むサンプル数（速度変更前） */
  sourceSamples: number;
  /** タイムライン上の長さ（サンプル。速度変更後） */
  samples: number;
  gainDb: number;
  fade?: AudioFade | undefined;
  speed: number;
  pitchKeep: boolean;
}

/** `atempo` は 0.5〜2 の範囲で多段にする（古いビルドでも動く。docs/07 §8.1） */
function tempoFilters(speed: number): string[] {
  const out: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    out.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    out.push("atempo=0.5");
    remaining /= 0.5;
  }
  out.push(`atempo=${Number(remaining.toFixed(6))}`);
  return out;
}

function speedFilters(ctx: GraphContext, speed: number, pitchKeep: boolean): string[] {
  if (speed === 1) return [];
  if (pitchKeep) return tempoFilters(speed);
  return [`asetrate=${Math.round(ctx.sampleRate * speed)}`, `aresample=${ctx.sampleRate}`];
}

function fadeFilters(ctx: GraphContext, fade: AudioFade | undefined, samples: number): string[] {
  if (!fade) return [];
  const out: string[] = [];
  if (fade.in_f > 0) out.push(`afade=t=in:ss=0:ns=${Math.min(ctx.samples(fade.in_f), samples)}:curve=${fade.curve}`);
  if (fade.out_f > 0) {
    const n = Math.min(ctx.samples(fade.out_f), samples);
    out.push(`afade=t=out:ss=${samples - n}:ns=${n}:curve=${fade.curve}`);
  }
  return out;
}

/** クリップ単位の正規化（docs/07 §8.1） */
export function normalizeAudioClip(ctx: GraphContext, spec: AudioClipSpec): AudioStream {
  const filters = [
    "asetpts=PTS-STARTPTS",
    `aresample=${ctx.sampleRate}`,
    `aformat=sample_fmts=fltp:channel_layouts=${ctx.layout}`,
    `atrim=start_sample=${spec.startSample}:end_sample=${spec.startSample + spec.sourceSamples}`,
    "asetpts=PTS-STARTPTS",
    ...speedFilters(ctx, spec.speed, spec.pitchKeep),
    `apad=whole_len=${spec.samples}`,
    `atrim=end_sample=${spec.samples}`,
    "asetpts=PTS-STARTPTS",
    `volume=${spec.gainDb}dB`,
    ...fadeFilters(ctx, spec.fade, spec.samples),
  ];
  return { label: ctx.chain(spec.stream, filters, "a"), samples: spec.samples };
}

/** `acrossfade` の畳み込み（docs/07 §8.2）。合成後の長さは `len1 + len2 - ns` */
export function foldAcrossfade(
  ctx: GraphContext,
  parts: readonly AudioStream[],
  durations: readonly number[],
): AudioStream {
  if (parts.length === 0) throw new MontashError("E_USAGE", "cannot fold an empty audio transition group");
  let current = parts[0]!;
  for (let i = 0; i < durations.length; i++) {
    const next = parts[i + 1]!;
    const ns = Math.min(durations[i]!, current.samples, next.samples);
    const label = ctx.chain([current.label, next.label], [`acrossfade=ns=${ns}:c1=tri:c2=tri`], "a");
    current = { label, samples: current.samples + next.samples - ns };
  }
  return current;
}

/**
 * タイムライン上の位置へずらす（docs/07 §8.1）。
 * `adelay` は負値を取れないので、負のオフセットは先頭を `atrim` で削る。
 */
export function delayAudio(ctx: GraphContext, stream: AudioStream, delaySamples: number): AudioStream {
  if (delaySamples === 0) return stream;
  if (delaySamples < 0) {
    const cut = Math.min(-delaySamples, stream.samples);
    return {
      label: ctx.chain(stream.label, [`atrim=start_sample=${cut}`, "asetpts=PTS-STARTPTS"], "a"),
      samples: stream.samples - cut,
    };
  }
  return {
    label: ctx.chain(stream.label, [`adelay=${delaySamples}S:all=1`], "a"),
    samples: stream.samples + delaySamples,
  };
}

/** `amix`（`normalize=0` にしないと音量が下がる。docs/07 §13） */
export function mixAudio(ctx: GraphContext, streams: readonly AudioStream[], samples: number): AudioStream {
  if (streams.length === 0)
    return {
      label: ctx.chain([], [`anullsrc=r=${ctx.sampleRate}:cl=${ctx.layout}`, `atrim=end_sample=${samples}`], "a"),
      samples,
    };
  if (streams.length === 1) return streams[0]!;
  return {
    label: ctx.chain(
      streams.map((s) => s.label),
      [`amix=inputs=${streams.length}:normalize=0:dropout_transition=0`],
      "a",
    ),
    samples: Math.max(...streams.map((s) => s.samples)),
  };
}

/** 全長を固定する（`apad` で伸ばして `atrim` で切る。docs/07 §8.3） */
export function fitAudio(
  ctx: GraphContext,
  stream: AudioStream,
  samples: number,
  extra: readonly string[] = [],
): AudioStream {
  return {
    label: ctx.chain(
      stream.label,
      [...extra, `apad=whole_len=${samples}`, `atrim=end_sample=${samples}`, "asetpts=PTS-STARTPTS"],
      "a",
    ),
    samples,
  };
}
