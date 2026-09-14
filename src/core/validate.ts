/**
 * プロジェクトの不変条件検査（docs/05 §14, docs/04 §3 validate）。
 *
 * zod スキーマ（形の検査）を通った Project に対して、参照整合性・区間・ハンドルなどの意味的な条件を検査する。
 * 結果は error / warning に分け、`strict` で一部の warning を error に格上げする。
 * ファイル存在は `checkFiles` 時のみ（I/O を伴うため）。
 *
 * 未実装（他モジュールの担当）: §14.9 の HEAD 一致（history）、`--deep` の ffmpeg デコード確認（ffmpeg）。
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type Asset,
  type Clip,
  clipDurationF,
  clipEndF,
  clipKind,
  isMediaClip,
  isSubtitleClip,
  isTextClip,
  type Project,
  type Track,
  type TrackClip,
  type Transition,
} from "./schema.ts";

export { clipDurationF, clipEndF, clipKind } from "./schema.ts";

export interface Issue {
  code: string;
  message: string;
  /** JSON Pointer 風のパス（"/tracks/0/clips/2"） */
  path?: string;
  hint?: string;
  detail?: Record<string, unknown>;
}

export interface ValidateOptions {
  /** アセットファイルの存在を確認する（`--deep`） */
  checkFiles?: boolean;
  /** ギャップ・fps 不一致などの warning を error にする（`--strict`） */
  strict?: boolean;
  /** 相対パス解決の基準（プロジェクトルート）。checkFiles 時に使う */
  dir?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** トランジションのハンドル延長量（docs/05 §7）。`ext_from = ceil(d/2)`, `ext_to = d - ext_from` */
export function handleExtension(durationF: number): { ext_from: number; ext_to: number } {
  const ext_from = Math.ceil(durationF / 2);
  return { ext_from, ext_to: durationF - ext_from };
}

/** 整数区間 [aStart, aEnd) と [bStart, bEnd) が重なるか */
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 手元で使う検査コンテキスト */
class Collector {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  constructor(private readonly strict: boolean) {}
  error(issue: Issue): void {
    this.errors.push(issue);
  }
  /** strict なら error、そうでなければ warning */
  warn(issue: Issue, promoteOnStrict = true): void {
    if (this.strict && promoteOnStrict) this.errors.push({ ...issue, detail: { ...(issue.detail ?? {}), promoted_by: "strict" } });
    else this.warnings.push(issue);
  }
}

export function validateProject(project: Project, opts: ValidateOptions = {}): ValidationResult {
  const c = new Collector(Boolean(opts.strict));

  checkIntegerFields(project, "", c);
  checkSettings(project, c);
  const trackById = checkTracks(project, c);
  const clipIndex = indexClips(project, c);
  checkClips(project, trackById, c);
  checkLinks(clipIndex, c);
  const overlapExempt = checkTransitions(project, trackById, clipIndex, c);
  checkOverlaps(project, overlapExempt, c);
  checkGaps(project, c);
  checkBeyondTimeline(project, c);
  checkAudioSettings(project, trackById, c);
  if (opts.checkFiles) checkFiles(project, opts.dir ?? process.cwd(), c);

  return { ok: c.errors.length === 0, errors: c.errors, warnings: c.warnings };
}

// ---------------------------------------------------------------------------
// §14.1 整数性
// ---------------------------------------------------------------------------

function checkIntegerFields(value: unknown, path: string, c: Collector): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkIntegerFields(v, `${path}/${i}`, c));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = `${path}/${k}`;
    if (k.endsWith("_f") || k.endsWith("_smp")) {
      if (v === null || v === undefined) continue;
      if (typeof v !== "number" || !Number.isSafeInteger(v)) {
        c.error({ code: "E_FRAME_NOT_INTEGER", message: `${p} must be a safe integer (got ${JSON.stringify(v)})`, path: p, hint: "Times are stored as integer frames (_f) / samples (_smp). Use f:<n> input or round the value." });
        continue;
      }
      // offset_smp / offset_f は負も可（同期の前倒し）
      if (k.endsWith("_f") && !k.startsWith("offset") && v < 0) {
        c.error({ code: "E_FRAME_NEGATIVE", message: `${p} must be >= 0 (got ${v})`, path: p });
      }
    }
    checkIntegerFields(v, p, c);
  }
}

