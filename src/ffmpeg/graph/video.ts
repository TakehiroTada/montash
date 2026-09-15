/**
 * 映像クリップの正規化（docs/07 §3）。
 *
 * すべての映像クリップをタイムラインの fps・pix_fmt に揃えてから連結する（`concat` / `xfade` の要件）。
 * `fit` は解像度に letterbox して合わせ、`native` は素材サイズのまま（overlay 用。docs/07 §5）。
 */
import { MontashError } from "../../cli/errors.ts";
import type { Clip, Resolution } from "../../core/schema.ts";
import { type GraphContext, type Stream, unsupported } from "./types.ts";

/** `tracks[].fade` / `clip.video.fade`（docs/05 §6） */
export interface VideoFade {
  in_f: number;
  out_f: number;
  color: string;
}

export interface VideoClipSpec {
  clip: Clip;
  /** 素材の切り出し範囲（ハンドル延長込み。docs/05 §7） */
  srcIn: number;
  srcOut: number;
  /** タイムライン上の長さ（フレーム） */
  frames: number;
}

/** `fit`: `WxH` に letterbox して合わせる / `alpha`: アルファを残す（overlay 用） */
export interface NormalizeMode {
  fit: boolean;
  alpha: boolean;
}

/** px 整数 または "12.5%" を ffmpeg の式にする。`base` は基準となる式（"iw" / "W" など） */
export function sizeExpr(value: number | string, base: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MontashError("E_USAGE", `invalid size value ${value}`);
    return String(Math.round(value));
  }
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(value.trim());
  if (!m) throw new MontashError("E_USAGE", `invalid size value ${JSON.stringify(value)} (use px or "12%")`);
  return `${base}*${m[1]}/100`;
}

/** 背景色のフレーム（ギャップ埋め。docs/07 §4.1） */
export function blankVideo(ctx: GraphContext, frames: number): Stream {
  const label = ctx.chain(
    [],
    [
      `color=c=${ctx.background}:s=${ctx.res.width}x${ctx.res.height}:r=${ctx.rate}`,
      `trim=end_frame=${frames}`,
      ctx.tb,
    ],
  );
  return { label, frames };
}

/** `fade=t=in|out:s={start_frame}:n={nb_frames}`（フレーム指定。docs/07 §3） */
export function fadeFilters(fade: VideoFade, frames: number, alpha: boolean): string[] {
  const out: string[] = [];
  const suffix = `:color=${fade.color}${alpha ? ":alpha=1" : ""}`;
  if (fade.in_f > 0) out.push(`fade=t=in:s=0:n=${Math.min(fade.in_f, frames)}${suffix}`);
  if (fade.out_f > 0) {
    const n = Math.min(fade.out_f, frames);
    out.push(`fade=t=out:s=${frames - n}:n=${n}${suffix}`);
  }
  return out;
}

/** クリップの `speed` を反映する（docs/07 §2）。`setpts=PTS/speed` → `fps=` → クローンで尺を保証 */
function speedFilters(ctx: GraphContext, speed: number): string[] {
  if (speed === 1) return [];
  return [`setpts=PTS/${speed}`, `fps=${ctx.rate}`, ctx.tb, "tpad=stop=-1:stop_mode=clone"];
}

function cropFilter(crop: { x: number | string; y: number | string; w: number | string; h: number | string }): string {
  return `crop=${sizeExpr(crop.w, "iw")}:${sizeExpr(crop.h, "ih")}:${sizeExpr(crop.x, "iw")}:${sizeExpr(crop.y, "ih")}`;
}

function colorFilter(color: Record<string, number | undefined>): string | null {
  const parts = (["brightness", "contrast", "saturation", "gamma"] as const)
    .filter((k) => typeof color[k] === "number")
    .map((k) => `${k}=${color[k]}`);
  return parts.length ? `eq=${parts.join(":")}` : null;
}

