/**
 * プレビュー合成（docs/07 §11, docs/05 §1・§12, docs/12 ADR-11）。
 *
 * - 映像はフレーム境界のセグメントに分割し、`.montash/preview/segments/<hash>.mp4`（音声なし）へキャッシュする。
 *   セグメントの内容（区間長・関係するクリップ・settings・入力ファイルの指紋）からハッシュを取るので、
 *   リップル編集で位置だけが動いたセグメントもそのまま再利用できる。
 * - 音声は AAC のエンコーダ遅延（priming）で継ぎ目にクリックが出るため、セグメント化せず
 *   タイムライン全体を毎回 1 パスで `audio.m4a` に生成する（ADR-11）。音声に関係する入力が同じなら再利用。
 * - 最後に `-c copy` で mux して `timeline.mp4`。`timeline.json`（マニフェスト）の書き込みが commit point で、
 *   読み手が途中状態の動画を観測することはない。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { MontashError, type Warning } from "../cli/errors.ts";
import { timelineDurationF } from "../core/assets.ts";
import { canonicalHash } from "../core/history/hash.ts";
import { atomicWrite, hashProject, projectPaths } from "../core/project.ts";
import {
  type Clip,
  clipEndF,
  type Fps,
  isMediaClip,
  type Project,
  type Resolution,
  type Track,
} from "../core/schema.ts";
import { framesToSamples } from "../core/time.ts";
import { resolveAssetPath, validateProject } from "../core/validate.ts";
import { type Binaries, locateBinaries } from "./locate.ts";
import { proxyState } from "./proxy.ts";
import { verifyRender } from "./render.ts";
import { type Progress, runFfmpeg } from "./run.ts";

/** セグメントの最小長（docs/07 §11.1「最小セグメント長 60 フレーム程度に統合」） */
export const SEGMENT_MIN_F = 60;
/** セグメントキャッシュに残すファイル数の上限（超えた分は古い順に捨てる） */
const SEGMENT_CACHE_LIMIT = 256;
const MANIFEST_FILE = "timeline.json";
const VIDEO_FILE = "video.mp4";
const AUDIO_FILE = "audio.m4a";
const TIMELINE_FILE = "timeline.mp4";
const SEGMENT_DIR = "segments";
const SEGMENT_PATH_RE = /^segments\/[0-9a-f]{40}\.mp4$/;

// ---------------------------------------------------------------------------
// マニフェスト（docs/05 §12 preview/timeline.json）
// ---------------------------------------------------------------------------

export interface PreviewSegment {
  from_f: number;
  to_f: number;
  hash: string;
  path: string;
  clips: string[];
}

export interface PreviewManifest {
  project_hash: string;
  /** プロジェクト内容 + 入力ファイルの指紋 + 出力解像度。ready / stale の判定に使う */
  fingerprint: string;
  built_at: string;
  duration_f: number;
  fps: Fps;
  resolution: Resolution;
  video_segments: PreviewSegment[];
  audio: { hash: string; path: string };
}

export interface PreviewStatus {
  state: "missing" | "stale" | "ready" | "building";
  project_hash: string;
  fingerprint: string;
  built_at?: string;
  duration_f?: number;
  fps?: Fps;
  resolution?: Resolution;
  /** timeline.mp4 の絶対パス（配信できるときのみ） */
  path?: string;
  manifest?: PreviewManifest;
  progress?: Progress;
}

// ---------------------------------------------------------------------------
// 解像度・指紋
// ---------------------------------------------------------------------------

/** プレビュー出力の解像度（既定はプロキシ高さ）。アスペクト比を保った偶数 px にする */
export function previewResolution(project: Project, height = project.settings.proxy.height): Resolution {
  if (!Number.isSafeInteger(height) || height < 2 || height % 2)
    throw new MontashError("E_USAGE", "preview height must be a positive even integer");
  return {
    height,
    width: Math.max(
      2,
      Math.round((height * project.settings.resolution.width) / project.settings.resolution.height / 2) * 2,
    ),
  };
}

async function fileFingerprint(path: string) {
  const info = await stat(path).catch(() => null);
  return { path, size: info?.size, mtime: info?.mtimeMs, ctime: info?.ctimeMs };
}