// ---------------------------------------------------------------------------
// §14.10 settings
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function checkSettings(project: Project, c: Collector): void {
  const { fps, resolution } = project.settings;
  if (!Number.isSafeInteger(fps.num) || !Number.isSafeInteger(fps.den) || fps.num <= 0 || fps.den <= 0) {
    c.error({ code: "E_FPS_INVALID", message: `settings.fps must be positive integers (got ${fps.num}/${fps.den})`, path: "/settings/fps" });
  } else if (gcd(fps.num, fps.den) !== 1) {
    const g = gcd(fps.num, fps.den);
    c.error({ code: "E_FPS_INVALID", message: `settings.fps ${fps.num}/${fps.den} is not in lowest terms`, path: "/settings/fps", hint: `Use ${fps.num / g}/${fps.den / g}.` });
  }
  if (resolution.width % 2 !== 0 || resolution.height % 2 !== 0) {
    c.error({ code: "E_RESOLUTION_ODD", message: `settings.resolution ${resolution.width}x${resolution.height} must be even (yuv420p)`, path: "/settings/resolution" });
  }
}

// ---------------------------------------------------------------------------
// §14.7 tracks
// ---------------------------------------------------------------------------

function checkTracks(project: Project, c: Collector): Map<string, Track> {
  const byId = new Map<string, Track>();
  project.tracks.forEach((t, i) => {
    if (byId.has(t.id)) c.error({ code: "E_TRACK_ID_DUPLICATE", message: `track id "${t.id}" is duplicated`, path: `/tracks/${i}` });
    else byId.set(t.id, t);
  });
  return byId;
}

interface ClipRef {
  clip: TrackClip;
  track: Track;
  trackIndex: number;
  clipIndex: number;
  path: string;
}

function indexClips(project: Project, c: Collector): Map<string, ClipRef> {
  const index = new Map<string, ClipRef>();
  project.tracks.forEach((track, ti) => {
    track.clips.forEach((clip, ci) => {
      const path = `/tracks/${ti}/clips/${ci}`;
      if (index.has(clip.id)) {
        c.error({ code: "E_CLIP_ID_DUPLICATE", message: `clip id "${clip.id}" is duplicated (also at ${index.get(clip.id)!.path})`, path });
        return;
      }
      index.set(clip.id, { clip, track, trackIndex: ti, clipIndex: ci, path });
    });
  });
  return index;
}

// ---------------------------------------------------------------------------
// §14.2, §14.3, §14.7, §14.8 clips
// ---------------------------------------------------------------------------

const MEDIA_ASSET_TYPES: ReadonlySet<Asset["type"]> = new Set(["video", "audio", "image"]);

