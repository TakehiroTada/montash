/**
 * 音声グラフ（docs/07 §8）。
 *
 * `atrim` / `afade` / `adelay` はすべてサンプル指定（`start_sample`/`end_sample`, `ss`/`ns`, `...S`）で、
 * 秒は使わない（ADR-09）。トランジションの `audio: crossfade` は §8.2 の `acrossfade` で畳み込む。
 */
import { MontashError } from "../../cli/errors.ts";
import { buildEffectFilters, type EffectRef } from "../../registry/effects.ts";
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
  /** クリップの effects[]（docs/07 §8a） */
  effects?: readonly EffectRef[] | undefined;
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
    // クリップの effects[] は配列順に、ゲインのあと・フェード前へ差し込む（docs/07 §8a）
    ...buildEffectFilters("audio", spec.effects, {
      fps: ctx.fps,
      resolution: ctx.res,
      frames: 0,
      sampleRate: ctx.sampleRate,
    }),
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

// ---------------------------------------------------------------------------
// トラック合成・ダッキング（docs/07 §8.3）
// ---------------------------------------------------------------------------

/** 小数を ffmpeg に渡す文字列にする（指数表記を避け、末尾の 0 を落とす） */
function num(v: number): string {
  return String(Number(v.toFixed(6)));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** dB → 線形振幅（`10^(dB/20)`）。`sidechaincompress` の threshold / makeup はこの単位（docs/07 §8.3） */
export function dbToAmplitude(db: number): number {
  return 10 ** (db / 20);
}

/** `sidechaincompress` のパラメータ（`project.audio.ducking` の 1 件ぶん） */
export interface DuckSpec {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
}

/** ffmpeg の `sidechaincompress` が受け付ける範囲（範囲外は黙って拒否されるので事前に丸める） */
const THRESHOLD_RANGE: [number, number] = [0.000976563, 1];
const RATIO_RANGE: [number, number] = [1, 20];
const ATTACK_RANGE: [number, number] = [0.01, 2000];
const RELEASE_RANGE: [number, number] = [0.01, 9000];
const MAKEUP_RANGE: [number, number] = [1, 64];

/** 1 本の音声を N 本に複製する（サイドチェイン用のコピーを作る。docs/07 §8.3 `asplit`） */
export function splitAudio(ctx: GraphContext, stream: AudioStream, count = 2): AudioStream[] {
  if (count < 2) return [stream];
  const labels = Array.from({ length: count }, () => ctx.label("a"));
  ctx.push(`[${stream.label}]asplit=${count}${labels.map((l) => `[${l}]`).join("")}`);
  return labels.map((label) => ({ label, samples: stream.samples }));
}

/**
 * サイドチェインコンプレッサでターゲットを押し下げる（docs/07 §8.3）。
 * `threshold` / `makeup` は dB ではなく線形振幅で渡す（`10^(dB/20)`）。
 */
export function sidechainDuck(
  ctx: GraphContext,
  target: AudioStream,
  sidechain: AudioStream,
  spec: DuckSpec,
): AudioStream {
  const threshold = clamp(dbToAmplitude(spec.thresholdDb), ...THRESHOLD_RANGE);
  const makeup = clamp(dbToAmplitude(spec.makeupDb), ...MAKEUP_RANGE);
  const filter =
    `sidechaincompress=threshold=${num(threshold)}:ratio=${num(clamp(spec.ratio, ...RATIO_RANGE))}` +
    `:attack=${num(clamp(spec.attackMs, ...ATTACK_RANGE))}:release=${num(clamp(spec.releaseMs, ...RELEASE_RANGE))}` +
    `:makeup=${num(makeup)}`;
  return {
    label: ctx.chain([target.label, sidechain.label], [filter], "a"),
    samples: target.samples,
  };
}

/** 発話区間（秒）。`--simple` ダッキングの事前解析（`silencedetect`）の結果 */
export interface DuckWindow {
  from: number;
  to: number;
}

/**
 * `--simple` ダッキング（docs/07 §8.3 のフォールバック）。
 * 事前解析で得た発話区間を `volume='if(between(t,s,e)+...,{ducked},1)':eval=frame` で下げる。
 * 解析は I/O なのでグラフの外（ffmpeg/audio-analysis.ts）で行い、結果だけを受け取る。
 */
export function simpleDuck(
  ctx: GraphContext,
  target: AudioStream,
  windows: readonly DuckWindow[],
  duckDb: number,
): AudioStream {
  if (!windows.length) return target;
  const cond = windows.map((w) => `between(t,${num(w.from)},${num(w.to)})`).join("+");
  const filter = `volume='if(${cond},${num(dbToAmplitude(duckDb))},1)':eval=frame`;
  return { label: ctx.chain(target.label, [filter], "a"), samples: target.samples };
}

// ---------------------------------------------------------------------------
// ラウドネス正規化（docs/07 §8.4）
// ---------------------------------------------------------------------------

/** `loudnorm` のパス 1（測定）の結果。ffmpeg が `print_format=json` で出す値 */
export interface LoudnormMeasured {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

export interface LoudnormSpec {
  /** 目標統合ラウドネス（LUFS） */
  i: number;
  /** 目標トゥルーピーク（dBTP） */
  tp: number;
  /** 目標ラウドネスレンジ（LU） */
  lra: number;
  /** パス 1 の測定値。あれば 2 パス目（`linear=true`）、無ければ 1 パス（動的） */
  measured?: LoudnormMeasured | undefined;
}

/**
 * `[Aout]` 末尾に付ける `loudnorm`（docs/07 §8.4）。
 * `loudnorm` は内部で 192kHz に上げるので、後段で必ずプロジェクトの sample_rate / レイアウトへ戻す。
 */
export function loudnormFilters(ctx: GraphContext, spec: LoudnormSpec): string[] {
  const parts = [`loudnorm=I=${num(spec.i)}:TP=${num(spec.tp)}:LRA=${num(spec.lra)}`];
  const m = spec.measured;
  if (m) {
    parts.push(
      `measured_I=${num(m.input_i)}`,
      `measured_TP=${num(m.input_tp)}`,
      `measured_LRA=${num(m.input_lra)}`,
      `measured_thresh=${num(m.input_thresh)}`,
      `offset=${num(m.target_offset)}`,
      "linear=true",
    );
  }
  return [parts.join(":"), `aresample=${ctx.sampleRate}`, `aformat=sample_fmts=fltp:channel_layouts=${ctx.layout}`];
}