/** project.json の内容 + 参照する素材ファイルの指紋 + 出力解像度 */
export async function previewFingerprint(project: Project, dir: string, height?: number): Promise<string> {
  const sources = await Promise.all(
    Object.entries(project.assets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([id, asset]) => ({ id, ...(await fileFingerprint(resolveAssetPath(dir, asset.path))) })),
  );
  return canonicalHash({ version: 2, project, sources, resolution: previewResolution(project, height) });
}

// ---------------------------------------------------------------------------
// マニフェストの読み取り
// ---------------------------------------------------------------------------

function validManifest(value: unknown): value is PreviewManifest {
  const m = value as PreviewManifest | null;
  if (!m || typeof m !== "object") return false;
  if (typeof m.project_hash !== "string" || typeof m.fingerprint !== "string") return false;
  if (typeof m.built_at !== "string") return false;
  if (!Number.isSafeInteger(m.duration_f) || m.duration_f <= 0) return false;
  if (!m.fps || !(m.fps.num > 0) || !(m.fps.den > 0)) return false;
  if (!m.resolution || !(m.resolution.width > 0) || !(m.resolution.height > 0)) return false;
  if (!Array.isArray(m.video_segments) || m.video_segments.length === 0) return false;
  // 手で書き換えたマニフェストがキャッシュディレクトリの外を指せないようにする
  for (const s of m.video_segments) {
    if (!s || typeof s.path !== "string" || !SEGMENT_PATH_RE.test(s.path)) return false;
    if (!Number.isSafeInteger(s.from_f) || !Number.isSafeInteger(s.to_f) || s.to_f <= s.from_f) return false;
  }
  if (!m.audio || m.audio.path !== AUDIO_FILE || typeof m.audio.hash !== "string") return false;
  return true;
}

export async function readPreviewManifest(dir: string): Promise<PreviewManifest | null> {
  try {
    const value = JSON.parse(await readFile(join(projectPaths(dir).previewDir, MANIFEST_FILE), "utf8"));
    return validManifest(value) ? value : null;
  } catch {
    return null;
  }
}

function activeLock(path: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0) return false;
    try {
      process.kill(owner.pid!, 0);
      return true;
    } catch (e) {
      // EPERM = 別ユーザーのプロセスが生きている
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false;
  }
}

export async function readPreviewStatus(
  project: Project,
  dir: string,
  opts: { height?: number } = {},
): Promise<PreviewStatus> {
  const folder = projectPaths(dir).previewDir;
  const manifest = await readPreviewManifest(dir);
  const fingerprint = await previewFingerprint(project, dir, opts.height ?? manifest?.resolution.height);
  const path = join(folder, TIMELINE_FILE);
  const available = manifest !== null && (await stat(path).catch(() => null))?.isFile() === true;
  const status: PreviewStatus = {
    state: available ? (manifest.fingerprint === fingerprint ? "ready" : "stale") : "missing",
    project_hash: hashProject(project),
    fingerprint,
    ...(available
      ? {
          built_at: manifest.built_at,
          duration_f: manifest.duration_f,
          fps: manifest.fps,
          resolution: manifest.resolution,
          path,
          manifest,
        }
      : {}),
  };
  if (activeLock(join(folder, "build.lock"))) {
    status.state = "building";
    try {
      status.progress = JSON.parse(await readFile(join(folder, "build.json"), "utf8")).progress;
    } catch {
      /* 最初の進捗はまだ書かれていない */
    }
  }
  return status;
}

// ---------------------------------------------------------------------------
// プラン（セグメント分割と ffmpeg 引数の組み立て）
// ---------------------------------------------------------------------------

function unsupported(what: string): never {
  throw new MontashError("E_NOT_IMPLEMENTED", `M2 preview does not support ${what}`, {
    hint: "Use plain media clips with speed 1; transitions, text and effects arrive in later milestones.",
  });
}

interface SourceRef {
  /** ffmpeg に渡す実際の入力パス（プロキシがあればプロキシ） */
  path: string;
  proxy: boolean;
  size?: number;
  mtime?: number;
}

interface SegmentPlan {
  from_f: number;
  to_f: number;
  hash: string;
  path: string;
  clips: string[];
  /** 出力パスを受け取って ffmpeg の引数列を返す */
  args: (output: string) => string[];
}