/**
 * 1 クリップを正規化して 1 本のストリームにする（docs/07 §3）。
 * 戻り値の `frames` は `spec.frames`（タイムライン上の長さ）で、`trim=end_frame` で固定される。
 */
export function normalizeVideoClip(ctx: GraphContext, spec: VideoClipSpec, mode: NormalizeMode): Stream {
  const { clip, srcIn, srcOut, frames } = spec;
  if (clip.loop) unsupported("looped video clips");
  if (clip.effects.length) unsupported("clip effects");
  const v = clip.video;
  if (v?.lut) unsupported("3D LUTs");
  const asset = ctx.asset(clip.asset);
  if (asset.type !== "video" && asset.type !== "image")
    throw new MontashError("E_USAGE", `clip "${clip.id}" references a ${asset.type} asset on a video track`);
  const path = ctx.opts.source(asset);
  const index = ctx.addInput(
    asset.type === "image" ? ["-loop", "1", "-framerate", ctx.rate, "-i", path] : ["-i", path],
  );

  const opacity = v?.opacity ?? 1;
  const alpha = mode.alpha;
  const filters: string[] = ["setpts=PTS-STARTPTS", `fps=${ctx.rate}`];
  // 画像は同じ 1 枚を繰り返すので長さだけを切り出す
  filters.push(
    asset.type === "image" ? `trim=end_frame=${srcOut - srcIn}` : `trim=start_frame=${srcIn}:end_frame=${srcOut}`,
  );
  filters.push(ctx.tb);
  if (v?.crop) filters.push(cropFilter(v.crop as never));
  if (mode.fit) {
    filters.push(
      `scale=${ctx.res.width}:${ctx.res.height}:force_original_aspect_ratio=decrease:flags=bicubic`,
      `pad=${ctx.res.width}:${ctx.res.height}:(ow-iw)/2:(oh-ih)/2:color=${ctx.background}`,
    );
  } else {
    const scale = v?.transform?.scale ?? 1;
    if (scale !== 1) filters.push(`scale=iw*${scale}:-2:flags=bicubic`);
  }
  filters.push("setsar=1");
  if (v?.color) {
    const eq = colorFilter(v.color as Record<string, number | undefined>);
    if (eq) filters.push(eq);
  }
  filters.push(`format=${alpha ? "yuva420p" : "yuv420p"}`);
  if (opacity < 1) filters.push(`colorchannelmixer=aa=${opacity}`);
  filters.push(...speedFilters(ctx, clip.speed));
  filters.push(`trim=end_frame=${frames}`, ctx.tb);
  if (v) filters.push(...fadeFilters(v.fade, frames, alpha));
  return { label: ctx.chain(`${index}:V:0`, filters), frames };
}

/** ストリームの一部だけを取り出す（区間レンダー。docs/07 §11.1） */
export function sliceVideo(ctx: GraphContext, stream: Stream, from: number, to: number): Stream {
  if (from === 0 && to === stream.frames) return stream;
  const label = ctx.chain(stream.label, [`trim=start_frame=${from}:end_frame=${to}`, ctx.tb]);
  return { label, frames: to - from };
}

/** 複数ストリームを `concat` で繋ぐ（docs/07 §4.1） */
export function concatVideo(ctx: GraphContext, streams: readonly Stream[]): Stream {
  if (streams.length === 0) throw new MontashError("E_USAGE", "cannot concat an empty video track");
  if (streams.length === 1) return streams[0]!;
  const frames = streams.reduce((n, s) => n + s.frames, 0);
  const label = ctx.chain(
    streams.map((s) => s.label),
    [`concat=n=${streams.length}:v=1:a=0`, `fps=${ctx.rate}`, `trim=end_frame=${frames}`, ctx.tb],
  );
  return { label, frames };
}

/** 解像度を人間向けに表示する（エラーメッセージ用） */
export function describeResolution(res: Resolution): string {
  return `${res.width}x${res.height}`;
}
