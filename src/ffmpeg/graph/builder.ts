/**
 * フィルタグラフの組み立て（docs/07 §3〜§9）。
 *
 *   クリップ正規化（§3）→ トラック内連結 concat / xfade（§4）→ トラック間 overlay（§5）
 *   音声はクリップ正規化（§8.1）→ acrossfade（§8.2）→ adelay → トラック amix → master（§8.3）
 *
 * `render` と `preview build` が共通で使う。`opts.range` を渡すとその区間だけの映像グラフになり、
 * 出力の先頭が 0 フレームになる（プレビューのセグメント。§11.1）。
 */
import { MontashError } from "../../cli/errors.ts";
import { timelineDurationF } from "../../core/assets.ts";
import {
  type Clip,
  clipDurationF,
  clipEndF,
  isMediaClip,
  type Project,
  type Track,
  type Transition,
} from "../../core/schema.ts";
import { type AudioStream, delayAudio, fitAudio, foldAcrossfade, mixAudio, normalizeAudioClip } from "./audio.ts";
import { overlayPosition, overlayStream, type Transform } from "./overlay.ts";
import {
  type ClipGroup,
  clipHandles,
  foldXfade,
  groupByTransitions,
  indexTransitions,
  type TransitionIndex,
} from "./transitions.ts";
import {
  type FilterGraph,
  GraphContext,
  type GraphOptions,
  type GraphRange,
  type Stream,
  unsupported,
} from "./types.ts";
import { blankVideo, concatVideo, normalizeVideoClip, sliceVideo, type VideoFade } from "./video.ts";

// ---------------------------------------------------------------------------
// 対応していない構成の検出
// ---------------------------------------------------------------------------

function assertSupported(project: Project): void {
  if (project.audio.ducking.length) unsupported("audio ducking");
  if (![1, 2].includes(project.settings.channels)) unsupported("more than two audio channels");
  for (const track of project.tracks) {
    if (!track.clips.length || track.muted) continue;
    if (track.kind === "text") unsupported("text tracks");
    for (const clip of track.clips) {
      if (!isMediaClip(clip)) unsupported("text, subtitle or generator clips");
      if (clip.loop) unsupported("looped clips");
      if (clip.effects.length) unsupported("clip effects");
      if (clip.video?.lut) unsupported("3D LUTs");
    }
  }
}

// ---------------------------------------------------------------------------
// クリップの切り出し範囲（ハンドル延長）
// ---------------------------------------------------------------------------

interface ClipCut {
  clip: Clip;
  /** 素材の切り出し範囲（ハンドル延長込み） */
  srcIn: number;
  srcOut: number;
  /** タイムライン上の長さ */
  frames: number;
  /** 実際に前へ延ばせた量（タイムラインフレーム） */
  extIn: number;
}

/** `mode: handle` の延長を素材フレームへ換算する（速度変更時は `ext * speed`） */
function cutFor(clip: Clip, index: TransitionIndex): ClipCut {
  const { extIn, extOut } = clipHandles(clip.id, index);
  const speed = clip.speed;
  const srcExtIn = Math.min(clip.in_f, Math.round(extIn * speed));
  const realExtIn = speed === 1 ? srcExtIn : Math.round(srcExtIn / speed);
  return {
    clip,
    srcIn: clip.in_f - srcExtIn,
    srcOut: clip.out_f + Math.round(extOut * speed),
    frames: clipDurationF(clip) + realExtIn + extOut,
    extIn: realExtIn,
  };
}

// ---------------------------------------------------------------------------
// 映像
// ---------------------------------------------------------------------------

interface PlacedGroup {
  group: ClipGroup<Clip>;
  start_f: number;
  frames: number;
}

function videoGroups(project: Project, track: Track): { index: TransitionIndex; groups: PlacedGroup[] } {
  const index = indexTransitions(project.transitions, (t) => t.track === track.id);
  const clips = track.clips.filter(isMediaClip).sort((a, b) => a.start_f - b.start_f);
  const groups = groupByTransitions(clips, index).map((group) => {
    const first = group.clips[0]!;
    const last = group.clips[group.clips.length - 1]!;
    return { group, start_f: first.start_f, frames: clipEndF(last) - first.start_f };
  });
  return { index, groups };
}