export interface PreviewPlan {
  duration_f: number;
  resolution: Resolution;
  fps: Fps;
  segments: SegmentPlan[];
  audio: { hash: string; args: (output: string) => string[] };
  warnings: Warning[];
}

/** 映像・テキストトラックのクリップ端をセグメント境界にし、短すぎる区間は後ろへ統合する */
export function segmentBoundaries(project: Project, total: number): number[] {
  const marks = new Set<number>();
  for (const track of project.tracks) {
    if (track.kind === "audio" || track.muted) continue;
    for (const clip of track.clips) {
      marks.add(clip.start_f);
      marks.add(clipEndF(clip));
    }
  }
  const sorted = [...marks].filter((f) => f > 0 && f < total).sort((a, b) => a - b);
  const out = [0];
  for (const mark of sorted) {
    if (mark - out[out.length - 1]! >= SEGMENT_MIN_F && total - mark >= SEGMENT_MIN_F) out.push(mark);
  }
  out.push(total);
  return out;
}

function activeTracks(project: Project): Track[] {
  return project.tracks.filter((t) => !t.muted && t.clips.length > 0);
}

/** M1/M2 のパイプラインが扱える構成かを確認する（render.ts と同じ制限） */
function assertSupported(project: Project): void {
  if (project.transitions.length) unsupported("transitions");
  if (project.audio.ducking.length) unsupported("audio ducking");
  if (![1, 2].includes(project.settings.channels)) unsupported("more than two audio channels");
  const active = activeTracks(project);
  if (active.filter((t) => t.kind === "video").length > 1) unsupported("multiple video layers");
  for (const track of active) {
    if (track.kind === "text") unsupported("text tracks");
    if (track.fade.in_f || track.fade.out_f) unsupported("track fades");
    for (const clip of track.clips) {
      if (!isMediaClip(clip)) unsupported("text, subtitle or generator clips");
      if (clip.speed !== 1 || clip.loop || clip.effects.length) unsupported("speed, loops or effects");
      const v = clip.video;
      if (v && (v.opacity !== 1 || v.transform || v.crop || v.color || v.lut || v.fade.in_f || v.fade.out_f))
        unsupported("video transforms or fades");
      const a = clip.audio;
      if (a && (a.fade.in_f || a.fade.out_f || a.offset_smp)) unsupported("audio fades or offsets");
    }
  }
}

async function resolveSources(project: Project, dir: string): Promise<Map<string, SourceRef>> {
  const out = new Map<string, SourceRef>();
  for (const asset of Object.values(project.assets)) {
    let path = resolveAssetPath(dir, asset.path);
    let proxy = false;
    // プロキシはプロジェクト fps・start_time=0 で作られているので in_f / out_f をそのまま使える（docs/07 §2, §10）
    if (asset.type === "video" && (await proxyState(dir, asset, project).catch(() => "missing")) === "ready") {
      const candidate = join(projectPaths(dir).cacheDir, asset.id, "proxy.mp4");
      if (existsSync(candidate)) {
        path = candidate;
        proxy = true;
      }
    }
    const info = await stat(path).catch(() => null);
    out.set(asset.id, { path, proxy, size: info?.size, mtime: info?.mtimeMs });
  }
  return out;
}

