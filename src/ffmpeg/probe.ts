/**
 * ffprobe ラッパ（docs/08 §2 `ffmpeg/probe.ts`, docs/05 §5 アセット要約, ADR-09, ADR-14）。
 *
 * - `probeFile()` が ffprobe を実行し、生 JSON（`.montash/cache/<id>/probe.json` へ保存する用）と
 *   `project.json` に載せる要約 `ProbeSummary` を返す
 * - `summarizeProbe()` は生 JSON → 要約の純関数（テスト容易性のため I/O と分離）
 * - `durationFrames()` は ADR-09 の `duration_f = floor(duration_s * num/den)`
 */
import { MontashError } from "../cli/errors.ts";
import type { Binaries } from "./locate.ts";
import { runFfprobeJson } from "./run.ts";

// TODO(core/time): `src/core/time.ts`（別担当が並行実装中）の Fps に差し替える。ここでは同形のローカル定義。
export interface Fps {
  num: number;
  den: number;
}

export interface VideoSummary {
  codec: string;
  width: number;
  height: number;
  fps: Fps;
  pix_fmt: string;
  has_alpha: boolean;
  /** 表示回転（度、0 / 90 / 180 / 270 に正規化） */
  rotation: number;
}

export interface AudioSummary {
  codec: string;
  sample_rate: number;
  channels: number;
}

export interface ProbeSummary {
  type: "video" | "audio" | "image";
  /** コンテナの尺（秒）。image は null */
  duration_s: number | null;
  /** コンテナの start_time（秒）。非 0 なら in/out 解釈時に補正する */
  start_time_s: number;
  video?: VideoSummary;
  audio?: AudioSummary;
  container: { format: string; bit_rate: number | null };
}

/** 静止画とみなす映像コーデック */
const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "gif", "tiff", "apng"]);
/** これ以下の尺しか持たない単一フレーム映像は静止画扱い */
const IMAGE_MAX_DURATION_S = 0.1;

// ---------------------------------------------------------------------------
// 有理数 fps / フレーム数
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * ffprobe の `r_frame_rate` / `avg_frame_rate`（"30000/1001", "30/1", "30"）を Fps にする。
 * "0/0" や非数など妥当でないものは null。約分して返す。
 */
export function parseRationalFps(r: string): Fps | null {
  const m = /^\s*(\d+)(?:\s*\/\s*(\d+))?\s*$/.exec(r);
  if (!m?.[1]) return null;
  const num = Number.parseInt(m[1], 10);
  const den = m[2] !== undefined ? Number.parseInt(m[2], 10) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/** ADR-09: `duration_f = floor(duration_s * num / den)`。float 誤差で 1 フレーム落ちないよう微小 ε を足す */
export function durationFrames(duration_s: number, fps: Fps): number {
  if (!(duration_s >= 0) || fps.num <= 0 || fps.den <= 0) return 0;
  return Math.floor((duration_s * fps.num) / fps.den + 1e-9);
}

// ---------------------------------------------------------------------------
// 生 JSON の走査ヘルパ（ffprobe の JSON は数値も文字列で来る）
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "" && v !== "N/A") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** side_data_list の Display Matrix、または tags.rotate から回転角を得る */
function readRotation(stream: Rec): number {
  let rot: number | undefined;
  const side = stream.side_data_list;
  if (Array.isArray(side)) {
    for (const sd of side) {
      if (isRec(sd) && typeof str(sd.side_data_type) === "string" && /display ?matrix/i.test(str(sd.side_data_type) ?? "")) {
        rot = num(sd.rotation);
        if (rot !== undefined) break;
      }
    }
  }
  if (rot === undefined && isRec(stream.tags)) rot = num(stream.tags.rotate);
  if (rot === undefined) return 0;
  // -90 → 270 のように 0..359 に正規化し、90 度単位に丸める
  const norm = ((Math.round(rot) % 360) + 360) % 360;
  return Math.round(norm / 90) * 90 % 360;
}

/** pix_fmt がアルファ面を持つか（yuva420p, rgba, argb, bgra, abgr, gbrap, ya8, ayuv, vuya 系。gray/pal8 は含めない） */
export function pixFmtHasAlpha(pixFmt: string | undefined): boolean {
  if (!pixFmt) return false;
  return /^(yuva|ya\d|rgba|argb|bgra|abgr|gbrap|ayuv|vuya|rgbaf|gbrapf)/.test(pixFmt);
}

/** r_frame_rate を優先し、avg_frame_rate と 1% 以上ずれる（可変フレームレートの疑い）なら avg を使う */
function readFps(stream: Rec): Fps {
  const r = parseRationalFps(str(stream.r_frame_rate) ?? "");
  const avg = parseRationalFps(str(stream.avg_frame_rate) ?? "");
  if (r && avg) {
    const rv = r.num / r.den;
    const av = avg.num / avg.den;
    if (Math.abs(rv - av) / rv > 0.01) return avg;
    return r;
  }
  return r ?? avg ?? { num: 0, den: 1 };
}