function checkClips(project: Project, _trackById: Map<string, Track>, c: Collector): void {
  const fps = project.settings.fps;
  const res = project.settings.resolution;
  project.tracks.forEach((track, ti) => {
    track.clips.forEach((clip, ci) => {
      const path = `/tracks/${ti}/clips/${ci}`;
      const kind = clipKind(clip);

      // kind に合わないクリップ種別（§14.7）
      const allowed = track.kind === "text" ? kind === "text" || kind === "subtitle" : kind === "media" || kind === "generator";
      if (!allowed) {
        c.error({ code: "E_CLIP_KIND_MISMATCH", message: `clip "${clip.id}" (${kind}) cannot be placed on ${track.kind} track "${track.id}"`, path, hint: track.kind === "text" ? "Text tracks hold text/subtitle clips only." : "Media/generator clips belong on video or audio tracks." });
      }

      if (isMediaClip(clip)) {
        const asset = project.assets[clip.asset];
        if (!asset) {
          c.error({ code: "E_ASSET_NOT_FOUND", message: `clip "${clip.id}" references unknown asset "${clip.asset}"`, path: `${path}/asset`, hint: "Run `montash assets list` to see available assets, or `montash import` the file.", detail: { clip: clip.id, asset: clip.asset } });
        } else {
          if (!MEDIA_ASSET_TYPES.has(asset.type)) {
            c.error({ code: "E_ASSET_TYPE_MISMATCH", message: `clip "${clip.id}" references ${asset.type} asset "${asset.id}"; media clips need video/audio/image`, path: `${path}/asset` });
          }
          if (track.kind === "video" && asset.type === "audio") {
            c.error({ code: "E_CLIP_KIND_MISMATCH", message: `audio asset "${asset.id}" (clip "${clip.id}") cannot be placed on video track "${track.id}"`, path });
          }
          if (track.kind === "audio" && asset.type === "image") {
            c.error({ code: "E_CLIP_KIND_MISMATCH", message: `image asset "${asset.id}" (clip "${clip.id}") cannot be placed on audio track "${track.id}"`, path });
          }
          checkRange(clip, asset, path, c);
          checkAssetMismatch(clip, asset, track, fps, res, path, c);
        }
      } else if (isTextClip(clip)) {
        if (clip.asset !== null) {
          const asset = project.assets[clip.asset];
          if (!asset) c.error({ code: "E_ASSET_NOT_FOUND", message: `text clip "${clip.id}" references unknown asset "${clip.asset}"`, path: `${path}/asset` });
          else if (asset.type !== "text") c.error({ code: "E_ASSET_TYPE_MISMATCH", message: `text clip "${clip.id}" must reference a text asset (got ${asset.type} "${asset.id}")`, path: `${path}/asset`, hint: "Create one with `montash assets new-text`." });
        }
      } else if (isSubtitleClip(clip)) {
        const asset = project.assets[clip.asset];
        if (!asset) c.error({ code: "E_ASSET_NOT_FOUND", message: `subtitle clip "${clip.id}" references unknown asset "${clip.asset}"`, path: `${path}/asset` });
        else if (asset.type !== "subtitle") c.error({ code: "E_ASSET_TYPE_MISMATCH", message: `subtitle clip "${clip.id}" must reference a subtitle asset (got ${asset.type} "${asset.id}")`, path: `${path}/asset` });
      } else if (kind === "generator" && "generator" in clip && clip.generator === "hold") {
        const from = clip.params.from_clip;
        if (typeof from !== "string") c.error({ code: "E_CLIP_NOT_FOUND", message: `hold generator "${clip.id}" needs params.from_clip`, path: `${path}/params` });
      }
    });
  });
}

/** §14.3: 0 <= in_f < out_f <= asset.duration_f（image は out_f > in_f のみ） */
function checkRange(clip: Clip, asset: Asset, path: string, c: Collector): void {
  if (clip.in_f >= clip.out_f) {
    c.error({ code: "E_RANGE_OUT_OF_ASSET", message: `clip "${clip.id}": in (f:${clip.in_f}) must be < out (f:${clip.out_f})`, path, detail: { clip: clip.id, in_f: clip.in_f, out_f: clip.out_f } });
    return;
  }
  if (asset.type === "image") return;
  const dur = asset.duration_f;
  if (typeof dur === "number" && !clip.loop && clip.out_f > dur) {
    c.error({
      code: "E_RANGE_OUT_OF_ASSET",
      message: `clip "${clip.id}": out (f:${clip.out_f}) exceeds asset duration (f:${dur}) for asset '${asset.id}'`,
      path: `${path}/out_f`,
      hint: `Use out <= f:${dur}, or set loop: true.`,
      detail: { clip: clip.id, asset: asset.id, asset_duration_f: dur, requested_out_f: clip.out_f },
    });
  }
}

/** fps / 解像度の不一致（warning、strict で error） */
function checkAssetMismatch(clip: Clip, asset: Asset, track: Track, fps: Project["settings"]["fps"], res: Project["settings"]["resolution"], path: string, c: Collector): void {
  if (asset.type !== "video") return;
  const v = asset.video;
  if (!v) return;
  if (v.fps && (v.fps.num !== fps.num || v.fps.den !== fps.den)) {
    c.warn({ code: "W_ASSET_MISMATCH", message: `asset "${asset.id}" (clip "${clip.id}") is ${v.fps.num}/${v.fps.den} fps; project is ${fps.num}/${fps.den}`, path, hint: "Frames are converted at render time (fps= filter). If most assets share this fps, consider `montash project set fps`.", detail: { asset: asset.id, asset_fps: v.fps, project_fps: fps } });
  }
  const fullFrame = track.kind === "video" && !clip.video?.transform;
  if (fullFrame && v.width && v.height && (v.width !== res.width || v.height !== res.height)) {
    c.warn({ code: "W_ASSET_MISMATCH", message: `asset "${asset.id}" (clip "${clip.id}") is ${v.width}x${v.height}; project is ${res.width}x${res.height}`, path, hint: "The clip is scaled to the project resolution at render time.", detail: { asset: asset.id, asset_resolution: { width: v.width, height: v.height }, project_resolution: res } });
  }
}