export async function buildPreviewPlan(
  project: Project,
  dir: string,
  opts: { height?: number } = {},
): Promise<PreviewPlan> {
  const validation = validateProject(project, { dir, checkFiles: true });
  if (!validation.ok)
    throw new MontashError("E_VALIDATION_FAILED", "project validation failed before preview build", {
      detail: { errors: validation.errors },
      hint: "Run `montash validate --deep --json` and fix the reported issues.",
    });
  const total = timelineDurationF(project);
  if (!total)
    throw new MontashError("E_EMPTY_TIMELINE", "cannot build a preview of an empty timeline", {
      hint: "Use `montash clip add` first.",
    });
  assertSupported(project);

  const res = previewResolution(project, opts.height);
  const fps = project.settings.fps;
  const rate = `${fps.num}/${fps.den}`;
  const sr = project.settings.sample_rate;
  const layout = project.settings.channels === 1 ? "mono" : "stereo";
  const background = project.settings.background;
  if (!/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|[a-zA-Z]+)$/.test(background))
    throw new MontashError("E_USAGE", "unsupported background color");
  const sources = await resolveSources(project, dir);
  const tb = `settb=expr=${fps.den}/${fps.num},setpts=N`;
  const active = activeTracks(project);
  const videoClips = [...(active.find((t) => t.kind === "video")?.clips ?? [])]
    .map((c) => c as Clip)
    .sort((a, b) => a.start_f - b.start_f);

  // --- 映像セグメント（docs/07 §11.1） ---
  const bounds = segmentBoundaries(project, total);
  const segments: SegmentPlan[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i]!;
    const to = bounds[i + 1]!;
    const length = to - from;
    /** セグメント内のローカル座標（先頭 = 0 フレーム）に直したクリップ */
    const parts: Array<{ id: string; at: number; frames: number; in_f: number; source: SourceRef; image: boolean }> =
      [];
    for (const clip of videoClips) {
      const start = Math.max(clip.start_f, from);
      const end = Math.min(clipEndF(clip), to);
      if (end <= start) continue;
      const source = sources.get(clip.asset);
      if (!source) throw new MontashError("E_ASSET_NOT_FOUND", `clip "${clip.id}" references unknown asset`);
      parts.push({
        id: clip.id,
        at: start - from,
        frames: end - start,
        in_f: clip.in_f + (start - clip.start_f),
        source,
        image: project.assets[clip.asset]!.type === "image",
      });
    }
    // 位置が動いただけの同一内容はキャッシュを共有できるよう、ローカル座標だけをハッシュする
    const hash = canonicalHash({
      version: 2,
      length,
      fps,
      resolution: res,
      background,
      clips: parts.map((p) => ({
        at: p.at,
        frames: p.frames,
        in_f: p.in_f,
        source: { path: p.source.path, size: p.source.size, mtime: p.source.mtime },
        image: p.image,
      })),
    });
    segments.push({
      from_f: from,
      to_f: to,
      hash,
      path: `${SEGMENT_DIR}/${hash.slice("sha1:".length)}.mp4`,
      clips: parts.map((p) => p.id),
      args(output: string) {
        const args: string[] = [];
        const graph: string[] = [];
        const labels: string[] = [];
        const blank = (frames: number) => {
          if (frames <= 0) return;
          const label = `v${labels.length}`;
          graph.push(
            `color=c=${background}:s=${res.width}x${res.height}:r=${rate},trim=end_frame=${frames},${tb}[${label}]`,
          );
          labels.push(label);
        };
        let cursor = 0;
        let index = 0;
        for (const part of parts) {
          blank(part.at - cursor);
          if (part.image) args.push("-loop", "1", "-framerate", rate);
          args.push("-i", part.source.path);
          const label = `v${labels.length}`;
          graph.push(
            `[${index}:V:0]setpts=PTS-STARTPTS,fps=${rate},trim=start_frame=${part.in_f}:end_frame=${part.in_f + part.frames},${tb},scale=${res.width}:${res.height}:force_original_aspect_ratio=decrease,pad=${res.width}:${res.height}:(ow-iw)/2:(oh-ih)/2:color=${background},setsar=1,format=yuv420p[${label}]`,
          );
          labels.push(label);
          index++;
          cursor = part.at + part.frames;
        }
        blank(length - cursor);
        graph.push(
          `${labels.map((l) => `[${l}]`).join("")}concat=n=${labels.length}:v=1:a=0,fps=${rate},trim=end_frame=${length},${tb}[Vout]`,
        );
        args.push(
          "-filter_complex_threads",
          "1",
          "-filter_complex",
          graph.join(";"),
          "-map",
          "[Vout]",
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "30",
          "-g",
          "30",
          "-pix_fmt",
          "yuv420p",
          "-r",
          rate,
          "-frames:v",
          String(length),
          // 全セグメントを同じ timescale で書き、`-c copy` の concat を厳密にする
          "-video_track_timescale",
          String(fps.num),
          "-threads",
          "2",
          "-f",
          "mp4",
          output,
        );
        return args;
      },
    });
  }

  // --- 音声（docs/07 §11.2: タイムライン全体を毎回 1 パス） ---
  const samples = framesToSamples(total, fps, sr);
  const audioParts: Array<{ clip: Clip; gain: number; source: SourceRef }> = [];
  for (const track of active.filter((t) => t.kind === "audio")) {
    for (const c of track.clips) {
      const clip = c as Clip;
      if (clip.audio?.muted) continue;
      const source = sources.get(clip.asset);
      if (!source) throw new MontashError("E_ASSET_NOT_FOUND", `clip "${clip.id}" references unknown asset`);
      audioParts.push({
        clip,
        gain: (clip.audio?.gain_db ?? 0) + (project.audio.track_gain_db[track.id] ?? 0),
        source,
      });
    }
  }
  const audioHash = canonicalHash({
    version: 2,
    total,
    fps,
    sample_rate: sr,
    channels: project.settings.channels,
    master_gain_db: project.audio.master_gain_db,
    clips: audioParts.map((p) => ({
      start_f: p.clip.start_f,
      in_f: p.clip.in_f,
      out_f: p.clip.out_f,
      gain: p.gain,
      source: { path: p.source.path, size: p.source.size, mtime: p.source.mtime },
    })),
  });

  const audioArgs = (output: string): string[] => {
    const args: string[] = [];
    const graph: string[] = [];
    const labels: string[] = [];
    audioParts.forEach((part, index) => {
      args.push("-i", part.source.path);
      const label = `a${index}`;
      const start = framesToSamples(part.clip.in_f, fps, sr);
      const length = framesToSamples(clipEndF(part.clip) - part.clip.start_f, fps, sr);
      const delay = framesToSamples(part.clip.start_f, fps, sr);
      graph.push(
        `[${index}:a:0]asetpts=PTS-STARTPTS,aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=${layout},atrim=start_sample=${start}:end_sample=${start + length},asetpts=PTS-STARTPTS,apad=whole_len=${length},atrim=end_sample=${length},volume=${part.gain}dB,adelay=${delay}S:all=1[${label}]`,
      );
      labels.push(label);
    });
    if (labels.length)
      graph.push(
        `${labels.map((l) => `[${l}]`).join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0[Amix]`,
      );
    else graph.push(`anullsrc=r=${sr}:cl=${layout},atrim=end_sample=${samples}[Amix]`);
    graph.push(
      `[Amix]volume=${project.audio.master_gain_db}dB,apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=PTS-STARTPTS[Aout]`,
    );
    args.push(
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      graph.join(";"),
      "-map",
      "[Aout]",
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-ar",
      String(sr),
      "-ac",
      String(project.settings.channels),
      "-f",
      "mp4",
      output,
    );
    return args;
  };

  const warnings: Warning[] = validation.warnings.map((w) => ({ code: w.code, message: w.message }));
  if (project.audio.normalize.enabled)
    warnings.push({
      code: "W_NORMALIZE_DEFERRED",
      message: "preview keeps source audio levels; loudness normalization runs on render only (docs/07 §8.4).",
    });

  return { duration_f: total, resolution: res, fps, segments, audio: { hash: audioHash, args: audioArgs }, warnings };
}