// ---------------------------------------------------------------------------
// 要約
// ---------------------------------------------------------------------------

/**
 * ffprobe の生 JSON（`-show_streams -show_format -of json`）を docs/05 §5 の要約に変換する（純関数）。
 * ストリームが 1 本も無ければ E_ASSET_UNREADABLE。
 */
export function summarizeProbe(raw: unknown): ProbeSummary {
  const root = isRec(raw) ? raw : {};
  const streams = Array.isArray(root.streams) ? root.streams.filter(isRec) : [];
  const format = isRec(root.format) ? root.format : {};

  // 映像: attached_pic（カバーアート）は除外して最初の映像ストリームを選ぶ
  const videoStreams = streams.filter((s) => str(s.codec_type) === "video");
  const v =
    videoStreams.find((s) => !(isRec(s.disposition) && num(s.disposition.attached_pic) === 1)) ??
    videoStreams[0];
  const a = streams.find((s) => str(s.codec_type) === "audio");
  if (!v && !a) {
    throw new MontashError("E_ASSET_UNREADABLE", "ffprobe found no video or audio stream", { detail: { streams: streams.length } });
  }

  const formatDuration = num(format.duration);
  const streamDuration = num(v?.duration) ?? num(a?.duration);
  const duration = formatDuration ?? streamDuration ?? null;
  const startTime = num(format.start_time) ?? num(v?.start_time) ?? 0;

  let type: ProbeSummary["type"];
  if (v) {
    const codec = str(v.codec_name) ?? "";
    const nbFrames = num(v.nb_frames);
    const vDuration = num(v.duration) ?? formatDuration;
    const isCoverArt = isRec(v.disposition) && num(v.disposition.attached_pic) === 1;
    const singleFrame = nbFrames === 1;
    const imageCodecShort = IMAGE_CODECS.has(codec) && (vDuration === undefined || vDuration <= IMAGE_MAX_DURATION_S);
    if (isCoverArt && a) type = "audio";
    else if ((singleFrame || imageCodecShort) && !a) type = "image";
    else type = "video";
  } else {
    type = "audio";
  }

  const summary: ProbeSummary = {
    type,
    duration_s: type === "image" ? null : duration,
    start_time_s: startTime,
    container: { format: str(format.format_name) ?? "unknown", bit_rate: num(format.bit_rate) ?? null },
  };

  if (v && type !== "audio") {
    const pixFmt = str(v.pix_fmt) ?? "";
    summary.video = {
      codec: str(v.codec_name) ?? "unknown",
      width: num(v.width) ?? 0,
      height: num(v.height) ?? 0,
      fps: readFps(v),
      pix_fmt: pixFmt,
      has_alpha: pixFmtHasAlpha(pixFmt),
      rotation: readRotation(v),
    };
  }
  if (a) {
    summary.audio = {
      codec: str(a.codec_name) ?? "unknown",
      sample_rate: num(a.sample_rate) ?? 0,
      channels: num(a.channels) ?? 0,
    };
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

/**
 * ファイルを ffprobe し、要約と生 JSON を返す。読めなければ E_ASSET_UNREADABLE（detail: path, stderr_tail）。
 */
export async function probeFile(bins: Binaries, path: string, opts: { timeoutMs?: number } = {}): Promise<{ summary: ProbeSummary; raw: unknown }> {
  const args = ["-v", "error", "-show_streams", "-show_format", "-of", "json", "-i", path];
  let raw: unknown;
  try {
    raw = await runFfprobeJson(bins, args, { timeoutMs: opts.timeoutMs ?? 30_000 });
  } catch (e) {
    if (e instanceof MontashError && e.code === "E_FFMPEG_NOT_FOUND") throw e;
    const tail = e instanceof MontashError && Array.isArray(e.detail?.stderr_tail) ? (e.detail.stderr_tail as string[]) : [];
    throw new MontashError("E_ASSET_UNREADABLE", `ffprobe could not read ${path}${tail.length ? `: ${tail.at(-1)}` : ""}`, {
      hint: "Check that the file exists and is a media file ffmpeg can decode.",
      detail: { path, stderr_tail: tail },
      cause: e,
    });
  }
  try {
    return { summary: summarizeProbe(raw), raw };
  } catch (e) {
    if (e instanceof MontashError) {
      throw new MontashError(e.code, `${e.message} (${path})`, { hint: e.hint, detail: { ...e.detail, path }, cause: e });
    }
    throw e;
  }
}