/** 1 クリップを映像ストリームにする。`transform` / `opacity` があるものは背景の上に置く（§5） */
function clipStream(ctx: GraphContext, cut: ClipCut, overlayTrack: boolean): Stream {
  const v = cut.clip.video;
  const transform = (v?.transform ?? null) as Transform | null;
  const opacity = v?.opacity ?? 1;
  const keepAlpha = v?.keep_alpha ?? false;
  const placed = transform !== null;
  const alpha = placed || opacity < 1 || (overlayTrack && keepAlpha);
  const stream = normalizeVideoClip(ctx, cut, { fit: !placed, alpha });
  if (!placed || overlayTrack) return stream;
  // 下段トラックでは背景色の上に置いて全画面のストリームに戻す
  const background = blankVideo(ctx, cut.frames);
  return overlayStream(ctx, background, stream, 0, overlayPosition(transform, ctx.res));
}

/**
 * グループのうち `[from, to)`（グループ先頭からのフレーム）だけを作る。
 * トランジションもクリップフェードも無い単独クリップは、切り出しを素材側へたたみ込んで
 * 余計なデコード・スケールを避ける（プレビューのセグメント。docs/07 §11.1）。
 */
function groupStream(
  ctx: GraphContext,
  placed: PlacedGroup,
  index: TransitionIndex,
  overlayTrack: boolean,
  from: number,
  to: number,
): Stream {
  const only = placed.group.clips.length === 1 ? placed.group.clips[0]! : null;
  const fade = only?.video?.fade;
  if (only && !fade?.in_f && !fade?.out_f) {
    const cut = cutFor(only, index);
    const speed = only.speed;
    return clipStream(
      ctx,
      {
        ...cut,
        srcIn: cut.srcIn + Math.round(from * speed),
        srcOut: cut.srcIn + Math.round(to * speed),
        frames: to - from,
      },
      overlayTrack,
    );
  }
  const parts = placed.group.clips.map((clip) => clipStream(ctx, cutFor(clip, index), overlayTrack));
  return sliceVideo(ctx, foldXfade(ctx, parts, placed.group.transitions), from, to);
}

/**
 * フェード窓（タイムライン座標）をストリームのローカル座標へ落として `fade` を掛ける（docs/07 §4.3）。
 * 区間レンダーで窓が切れている場合は掛かる部分だけを近似的に適用する。
 */
function applyFade(
  ctx: GraphContext,
  stream: Stream,
  fade: VideoFade,
  streamStart: number,
  spanStart: number,
  spanEnd: number,
  alpha: boolean,
): Stream {
  const windows: Array<{ type: "in" | "out"; start: number; length: number }> = [];
  if (fade.in_f > 0) windows.push({ type: "in", start: spanStart, length: fade.in_f });
  if (fade.out_f > 0) windows.push({ type: "out", start: spanEnd - fade.out_f, length: fade.out_f });
  const filters: string[] = [];
  for (const w of windows) {
    let s = w.start - streamStart;
    let n = w.length;
    if (s < 0) {
      n += s;
      s = 0;
    }
    n = Math.min(n, stream.frames - s);
    if (n <= 0 || s >= stream.frames) continue;
    filters.push(`fade=t=${w.type}:s=${s}:n=${n}:color=${fade.color}${alpha ? ":alpha=1" : ""}`);
  }
  if (!filters.length) return stream;
  return { label: ctx.chain(stream.label, filters), frames: stream.frames };
}

