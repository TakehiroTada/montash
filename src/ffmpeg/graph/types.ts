/**
 * フィルタグラフの共通型と組み立てコンテキスト（docs/07 §1）。
 *
 * `render` と `preview build` は同じ `buildGraph()` を使い、出力設定（OutputSpec）と
 * 入力パス（プロキシかどうか）・区間（プレビューのセグメント）だけが異なる。
 * このディレクトリのモジュールはすべて純関数で、ファイル I/O をしない。
 */
import { MontashError, type Warning } from "../../cli/errors.ts";
import type { Asset, Fps, Project, Resolution } from "../../core/schema.ts";
import { framesToSamples, framesToSecString } from "../../core/time.ts";

/** 1 入力ぶんの ffmpeg 引数（`["-i", path]` / `["-loop","1","-framerate","30/1","-i",path]`） */
export type GraphInput = string[];

export interface FilterGraph {
  inputs: GraphInput[];
  /** `-filter_complex` に 1 引数で渡す文字列 */
  filterComplex: string;
  /** `-map` に渡すラベル（映像を作らない場合は空文字） */
  mapVideo: string;
  mapAudio: string;
  /** 出力フレーム数（区間レンダーでは区間長） */
  totalFrames: number;
  fps: Fps;
  resolution: Resolution;
  warnings: Warning[];
}

/** 部分レンダー（プレビューのセグメント）。出力は `[from_f, to_f)` で先頭が 0 フレームになる */
export interface GraphRange {
  from_f: number;
  to_f: number;
}

export interface GraphOptions {
  resolution: Resolution;
  /** アセット → ffmpeg に渡す入力パス（プレビューはプロキシに差し替える） */
  source: (asset: Asset) => string;
  /** 区間レンダー（映像のみ。音声は常にタイムライン全体） */
  range?: GraphRange;
  /** 映像を組み立てる（既定 true） */
  video?: boolean;
  /** 音声を組み立てる（既定 true） */
  audio?: boolean;
}

// ---------------------------------------------------------------------------
// 出力設定（docs/07 §9）
// ---------------------------------------------------------------------------

export interface VideoOutput {
  codec: string;
  preset?: string;
  crf?: number;
  pixFmt?: string;
  /** GOP 長（フレーム） */
  gop?: number;
  /** `-video_track_timescale`（セグメントを `-c copy` で繋ぐときに揃える） */
  trackTimescale?: number;
}

export interface AudioOutput {
  codec: string;
  bitrate?: string;
  sampleRate: number;
  channels: number;
}

export interface OutputSpec {
  path: string;
  /** `-f` のフォーマット名 */
  format: string;
  /** 省略すると `-vn` */
  video?: VideoOutput;
  /** 省略すると `-an` */
  audio?: AudioOutput;
  threads?: number;
  /** `-movflags +faststart` */
  faststart?: boolean;
}

// ---------------------------------------------------------------------------
// 組み立てコンテキスト
// ---------------------------------------------------------------------------

/** 名前付きストリーム（フィルタ出力ラベルとタイムライン上の長さ） */
export interface Stream {
  label: string;
  frames: number;
}

const COLOR_RE = /^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|[a-zA-Z]+)$/;

/**
 * グラフ組み立て中の状態（入力・チェーン・ラベル採番）。
 * 個々のモジュール（video / transitions / audio / overlay）はこれを受け取ってチェーンを積む。
 */
export class GraphContext {
  readonly project: Project;
  readonly opts: GraphOptions;
  readonly fps: Fps;
  /** `num/den`（`fps=` / `-r` に渡す） */
  readonly rate: string;
  readonly res: Resolution;
  readonly sampleRate: number;
  /** `mono` / `stereo` */
  readonly layout: string;
  readonly background: string;
  /** フレーム番号で pts を数え直す定型（docs/07 §13「xfade が VFR 入力で失敗」への対策） */
  readonly tb: string;
  readonly chains: string[] = [];
  readonly inputs: GraphInput[] = [];
  readonly warnings: Warning[] = [];
  private counter = 0;

  constructor(project: Project, opts: GraphOptions) {
    this.project = project;
    this.opts = opts;
    this.fps = project.settings.fps;
    this.rate = `${this.fps.num}/${this.fps.den}`;
    this.res = opts.resolution;
    this.sampleRate = project.settings.sample_rate;
    this.layout = project.settings.channels === 1 ? "mono" : "stereo";
    this.background = project.settings.background;
    if (!COLOR_RE.test(this.background)) throw new MontashError("E_USAGE", "unsupported background color");
    if (this.res.width % 2 || this.res.height % 2)
      throw new MontashError("E_USAGE", "H.264 output width and height must be even");
    this.tb = `settb=expr=${this.fps.den}/${this.fps.num},setpts=N`;
  }

  label(prefix = "v"): string {
    return `${prefix}${this.counter++}`;
  }

  addInput(args: GraphInput): number {
    this.inputs.push(args);
    return this.inputs.length - 1;
  }

  push(chain: string): void {
    this.chains.push(chain);
  }

  /** `[in...]filters[out]` を積んで out ラベルを返す。`inputs` が空なら発生源フィルタ */
  chain(inputs: string | readonly string[], filters: readonly string[], prefix = "v"): string {
    const label = this.label(prefix);
    const head = (typeof inputs === "string" ? [inputs] : inputs).map((l) => `[${l}]`).join("");
    this.push(`${head}${filters.join(",")}[${label}]`);
    return label;
  }

  asset(id: string): Asset {
    const asset = this.project.assets[id];
    if (!asset) throw new MontashError("E_ASSET_NOT_FOUND", `asset "${id}" not found`);
    return asset;
  }

  /** フレーム → 秒文字列（マイクロ秒精度。`xfade=offset` 用。docs/07 §4.2） */
  secs(frames: number): string {
    return framesToSecString(frames, this.fps);
  }

  /** フレーム → サンプル数（docs/07 §8） */
  samples(frames: number): number {
    return framesToSamples(frames, this.fps, this.sampleRate);
  }

  warn(code: string, message: string): void {
    this.warnings.push({ code, message });
  }
}

export function unsupported(what: string): never {
  throw new MontashError("E_NOT_IMPLEMENTED", `the filter graph does not support ${what} yet`, {
    hint: "Ducking, text tracks, looped clips, LUTs and keyframed effects arrive in later milestones.",
  });
}