// ---------------------------------------------------------------------------
// ビルド
// ---------------------------------------------------------------------------

export interface PreviewBuildOptions {
  bins?: Binaries;
  height?: number;
  force?: boolean;
  /** 部分再生成（docs/04 §13 `--from/--to`）。この区間にかかるセグメントはキャッシュを無視する */
  from_f?: number;
  to_f?: number;
  /** 音声（docs/07 §11.2）だけを生成する */
  audioOnly?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
}

export interface PreviewBuildResult {
  status: PreviewStatus;
  warnings: Warning[];
  reused: boolean;
  /** 実際に再エンコードしたセグメント数 */
  built_segments: number;
  cached_segments: number;
  audio_reused: boolean;
  audio_only?: boolean;
}

/** 参照されなくなったセグメントキャッシュを上限まで捨てる（再生成できるので失敗は無視する） */
async function pruneSegments(segmentDir: string, keep: Set<string>): Promise<void> {
  try {
    const files = (await readdir(segmentDir)).filter((f) => f.endsWith(".mp4"));
    if (files.length <= SEGMENT_CACHE_LIMIT) return;
    const aged = await Promise.all(
      files
        .filter((f) => !keep.has(f))
        .map(async (f) => ({ f, mtime: (await stat(join(segmentDir, f)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    aged.sort((a, b) => a.mtime - b.mtime);
    for (const { f } of aged.slice(0, files.length - SEGMENT_CACHE_LIMIT))
      await rm(join(segmentDir, f), { force: true });
  } catch {
    /* キャッシュの掃除は best effort */
  }
}

export async function buildPreview(
  project: Project,
  dir: string,
  opts: PreviewBuildOptions = {},
): Promise<PreviewBuildResult> {
  const checkCancelled = () => {
    if (opts.signal?.aborted)
      throw new MontashError("E_FFMPEG_CANCELLED", "preview build cancelled", { exitCode: 130 });
  };
  checkCancelled();
  const height = opts.height ?? project.settings.proxy.height;
  const folder = projectPaths(dir).previewDir;
  const segmentDir = join(folder, SEGMENT_DIR);
  const partial = opts.from_f !== undefined || opts.to_f !== undefined;
  const initial = await readPreviewStatus(project, dir, { height });
  if (initial.state === "ready" && !opts.force && !partial && !opts.audioOnly)
    return {
      status: initial,
      warnings: [],
      reused: true,
      built_segments: 0,
      cached_segments: initial.manifest?.video_segments.length ?? 0,
      audio_reused: true,
    };

  await mkdir(segmentDir, { recursive: true });
  const lock = join(folder, "build.lock");
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    throw new MontashError("E_PREVIEW_BUSY", "another preview build holds the cache lock", {
      hint: "Wait for the active build. If it crashed, confirm no preview builder is running before removing .montash/preview/build.lock.",
    });
  }

  const token = crypto.randomUUID();
  const temps: string[] = [];
  const temp = (name: string) => {
    const p = join(folder, `.building-${token}-${name}`);
    temps.push(p);
    return p;
  };
  let writes = Promise.resolve();
  let writeError: unknown;
  const progressFile = join(folder, "build.json");

  try {
    const plan = await buildPreviewPlan(project, dir, { height });
    const previous = await readPreviewManifest(dir);

    // どのセグメントを作り直すか（--force は全部、--from/--to はその区間にかかるものだけ）
    const rebuild = (s: SegmentPlan) =>
      Boolean(opts.force) ||
      (partial && s.to_f > (opts.from_f ?? 0) && s.from_f < (opts.to_f ?? plan.duration_f)) ||
      !existsSync(join(folder, s.path));
    // 同じ内容のセグメント（同じカットの繰り返しなど）は 1 度だけエンコードする
    const todo: SegmentPlan[] = [];
    if (!opts.audioOnly) {
      const seen = new Set<string>();
      for (const segment of plan.segments) {
        if (!rebuild(segment) || seen.has(segment.hash)) continue;
        seen.add(segment.hash);
        todo.push(segment);
      }
    }
    const audioPath = join(folder, AUDIO_FILE);
    const audioReusable = !opts.force && !partial && previous?.audio.hash === plan.audio.hash && existsSync(audioPath);

    // 進捗: セグメントのフレーム数を単位とし、音声と mux にも重みを与える
    const audioUnits = Math.max(1, Math.round(plan.duration_f * 0.15));
    const muxUnits = opts.audioOnly ? 0 : Math.max(1, Math.round(plan.duration_f * 0.05));
    const totalUnits =
      todo.reduce((n, s) => n + (s.to_f - s.from_f), 0) + (audioReusable ? 0 : audioUnits) + muxUnits || 1;
    let doneUnits = 0;
    const report = (progress: Progress) => {
      writes = writes
        .then(() => atomicWrite(progressFile, JSON.stringify({ fingerprint: initial.fingerprint, progress })))
        .catch((e: unknown) => {
          writeError = e;
        });
      opts.onProgress?.(progress);
    };
    const step = (units: number) => (p: Progress) => {
      const fraction = Math.min(1, Math.max(0, (p.percent ?? 0) / 100));
      report({ ...p, percent: Math.min(100, ((doneUnits + units * fraction) / totalUnits) * 100) });
    };
    report({ percent: 0 });

    const bins = opts.bins ?? locateBinaries();

    // --- 1. 映像セグメント ---
    for (const segment of todo) {
      checkCancelled();
      const units = segment.to_f - segment.from_f;
      const out = temp(`${segment.hash.slice("sha1:".length)}.mp4`);
      await runFfmpeg(bins, ["-y", ...segment.args(out)], {
        signal: opts.signal,
        totalFrames: units,
        onProgress: step(units),
      });
      checkCancelled();
      await rename(out, join(folder, segment.path));
      doneUnits += units;
    }

    // --- 2. 音声（全体 1 パス） ---
    if (!audioReusable) {
      checkCancelled();
      const out = temp(AUDIO_FILE);
      await runFfmpeg(bins, ["-y", ...plan.audio.args(out)], {
        signal: opts.signal,
        totalFrames: plan.duration_f,
        onProgress: step(audioUnits),
      });
      checkCancelled();
      await rename(out, audioPath);
      doneUnits += audioUnits;
    }

    if (opts.audioOnly) {
      await writes;
      if (writeError) throw writeError;
      return {
        status: await readPreviewStatus(project, dir, { height }),
        warnings: plan.warnings,
        reused: audioReusable,
        built_segments: 0,
        cached_segments: plan.segments.length,
        audio_reused: audioReusable,
        audio_only: true,
      };
    }

    // --- 3. concat（無再エンコード）→ video.mp4 ---
    checkCancelled();
    const listFile = temp("concat.txt");
    await Bun.write(
      listFile,
      `${plan.segments.map((s) => `file '${join(folder, s.path).replace(/'/g, "'\\''")}'`).join("\n")}\n`,
    );
    const videoTemp = temp(VIDEO_FILE);
    await runFfmpeg(
      bins,
      ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-map", "0:v:0", "-c", "copy", "-f", "mp4", videoTemp],
      { signal: opts.signal },
    );
    checkCancelled();
    await rename(videoTemp, join(folder, VIDEO_FILE));

    // --- 4. mux（docs/07 §11.3） ---
    const timelineTemp = temp(TIMELINE_FILE);
    await runFfmpeg(
      bins,
      [
        "-y",
        "-i",
        join(folder, VIDEO_FILE),
        "-i",
        audioPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        timelineTemp,
      ],
      { signal: opts.signal, totalFrames: plan.duration_f, onProgress: step(muxUnits) },
    );
    doneUnits += muxUnits;
    await verifyRender(bins, timelineTemp, project, plan.resolution);
    checkCancelled();

    // 生成中に素材が差し替わっていたら公開しない（古いマニフェストを残す）
    if ((await previewFingerprint(project, dir, height)) !== initial.fingerprint)
      throw new MontashError("E_PREVIEW_STALE", "source assets changed while building preview; retry the build");
    await writes;
    if (writeError) throw writeError;
    await rename(timelineTemp, join(folder, TIMELINE_FILE));

    const manifest: PreviewManifest = {
      project_hash: hashProject(project),
      fingerprint: initial.fingerprint,
      built_at: new Date().toISOString(),
      duration_f: plan.duration_f,
      fps: plan.fps,
      resolution: plan.resolution,
      video_segments: plan.segments.map((s) => ({
        from_f: s.from_f,
        to_f: s.to_f,
        hash: s.hash,
        path: s.path,
        clips: s.clips,
      })),
      audio: { hash: plan.audio.hash, path: AUDIO_FILE },
    };
    // マニフェストの書き込みが commit point（読み手は途中状態を観測しない）
    await atomicWrite(join(folder, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await pruneSegments(segmentDir, new Set(plan.segments.map((s) => s.path.slice(SEGMENT_DIR.length + 1))));
    return {
      status: {
        state: "ready",
        project_hash: manifest.project_hash,
        fingerprint: manifest.fingerprint,
        built_at: manifest.built_at,
        duration_f: manifest.duration_f,
        fps: manifest.fps,
        resolution: manifest.resolution,
        path: join(folder, TIMELINE_FILE),
        manifest,
      },
      warnings: plan.warnings,
      reused: false,
      built_segments: todo.length,
      cached_segments: plan.segments.length - todo.length,
      audio_reused: audioReusable,
    };
  } finally {
    await writes.catch(() => {});
    for (const p of temps) await rm(p, { force: true });
    await rm(progressFile, { force: true });
    await rm(lock, { force: true });
  }
}