/** 一番下の映像トラックを区間いっぱいの 1 本にする（ギャップは背景色。§4.1） */
function composeBaseTrack(ctx: GraphContext, track: Track, range: GraphRange, total: number): Stream {
  const { index, groups } = videoGroups(ctx.project, track);
  const pieces: Stream[] = [];
  let cursor = range.from_f;
  for (const placed of groups) {
    const end = placed.start_f + placed.frames;
    if (end <= range.from_f || placed.start_f >= range.to_f) continue;
    const from = Math.max(placed.start_f, range.from_f);
    const to = Math.min(end, range.to_f);
    if (from > cursor) pieces.push(blankVideo(ctx, from - cursor));
    pieces.push(groupStream(ctx, placed, index, false, from - placed.start_f, to - placed.start_f));
    cursor = to;
  }
  if (cursor < range.to_f) pieces.push(blankVideo(ctx, range.to_f - cursor));
  const joined = concatVideo(ctx, pieces);
  return applyFade(ctx, joined, track.fade, range.from_f, 0, total, false);
}

/** 上位の映像トラックを base に重ねる（§5） */
function overlayTrackOnto(ctx: GraphContext, base: Stream, track: Track, range: GraphRange): Stream {
  const { index, groups } = videoGroups(ctx.project, track);
  if (!groups.length) return base;
  const spanStart = groups[0]!.start_f;
  const spanEnd = groups[groups.length - 1]!.start_f + groups[groups.length - 1]!.frames;
  let out = base;
  for (const placed of groups) {
    const end = placed.start_f + placed.frames;
    if (end <= range.from_f || placed.start_f >= range.to_f) continue;
    const from = Math.max(placed.start_f, range.from_f);
    const to = Math.min(end, range.to_f);
    let item = groupStream(ctx, placed, index, true, from - placed.start_f, to - placed.start_f);
    item = applyFade(ctx, item, track.fade, from, spanStart, spanEnd, true);
    const transform = (placed.group.clips[0]!.video?.transform ?? null) as Transform | null;
    out = overlayStream(ctx, out, item, from - range.from_f, overlayPosition(transform, ctx.res));
  }
  return out;
}

function buildVideo(ctx: GraphContext, range: GraphRange, total: number): string {
  const frames = range.to_f - range.from_f;
  const tracks = ctx.project.tracks.filter((t) => t.kind === "video" && !t.muted && t.clips.length > 0);
  let base = tracks.length ? composeBaseTrack(ctx, tracks[0]!, range, total) : blankVideo(ctx, frames);
  for (const track of tracks.slice(1)) base = overlayTrackOnto(ctx, base, track, range);
  return ctx.chain(base.label, [`fps=${ctx.rate}`, `trim=end_frame=${frames}`, ctx.tb, "format=yuv420p"], "V");
}

// ---------------------------------------------------------------------------
// 音声
// ---------------------------------------------------------------------------

/**
 * `audio: crossfade` のトランジションを、リンクされた音声クリップの対に読み替える（§8.2）。
 * 映像クリップ同士のトランジションなので、`link` を辿って音声トラック上の対を作る。
 */
function audioTransitions(project: Project): Transition[] {
  const byId = new Map<string, { clip: Clip; kind: string }>();
  for (const track of project.tracks) {
    for (const clip of track.clips) if (isMediaClip(clip)) byId.set(clip.id, { clip, kind: track.kind });
  }
  const out: Transition[] = [];
  for (const tr of project.transitions) {
    if (tr.audio !== "crossfade") continue;
    const from = byId.get(tr.from);
    const to = byId.get(tr.to);
    if (!from || !to) continue;
    const a = from.kind === "audio" ? from.clip : from.clip.link ? byId.get(from.clip.link)?.clip : undefined;
    const b = to.kind === "audio" ? to.clip : to.clip.link ? byId.get(to.clip.link)?.clip : undefined;
    if (!a || !b) continue;
    out.push({ ...tr, from: a.id, to: b.id });
  }
  return out;
}

