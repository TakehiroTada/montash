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
import type { DuckWindow, LoudnormSpec } from "./audio.ts";
import type { TextBurn } from "./text.ts";

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
  /**
   * テキスト・字幕の焼き込み（docs/07 §6）。ASS の生成・書き出しは `src/ffmpeg/text-prepare.ts` が
   * 行い、ここには**書き出し済みのパス**だけが渡る（グラフを純関数に保つため）。
   * `range` を指定する場合、渡す ASS は区間の先頭を 0 とした時刻にシフト済みであること。
   */
  text?: TextBurn;
  /**
   * `[Aout]` 末尾に付ける `loudnorm`（docs/07 §8.4）。省略すると正規化しない。
   * `measured` を含めると 2 パス目（`linear=true`）になる。
   */
  loudnorm?: LoudnormSpec | undefined;
  /**
   * `--simple` ダッキングの事前解析結果（ducking ID → サイドチェインの発話区間と音量）。
   * 解析は I/O なのでグラフの外（ffmpeg/audio-analysis.ts）で行う（docs/07 §8.3）。
   */
  ducking?: Record<string, DuckAnalysis> | undefined;
  /**
   * エフェクトの事前解析結果（クリップ ID → `target:effect` → 値。docs/14 §4 の Level C）。
   * ducking と同じく、解析は `ffmpeg/effect-analysis.ts` が行い、ここには**値だけ**が渡る。
   */
  effectAnalyses?: Record<string, Record<string, unknown>> | undefined;
}

/** `--simple` ダッキング 1 件ぶんの事前解析（docs/07 §8.3） */
export interface DuckAnalysis {
  /** サイドチェインが鳴っている区間（秒） */
  windows: DuckWindow[];
  /** サイドチェインのピーク音量（dBFS）。下げ幅の計算に使う */
  level_db: number;
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
  /**
   * 出力段に追加する引数（`-b:v 8M` / `-profile:v high` / `-tag:v hvc1` / `-pass 2` など）。
   * `-f <format> <path>` の直前に置かれる（docs/07 §9 のプリセット表・2 パス・hwaccel 用）。
   */
  extraArgs?: readonly string[];
  /** ソフト字幕の多重化（docs/07 §7 `mode: soft`）。入力はグラフの入力の後ろに足される */
  subtitles?: SoftSubtitle[];
}

/** 多重化するだけの字幕ストリーム 1 本（`-i subs.srt -c:s mov_text -metadata:s:s:N language=ja`） */
export interface SoftSubtitle {
  /** 字幕ファイル（絶対パス） */
  path: string;
  /** 出力側のコーデック（MP4 は `mov_text`、MKV は `srt` / `ass`） */
  codec: string;
  /** `language` メタデータ（ISO 639） */
  language?: string;
  /** 秒単位のずらし（`-itsoffset`） */
  offsetS?: string;
  /** `-disposition:s:N default` を付ける */
  default?: boolean;
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

/**
 * 本体が知らないクリップ種別（プラグイン由来）に当たったとき。docs/13 D-14、F-EXT-4。
 * **読み込み・保存は通す**。レンダーしようとしたときにだけここで止める。
 */
export function pluginMissing(clipId: string, type: string): never {
  throw new MontashError("E_PLUGIN_MISSING", `clip "${clipId}" has unknown type "${type}"`, {
    hint: `No registered plugin provides clip type "${type}". Install it, or remove the clip with \`montash clip delete ${clipId}\`.`,
    detail: { clip: clipId, clip_type: type },
  });
}

export function unsupported(what: string): never {
  throw new MontashError("E_NOT_IMPLEMENTED", `the filter graph does not support ${what} yet`, {
    hint: "Text tracks, looped clips, LUTs and keyframed effects arrive in later milestones.",
  });
}