// ---------------------------------------------------------------------------
// §14.6 link
// ---------------------------------------------------------------------------

function checkLinks(index: Map<string, ClipRef>, c: Collector): void {
  const reportedPairs = new Set<string>();
  for (const ref of index.values()) {
    const clip = ref.clip;
    if (!isMediaClip(clip) || clip.link === null) continue;
    const other = index.get(clip.link);
    if (!other) {
      c.error({ code: "E_LINK_NOT_FOUND", message: `clip "${clip.id}" links to unknown clip "${clip.link}"`, path: `${ref.path}/link`, hint: "Set link to null or to an existing clip id." });
      continue;
    }
    const o = other.clip;
    if (!isMediaClip(o) || o.link !== clip.id) {
      c.error({ code: "E_LINK_MISMATCH", message: `clip "${clip.id}" links to "${o.id}" but "${o.id}" does not link back`, path: `${ref.path}/link`, hint: "Links must be reciprocal." });
      continue;
    }
    if (o.start_f !== clip.start_f || clipDurationF(o) !== clipDurationF(clip)) {
      // 相互参照なので両側から見つかる。1 対につき 1 回だけ報告する
      const pairKey = [clip.id, o.id].sort().join("|");
      if (reportedPairs.has(pairKey)) continue;
      reportedPairs.add(pairKey);
      c.error({
        code: "E_LINK_MISMATCH",
        message: `linked clips "${clip.id}" and "${o.id}" differ in start/duration (f:${clip.start_f}+${clipDurationF(clip)} vs f:${o.start_f}+${clipDurationF(o)})`,
        path: ref.path,
        hint: "Unlink them (`montash clip unlink`) or move/trim them together.",
        detail: { clip: clip.id, link: o.id },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// §14.5 transitions
// ---------------------------------------------------------------------------

/** overlap モードで重なりを許すクリップ対（"from|to"） */
type OverlapExempt = Set<string>;

function checkTransitions(project: Project, trackById: Map<string, Track>, index: Map<string, ClipRef>, c: Collector): OverlapExempt {
  const exempt: OverlapExempt = new Set();
  const seen = new Set<string>();
  project.transitions.forEach((tr, i) => {
    const path = `/transitions/${i}`;
    if (seen.has(tr.id)) c.error({ code: "E_TRANSITION_ID_DUPLICATE", message: `transition id "${tr.id}" is duplicated`, path });
    seen.add(tr.id);

    const track = trackById.get(tr.track);
    if (!track) {
      c.error({ code: "E_TRACK_NOT_FOUND", message: `transition "${tr.id}" references unknown track "${tr.track}"`, path: `${path}/track` });
      return;
    }
    const from = index.get(tr.from);
    const to = index.get(tr.to);
    if (!from) c.error({ code: "E_CLIP_NOT_FOUND", message: `transition "${tr.id}": from clip "${tr.from}" not found`, path: `${path}/from` });
    if (!to) c.error({ code: "E_CLIP_NOT_FOUND", message: `transition "${tr.id}": to clip "${tr.to}" not found`, path: `${path}/to` });
    if (!from || !to) return;
    if (from.track.id !== tr.track || to.track.id !== tr.track) {
      c.error({ code: "E_TRANSITION_TRACK_MISMATCH", message: `transition "${tr.id}" is on track "${tr.track}" but clips are on "${from.track.id}" / "${to.track.id}"`, path });
      return;
    }
    if (tr.from === tr.to) {
      c.error({ code: "E_TRANSITION_NOT_ADJACENT", message: `transition "${tr.id}": from and to are the same clip "${tr.from}"`, path });
      return;
    }

    // 隣接: from の直後のクリップが to
    const sorted = [...track.clips].sort((a, b) => a.start_f - b.start_f);
    const fi = sorted.findIndex((k) => k.id === tr.from);
    const next = sorted[fi + 1];
    if (!next || next.id !== tr.to) {
      c.error({ code: "E_TRANSITION_NOT_ADJACENT", message: `transition "${tr.id}": clips "${tr.from}" and "${tr.to}" are not adjacent on track "${tr.track}"`, path, hint: "Transitions join consecutive clips only." });
      return;
    }
    const fromEnd = clipEndF(from.clip);
    if (tr.mode === "handle") {
      if (fromEnd !== to.clip.start_f) {
        c.error({ code: "E_TRANSITION_NOT_ADJACENT", message: `transition "${tr.id}": "${tr.from}" ends at f:${fromEnd} but "${tr.to}" starts at f:${to.clip.start_f}`, path, hint: "In handle mode the clips must touch (from.end_f == to.start_f). Close the gap or use mode: overlap." });
      }
      checkHandles(tr, from.clip, to.clip, project, path, c);
    } else {
      const overlap = fromEnd - to.clip.start_f;
      if (overlap !== tr.duration_f) {
        c.error({ code: "E_TRANSITION_NOT_ADJACENT", message: `transition "${tr.id}" (overlap): clips overlap by f:${overlap} but duration_f is ${tr.duration_f}`, path, hint: "In overlap mode to.start_f must equal from.end_f - duration_f." });
      } else {
        exempt.add(`${tr.from}|${tr.to}`);
      }
    }
  });
  return exempt;
}

/** ハンドル充足: from.out_f + ext_from <= from.asset.duration_f、to.in_f - ext_to >= 0 */
function checkHandles(tr: Transition, from: TrackClip, to: TrackClip, project: Project, path: string, c: Collector): void {
  const { ext_from, ext_to } = handleExtension(tr.duration_f);
  let availFrom = Number.POSITIVE_INFINITY;
  let availTo = Number.POSITIVE_INFINITY;
  if (isMediaClip(from)) {
    const a = project.assets[from.asset];
    const dur = a && a.type !== "image" ? a.duration_f : null;
    if (typeof dur === "number" && !from.loop) availFrom = dur - from.out_f;
  }
  if (isMediaClip(to)) {
    if (!to.loop) availTo = to.in_f;
  }
  if (ext_from > availFrom || ext_to > availTo) {
    // ceil(d/2) <= availFrom かつ floor(d/2) <= availTo を満たす最大 d
    const maxD = Math.max(0, Math.min(Number.isFinite(availFrom) ? 2 * availFrom : Number.MAX_SAFE_INTEGER, Number.isFinite(availTo) ? 2 * availTo + 1 : Number.MAX_SAFE_INTEGER));
    c.error({
      code: "E_INSUFFICIENT_HANDLE",
      message: `transition "${tr.id}" needs ${ext_from} frame(s) after "${from.id}" and ${ext_to} before "${to.id}" but only ${fmtAvail(availFrom)} / ${fmtAvail(availTo)} are available`,
      path,
      hint: maxD > 0 ? `Use duration_f <= ${maxD}, or --mode overlap.` : "Trim the clips to leave handles, or use --mode overlap.",
      detail: { transition: tr.id, ext_from, ext_to, available_from: fmtAvail(availFrom), available_to: fmtAvail(availTo), max_duration_f: maxD },
    });
  }
}

function fmtAvail(n: number): number | string {
  return Number.isFinite(n) ? n : "unlimited";
}

// ---------------------------------------------------------------------------
// §14.4 overlaps
// ---------------------------------------------------------------------------

function checkOverlaps(project: Project, exempt: OverlapExempt, c: Collector): void {
  project.tracks.forEach((track, ti) => {
    const items = track.clips
      .map((clip, ci) => ({ clip, ci, start: clip.start_f, end: clipEndF(clip) }))
      .filter((x) => !isSubtitleClip(x.clip)) // 字幕は長さを持たない
      .sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]!;
      const cur = items[i]!;
      if (!rangesOverlap(prev.start, prev.end, cur.start, cur.end)) continue;
      if (exempt.has(`${prev.clip.id}|${cur.clip.id}`)) continue;
      c.error({
        code: "E_CLIP_OVERLAP",
        message: `clips "${prev.clip.id}" [f:${prev.start}, f:${prev.end}) and "${cur.clip.id}" [f:${cur.start}, f:${cur.end}) overlap on track "${track.id}"`,
        path: `/tracks/${ti}/clips/${cur.ci}`,
        hint: `Move "${cur.clip.id}" to f:${prev.end} or later, or trim "${prev.clip.id}".`,
        detail: { track: track.id, a: prev.clip.id, b: cur.clip.id, overlap_f: Math.min(prev.end, cur.end) - Math.max(prev.start, cur.start) },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// ギャップ（映像トラック全体で素材の無い区間）
// ---------------------------------------------------------------------------

export interface Gap {
  from_f: number;
  to_f: number;
}

/** 全 video トラックの合併で [0, duration) を覆えていない区間 */
export function findVideoGaps(project: Project): Gap[] {
  const ranges: Array<[number, number]> = [];
  let duration = 0;
  for (const track of project.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const end = clipEndF(clip);
      if (end > clip.start_f) ranges.push([clip.start_f, end]);
      if (end > duration) duration = end;
    }
  }
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) gaps.push({ from_f: cursor, to_f: s });
    if (e > cursor) cursor = e;
  }
  return gaps;
}

function checkGaps(project: Project, c: Collector): void {
  for (const g of findVideoGaps(project)) {
    c.warn({
      code: "W_GAP",
      message: `no video between f:${g.from_f} and f:${g.to_f} (${g.to_f - g.from_f} frame(s); background ${project.settings.background} is shown)`,
      hint: "Run `montash timeline gaps --fill black|hold|close`, or move clips to close the gap.",
      detail: { from_f: g.from_f, to_f: g.to_f },
    });
  }
}

// ---------------------------------------------------------------------------
// タイムライン尺を超えるテキスト等（warning）
// ---------------------------------------------------------------------------

function checkBeyondTimeline(project: Project, c: Collector): void {
  let mediaEnd = 0;
  let hasMedia = false;
  for (const track of project.tracks) {
    if (track.kind === "text") continue;
    for (const clip of track.clips) {
      hasMedia = true;
      mediaEnd = Math.max(mediaEnd, clipEndF(clip));
    }
  }
  if (!hasMedia) return;
  project.tracks.forEach((track, ti) => {
    if (track.kind !== "text") return;
    track.clips.forEach((clip, ci) => {
      if (isSubtitleClip(clip)) return;
      const end = clipEndF(clip);
      if (end > mediaEnd) {
        c.warn(
          { code: "W_BEYOND_TIMELINE", message: `text clip "${clip.id}" ends at f:${end}, beyond the last media clip (f:${mediaEnd})`, path: `/tracks/${ti}/clips/${ci}`, hint: "It will extend the render over the background. Shorten it if unintended.", detail: { clip: clip.id, end_f: end, media_end_f: mediaEnd } },
          false,
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// §8 audio
// ---------------------------------------------------------------------------

function checkAudioSettings(project: Project, trackById: Map<string, Track>, c: Collector): void {
  const seen = new Set<string>();
  project.audio.ducking.forEach((d, i) => {
    const path = `/audio/ducking/${i}`;
    if (seen.has(d.id)) c.error({ code: "E_DUCKING_ID_DUPLICATE", message: `ducking id "${d.id}" is duplicated`, path });
    seen.add(d.id);
    for (const key of ["target", "sidechain"] as const) {
      if (!trackById.has(d[key])) c.error({ code: "E_TRACK_NOT_FOUND", message: `ducking "${d.id}": ${key} track "${d[key]}" not found`, path: `${path}/${key}` });
    }
  });
  for (const id of Object.keys(project.audio.track_gain_db)) {
    if (!trackById.has(id)) c.warn({ code: "W_UNKNOWN_TRACK", message: `audio.track_gain_db refers to unknown track "${id}"`, path: `/audio/track_gain_db/${id}` }, false);
  }
}

// ---------------------------------------------------------------------------
// ファイル存在（checkFiles）
// ---------------------------------------------------------------------------

export function resolveAssetPath(dir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(dir, path);
}

function checkFiles(project: Project, dir: string, c: Collector): void {
  for (const [id, asset] of Object.entries(project.assets)) {
    const full = resolveAssetPath(dir, asset.path);
    if (!existsSync(full)) {
      c.error({ code: "E_ASSET_MISSING", message: `asset "${id}": file not found at ${full}`, path: `/assets/${id}/path`, hint: `Run \`montash assets relink ${id} <path>\` to point to the moved file.`, detail: { asset: id, path: full } });
    }
  }
}