function audioGroupStream(ctx: GraphContext, group: ClipGroup<Clip>, index: TransitionIndex): AudioStream {
  const parts: AudioStream[] = [];
  let firstExtIn = 0;
  group.clips.forEach((clip, i) => {
    const cut = cutFor(clip, index);
    if (i === 0) firstExtIn = cut.extIn;
    const asset = ctx.asset(clip.asset);
    if (asset.type === "image") throw new MontashError("E_USAGE", `clip "${clip.id}" has no audio stream`);
    const input = ctx.addInput(["-i", ctx.opts.source(asset)]);
    const start = ctx.samples(cut.srcIn);
    parts.push(
      normalizeAudioClip(ctx, {
        stream: `${input}:a:0`,
        startSample: start,
        sourceSamples: ctx.samples(cut.srcOut) - start,
        samples: ctx.samples(cut.frames),
        gainDb: clip.audio?.gain_db ?? 0,
        fade: clip.audio?.fade,
        speed: clip.speed,
        pitchKeep: clip.pitch_keep,
      }),
    );
  });
  const folded = foldAcrossfade(
    ctx,
    parts,
    group.transitions.map((t) => ctx.samples(t.duration_f)),
  );
  const first = group.clips[0]!;
  const delay = ctx.samples(first.start_f - firstExtIn) + (first.audio?.offset_smp ?? 0);
  return delayAudio(ctx, folded, delay);
}

function buildAudio(ctx: GraphContext, total: number): string {
  const samples = ctx.samples(total);
  const index = indexTransitions(audioTransitions(ctx.project));
  const tracks: AudioStream[] = [];
  for (const track of ctx.project.tracks) {
    if (track.kind !== "audio" || track.muted || !track.clips.length) continue;
    const clips = track.clips
      .filter(isMediaClip)
      .filter((c) => !c.audio?.muted)
      .sort((a, b) => a.start_f - b.start_f);
    if (!clips.length) continue;
    const groups = groupByTransitions(clips, index).map((group) => audioGroupStream(ctx, group, index));
    const gain = ctx.project.audio.track_gain_db[track.id] ?? 0;
    let mixed = fitAudio(ctx, mixAudio(ctx, groups, samples), samples, gain ? [`volume=${gain}dB`] : []);
    // トラックフェード（`montash fade --track A1` / `--with-audio`）
    const fades: string[] = [];
    if (track.fade.in_f > 0) fades.push(`afade=t=in:ss=0:ns=${ctx.samples(track.fade.in_f)}:curve=tri`);
    if (track.fade.out_f > 0) {
      const n = ctx.samples(track.fade.out_f);
      fades.push(`afade=t=out:ss=${samples - n}:ns=${n}:curve=tri`);
    }
    if (fades.length) mixed = { label: ctx.chain(mixed.label, fades, "a"), samples };
    tracks.push(mixed);
  }
  const master = fitAudio(ctx, mixAudio(ctx, tracks, samples), samples, [
    `volume=${ctx.project.audio.master_gain_db}dB`,
  ]);
  return `[${master.label}]`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function buildGraph(project: Project, opts: GraphOptions): FilterGraph {
  const total = timelineDurationF(project);
  if (!total)
    throw new MontashError("E_EMPTY_TIMELINE", "cannot build a filter graph for an empty timeline", {
      hint: "Use `montash clip add` first.",
    });
  assertSupported(project);
  const wantVideo = opts.video ?? true;
  const wantAudio = opts.audio ?? true;
  if (!wantVideo && !wantAudio) throw new MontashError("E_USAGE", "a filter graph needs video, audio or both");
  const range = opts.range ?? { from_f: 0, to_f: total };
  if (opts.range && wantAudio)
    throw new MontashError("E_USAGE", "partial ranges are video only (audio is always built for the whole timeline)");
  if (
    !Number.isSafeInteger(range.from_f) ||
    !Number.isSafeInteger(range.to_f) ||
    range.from_f < 0 ||
    range.to_f <= range.from_f ||
    range.to_f > total
  )
    throw new MontashError("E_USAGE", `invalid render range f:${range.from_f}..f:${range.to_f} (timeline is ${total})`);

  const ctx = new GraphContext(project, opts);
  const mapVideo = wantVideo ? `[${buildVideo(ctx, range, total)}]` : "";
  const mapAudio = wantAudio ? buildAudio(ctx, total) : "";
  return {
    inputs: ctx.inputs,
    filterComplex: ctx.chains.join(";"),
    mapVideo,
    mapAudio,
    totalFrames: wantVideo ? range.to_f - range.from_f : total,
    fps: ctx.fps,
    resolution: ctx.res,
    warnings: ctx.warnings,
  };
}
