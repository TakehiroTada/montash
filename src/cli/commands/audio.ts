/**
 * 音声コマンド（docs/04 §11: `audio gain|fade|duck|normalize|analyze|show|offset`、W-07）。
 *
 * 状態変更はすべて `runMutation()` を通す（op 記録・`-m` 即コミット・`--dry-run`・validate はミドルウェア）。
 * `audio analyze` / `audio show` は読み取り系（op を作らない）。
 * ダッキングと正規化は `project.json` に設定として保存し、実際のフィルタはレンダー時に
 * `ffmpeg/graph/audio.ts` が組み立てる（docs/07 §8.3, §8.4）。
 */
import { timelineDurationF } from "../../core/assets.ts";
import { findClip, findClipOrNull } from "../../core/clip-editing.ts";
import { assertIdAvailable, nextId } from "../../core/ids.ts";
import { loadProject } from "../../core/project.ts";
import {
  type Clip,
  ClipAudioSchema,
  clipEndF,
  type Ducking,
  DuckingSchema,
  isMediaClip,
  type Project,
  type Track,
  type TrackClip,
} from "../../core/schema.ts";
import { framesToSamples, framesToSeconds } from "../../core/time.ts";
import { requireTrack } from "../../core/timeline.ts";
import { resolveAssetPath } from "../../core/validate.ts";
import { type AudioAnalysis, analyzeGraph, analyzeProjectAudio } from "../../ffmpeg/audio-analysis.ts";
import type { FilterGraph } from "../../ffmpeg/graph/types.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import type { CommandContext } from "../context.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning, warning } from "../errors.ts";
import { currentHead, type MutationOutcome, runMutation } from "../mutate.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";

// ---------------------------------------------------------------------------
// 引数の解釈
// ---------------------------------------------------------------------------

const DB_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:db|dbfs)?$/i;
const MS_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(ms|s)?$/i;
/** 単位なしでこれ未満の値は秒とみなす（docs/03 W-07 は `--release 0.5` と書く） */
const SECONDS_GUESS_MS = 10;

/** `-30dB` / `-30` を dB として読む */
function parseDb(value: unknown, what: string): number {
  const m = DB_RE.exec(String(value).trim());
  if (!m) throw errors.usage(`${what} must be a number of dB (e.g. -30 or -30dB)`);
  return Number(m[1]);
}

/** `20` / `20ms` / `0.5s` をミリ秒として読む。単位なしの小さな値は秒と解釈して警告する */
function parseMs(value: unknown, what: string, warnings: Warning[]): number {
  const m = MS_RE.exec(String(value).trim());
  if (!m) throw errors.usage(`${what} must be a duration (e.g. 500, 500ms or 0.5s)`);
  const n = Number(m[1]);
  if (n < 0) throw errors.usage(`${what} must not be negative`);
  const unit = m[2]?.toLowerCase();
  if (unit === "s") return n * 1000;
  if (unit === "ms") return n;
  if (n > 0 && n < SECONDS_GUESS_MS) {
    warnings.push(
      warning("W_TIME_UNIT_GUESSED", `${what} ${n} was read as ${n * 1000}ms (seconds)`, {
        hint: `Write ${n}s or ${n * 1000}ms to be explicit.`,
        detail: { option: what, input: n, milliseconds: n * 1000 },
      }),
    );
    return n * 1000;
  }
  return n;
}

function requireNumber(value: unknown, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw errors.usage(`${what} must be a number`);
  return n;
}

/**
 * `audio offset` のサンプル量（docs/04 §1.3「サンプル（音声補正のみ）」）。
 * `s:±N` はサンプル、`±f:N` はフレーム、それ以外の数値は秒 → `round(秒 * sample_rate)`。
 * フレーム未満の補正なので、秒はフレームに丸めずに直接サンプルへ変換する。
 */
export function parseOffsetSamples(raw: string, sampleRate: number, fps: { num: number; den: number }): number {
  const text = raw.trim();
  const samples = /^s:([+-]?\d+)$/.exec(text);
  if (samples) return Number(samples[1]);
  const frames = /^([+-]?)f:(\d+)$/.exec(text);
  if (frames) return (frames[1] === "-" ? -1 : 1) * framesToSamples(Number(frames[2]), fps, sampleRate);
  const seconds = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.exec(text);
  if (seconds) return Math.round(Number(text) * sampleRate);
  throw new MontashError("E_INVALID_TIME", `invalid audio offset ${JSON.stringify(raw)}`, {
    hint: "Accepted forms: samples (s:-960), frames (+f:1, -f:2) or seconds (0.02, -0.5).",
    detail: { input: raw },
  });
}

/** クリップの `audio` ブロック（無ければ既定値で作る） */
function audioBlock(clip: TrackClip): NonNullable<Clip["audio"]> {
  if (!isMediaClip(clip))
    throw new MontashError("E_NOT_IMPLEMENTED", `clip "${clip.id}" has no audio settings`, {
      hint: "Audio settings apply to media clips (video/audio assets).",
    });
  if (!clip.audio) clip.audio = ClipAudioSchema.parse({});
  return clip.audio;
}

/**
 * 音声設定の対象クリップを解決する。映像クリップを指定された場合はリンクされた音声クリップを使う
 * （`clip add` は映像 c1 と音声 c2 を対で作る）。
 */
function audioClip(project: Project, id: string): { track: Track; clip: Clip } {
  const found = findClip(project, id);
  let { track, clip } = found;
  if (track.kind !== "audio" && isMediaClip(clip) && clip.link) {
    const linked = findClipOrNull(project, clip.link);
    if (linked && linked.track.kind === "audio") {
      track = linked.track;
      clip = linked.clip;
    }
  }
  if (!isMediaClip(clip))
    throw new MontashError("E_NOT_IMPLEMENTED", `clip "${id}" has no audio stream`, {
      hint: "Text, subtitle and generator clips have no audio settings.",
    });
  return { track, clip };
}

// ---------------------------------------------------------------------------
// audio gain
// ---------------------------------------------------------------------------

export const audioGain = defineCommand({
  path: "audio gain",
  summary: "set the gain of a clip, a track or the master bus in dB",
  workflows: ["W-07"],
  mutates: true,
  options: {
    clip: { type: "string", describe: "clip ID" },
    track: { type: "string", describe: "audio track ID" },
    master: { type: "boolean", describe: "the master bus (project.audio.master_gain_db)" },
    db: { type: "number", describe: "gain in dB (negative lowers the level)", required: true },
  },
  examples: [{ cmd: "montash audio gain --clip c_bgm --db=-12", note: "lower the BGM by 12 dB" }],
  async handler(ctx, args) {
    const targets = [args.clip, args.track, args.master].filter((v) => v !== undefined && v !== false);
    if (targets.length !== 1) throw errors.usage("specify exactly one of --clip, --track or --master");
    const db = requireNumber(args.db, "--db");

    return runMutation(ctx, ({ project }) => {
      let scope: string;
      let previous: number;
      if (args.clip !== undefined) {
        const { clip } = audioClip(project, String(args.clip));
        const block = audioBlock(clip);
        previous = block.gain_db;
        block.gain_db = db;
        scope = `clip ${clip.id}`;
        return {
          result: { target: { kind: "clip", id: clip.id }, gain_db: db, previous_db: previous },
          summary: `set ${scope} gain to ${db}dB`,
          affects: { clips: [clip.id], range_f: [clip.start_f, clipEndF(clip)] as [number, number] },
          human: `${clip.id}  ${db}dB`,
        };
      }
      if (args.track !== undefined) {
        const track = requireTrack(project, String(args.track));
        if (track.kind !== "audio") throw errors.usage(`track "${track.id}" is not an audio track`);
        previous = project.audio.track_gain_db[track.id] ?? 0;
        project.audio.track_gain_db[track.id] = db;
        scope = `track ${track.id}`;
        return {
          result: { target: { kind: "track", id: track.id }, gain_db: db, previous_db: previous },
          summary: `set ${scope} gain to ${db}dB`,
          affects: { clips: track.clips.map((c) => c.id), range_f: null },
          human: `${track.id}  ${db}dB`,
        };
      }
      previous = project.audio.master_gain_db;
      project.audio.master_gain_db = db;
      return {
        result: { target: { kind: "master", id: "master" }, gain_db: db, previous_db: previous },
        summary: `set master gain to ${db}dB`,
        affects: { clips: [], range_f: null },
        human: `master  ${db}dB`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// audio fade
// ---------------------------------------------------------------------------

export const audioFade = defineCommand({
  path: "audio fade",
  summary: "set a clip's audio fade in/out",
  description: "Track-wide fades are `montash fade --track A1`; this sets the clip's own afade (docs/07 §8.1).",
  workflows: ["W-07"],
  mutates: true,
  options: {
    clip: { type: "string", describe: "clip ID", required: true },
    in: { type: "string", describe: "fade-in length", time: true },
    out: { type: "string", describe: "fade-out length", time: true },
    curve: { type: "string", describe: "afade curve", choices: ["tri", "exp", "log", "qsin", "hsin", "esin"] },
  },
  examples: [{ cmd: "montash audio fade --clip c_bgm --out 2.0" }],
  async handler(ctx, args) {
    if (args.in === undefined && args.out === undefined && args.curve === undefined)
      throw errors.usage("specify at least one of --in, --out or --curve");

    return runMutation(ctx, ({ project, fps }) => {
      const warnings: Warning[] = [];
      const { clip } = audioClip(project, String(args.clip));
      const block = audioBlock(clip);
      const duration = clipEndF(clip) - clip.start_f;
      const length = (value: unknown, current: number): number => {
        const parsed = parseTimeInput(String(value), fps, { allowEnd: false });
        if (parsed.warning) warnings.push(parsed.warning);
        const frames = resolveAbsolute(parsed, { fps, current });
        if (frames > duration) {
          warnings.push(
            warning("W_CLIP_SHORTER_THAN_REQUESTED", `fade clamped to the clip length (${duration} frames)`, {
              detail: { clip: clip.id, requested_f: frames, duration_f: duration },
            }),
          );
          return duration;
        }
        return frames;
      };
      if (args.in !== undefined) block.fade.in_f = length(args.in, block.fade.in_f);
      if (args.out !== undefined) block.fade.out_f = length(args.out, block.fade.out_f);
      if (args.curve !== undefined) block.fade.curve = String(args.curve);
      return {
        result: { clip: clip.id, fade: { ...block.fade } },
        warnings,
        summary: `set audio fade on ${clip.id}`,
        affects: { clips: [clip.id], range_f: [clip.start_f, clipEndF(clip)] as [number, number] },
        human: `${clip.id}  in ${block.fade.in_f}f  out ${block.fade.out_f}f  ${block.fade.curve}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// audio duck
// ---------------------------------------------------------------------------

interface DuckView {
  id: string;
  target: string;
  sidechain: string;
  threshold_db: number;
  ratio: number;
  attack_ms: number;
  release_ms: number;
  makeup_db: number;
  simple: boolean;
}

function describeDuck(duck: Ducking): DuckView {
  return {
    id: duck.id,
    target: duck.target,
    sidechain: duck.sidechain,
    threshold_db: duck.threshold_db,
    ratio: duck.ratio,
    attack_ms: duck.attack_ms,
    release_ms: duck.release_ms,
    makeup_db: duck.makeup_db,
    simple: duck.simple === true,
  };
}

export const audioDuck = defineCommand({
  path: "audio duck",
  summary: "duck a track while another one plays (sidechaincompress)",
  description:
    "The target is compressed by the sidechain track's level (docs/07 §8.3). --simple falls back to a silencedetect + volume automation for ffmpeg builds without sidechaincompress.",
  workflows: ["W-07"],
  mutates: true,
  options: {
    target: { type: "string", describe: "track to duck (the BGM)", required: true },
    sidechain: { type: "string", describe: "track that triggers the ducking (the dialogue)" },
    threshold: { type: "string", describe: "level above which the sidechain ducks (dB)", default: "-30dB" },
    ratio: { type: "number", describe: "compression ratio", default: 8 },
    attack: { type: "string", describe: "attack time (ms, or 0.02s)", default: "20ms" },
    release: { type: "string", describe: "release time (ms, or 0.5s)", default: "500ms" },
    makeup: { type: "number", describe: "makeup gain in dB", default: 0 },
    id: { type: "string", describe: "explicit ducking ID" },
    simple: { type: "boolean", describe: "use the silencedetect + volume fallback" },
    off: { type: "boolean", describe: "remove the ducking on --target instead of adding one" },
  },
  examples: [
    { cmd: "montash audio duck --target A2 --sidechain A1 --threshold -30dB --ratio 8 --release 0.5" },
    { cmd: "montash audio duck --target A2 --off" },
  ],
  async handler(ctx, args) {
    const off = Boolean(args.off);
    if (!off && args.sidechain === undefined) throw errors.usage("specify --sidechain (or --off to remove)");
    const warnings: Warning[] = [];
    const threshold = parseDb(args.threshold ?? "-30dB", "--threshold");
    const ratio = requireNumber(args.ratio ?? 8, "--ratio");
    const attack = parseMs(args.attack ?? "20ms", "--attack", warnings);
    const release = parseMs(args.release ?? "500ms", "--release", warnings);
    const makeup = requireNumber(args.makeup ?? 0, "--makeup");
    if (ratio <= 1) throw errors.usage("--ratio must be greater than 1");

    interface DuckResult {
      added: DuckView | null;
      removed: DuckView[];
      ducking: DuckView[];
    }
    return runMutation(ctx, async ({ project, dir }): Promise<MutationOutcome<DuckResult>> => {
      const target = requireTrack(project, String(args.target));
      if (off) {
        const sidechain = args.sidechain === undefined ? null : String(args.sidechain);
        const removed = project.audio.ducking.filter(
          (d) => d.target === target.id && (sidechain === null || d.sidechain === sidechain),
        );
        if (!removed.length)
          return {
            result: { added: null, removed: [], ducking: project.audio.ducking.map(describeDuck) },
            summary: `no ducking on ${target.id}`,
            changed: false,
            human: `no ducking on ${target.id}`,
          };
        project.audio.ducking = project.audio.ducking.filter((d) => !removed.includes(d));
        return {
          result: {
            added: null,
            removed: removed.map(describeDuck),
            ducking: project.audio.ducking.map(describeDuck),
          },
          summary: `remove ducking on ${target.id}`,
          affects: { clips: [], range_f: null },
          human: `removed ${removed.map((d) => d.id).join(", ")}`,
        };
      }

      const sidechain = requireTrack(project, String(args.sidechain));
      if (target.kind !== "audio" || sidechain.kind !== "audio")
        throw errors.usage("ducking works between audio tracks");
      if (target.id === sidechain.id) throw errors.usage("--target and --sidechain must be different tracks");
      if (args.id !== undefined) assertIdAvailable(project, String(args.id));
      const existing = project.audio.ducking.find((d) => d.target === target.id && d.sidechain === sidechain.id);
      const id =
        args.id !== undefined
          ? String(args.id)
          : (existing?.id ?? (ctx.globals.dryRun ? "d1" : await nextId(dir, "d")));
      const duck = DuckingSchema.parse({
        id,
        target: target.id,
        sidechain: sidechain.id,
        threshold_db: threshold,
        ratio,
        attack_ms: attack,
        release_ms: release,
        makeup_db: makeup,
        ...(args.simple ? { simple: true } : {}),
      });
      if (existing) project.audio.ducking[project.audio.ducking.indexOf(existing)] = duck;
      else project.audio.ducking.push(duck);
      if (!sidechain.clips.length)
        warnings.push(
          warning("W_DUCK_NO_SIDECHAIN", `sidechain track "${sidechain.id}" has no clips; ducking will do nothing`, {
            hint: `Check the levels with \`montash audio analyze ${sidechain.id} --json\`.`,
          }),
        );
      return {
        result: { added: describeDuck(duck), removed: [], ducking: project.audio.ducking.map(describeDuck) },
        warnings,
        summary: `${existing ? "update" : "add"} ducking ${id} (${target.id} <- ${sidechain.id})`,
        affects: { clips: [], range_f: null },
        human: `${id}  ${target.id} ducked by ${sidechain.id}  threshold ${threshold}dB  ratio ${ratio}`,
      };
    });
  },
});

export const audioDuckRemove = defineCommand({
  path: "audio duck remove",
  summary: "remove a ducking setting by ID",
  workflows: ["W-07"],
  mutates: true,
  positionals: [{ name: "id", describe: "ducking ID", required: true }],
  examples: [{ cmd: "montash audio duck remove d1" }],
  async handler(ctx, args) {
    return runMutation(ctx, ({ project }) => {
      const id = String(args.id);
      const duck = project.audio.ducking.find((d) => d.id === id);
      if (!duck)
        throw new MontashError("E_DUCKING_NOT_FOUND", `ducking "${id}" not found`, {
          hint: "Run `montash audio show --json` to see the current ducking IDs.",
          detail: { id, known: project.audio.ducking.map((d) => d.id) },
        });
      project.audio.ducking = project.audio.ducking.filter((d) => d.id !== id);
      return {
        result: { added: null, removed: [describeDuck(duck)], ducking: project.audio.ducking.map(describeDuck) },
        summary: `remove ducking ${id}`,
        affects: { clips: [], range_f: null },
        human: `removed ${id}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// audio normalize
// ---------------------------------------------------------------------------

export const audioNormalize = defineCommand({
  path: "audio normalize",
  summary: "configure loudness normalization applied at render time (two-pass loudnorm)",
  description:
    "Stored in project.audio.normalize. `montash render` measures the timeline first and applies a linear correction (docs/07 §8.4); preview keeps the source levels.",
  workflows: ["W-07"],
  mutates: true,
  options: {
    loudness: { type: "number", describe: "target integrated loudness in LUFS (default -14)" },
    "true-peak": { type: "number", describe: "target true peak in dBTP (default -1)" },
    lra: { type: "number", describe: "target loudness range in LU (default 11)" },
    off: { type: "boolean", describe: "disable normalization" },
  },
  examples: [{ cmd: "montash audio normalize --loudness=-14 --true-peak=-1" }],
  async handler(ctx, args) {
    const off = Boolean(args.off);
    if (off && [args.loudness, args.truePeak, args.lra].some((v) => v !== undefined))
      throw errors.usage("--off cannot be combined with target values");

    return runMutation(ctx, ({ project }) => {
      const normalize = project.audio.normalize;
      if (off) normalize.enabled = false;
      else {
        normalize.enabled = true;
        if (args.loudness !== undefined) normalize.i = requireNumber(args.loudness, "--loudness");
        if (args.truePeak !== undefined) normalize.tp = requireNumber(args.truePeak, "--true-peak");
        if (args.lra !== undefined) normalize.lra = requireNumber(args.lra, "--lra");
      }
      if (normalize.lra <= 0) throw errors.usage("--lra must be positive");
      if (normalize.tp > 0) throw errors.usage("--true-peak must be at or below 0 dBTP");
      return {
        result: { normalize: { ...normalize } },
        summary: off ? "disable loudness normalization" : `normalize to ${normalize.i} LUFS`,
        affects: { clips: [], range_f: null },
        human: off
          ? "normalization off"
          : `I ${normalize.i} LUFS  TP ${normalize.tp} dBTP  LRA ${normalize.lra} LU (applied on render)`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// audio offset
// ---------------------------------------------------------------------------

export const audioOffset = defineCommand({
  path: "audio offset",
  summary: "shift a clip's audio by whole samples (sub-frame sync correction)",
  description:
    "Linked clips must be unlinked first (`montash clip unlink`), otherwise E_CLIP_LINKED. Shifts of a frame or more belong to `clip move` (docs/04 §11).",
  workflows: ["W-07"],
  mutates: true,
  options: {
    clip: { type: "string", describe: "clip ID", required: true },
    by: { type: "string", describe: "relative shift: s:-960 (samples), -0.02 (seconds), +f:1 (frames)" },
    set: { type: "string", describe: "absolute offset in samples (s:480)" },
  },
  examples: [{ cmd: "montash audio offset --clip c2 --by s:-960" }],
  async handler(ctx, args) {
    if ((args.by === undefined) === (args.set === undefined)) throw errors.usage("specify either --by or --set");

    return runMutation(ctx, ({ project, fps }) => {
      const found = findClip(project, String(args.clip));
      const clip = found.clip;
      if (!isMediaClip(clip)) throw new MontashError("E_NOT_IMPLEMENTED", `clip "${clip.id}" has no audio stream`);
      if (clip.link)
        throw new MontashError("E_CLIP_LINKED", `clip "${clip.id}" is linked to "${clip.link}"`, {
          hint: `Run \`montash clip unlink ${clip.id}\` first; an audio offset would break the A/V sync of the pair.`,
          detail: { clip: clip.id, link: clip.link },
        });
      if (found.track.kind !== "audio")
        throw errors.usage(`clip "${clip.id}" is not on an audio track; offset the linked audio clip instead`);
      const block = audioBlock(clip);
      const rate = project.settings.sample_rate;
      const previous = block.offset_smp;
      block.offset_smp =
        args.by !== undefined
          ? previous + parseOffsetSamples(String(args.by), rate, fps)
          : parseOffsetSamples(String(args.set), rate, fps);
      return {
        result: {
          clip: clip.id,
          offset_smp: block.offset_smp,
          previous_smp: previous,
          offset_ms: (block.offset_smp / rate) * 1000,
          sample_rate: rate,
        },
        summary: `offset ${clip.id} audio by ${block.offset_smp} samples`,
        affects: { clips: [clip.id], range_f: [clip.start_f, clipEndF(clip)] as [number, number] },
        human: `${clip.id}  ${block.offset_smp} samples (${((block.offset_smp / rate) * 1000).toFixed(3)} ms)`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// audio analyze
// ---------------------------------------------------------------------------

/** 素材 1 つをそのまま解析するための最小の音声グラフ */
function assetGraph(project: Project, path: string): FilterGraph {
  const layout = project.settings.channels === 1 ? "mono" : "stereo";
  const rate = project.settings.sample_rate;
  return {
    inputs: [["-i", path]],
    filterComplex: `[0:a:0]aresample=${rate},aformat=sample_fmts=fltp:channel_layouts=${layout}[Asrc]`,
    mapVideo: "",
    mapAudio: "[Asrc]",
    totalFrames: 0,
    fps: project.settings.fps,
    resolution: project.settings.resolution,
    warnings: [],
  };
}

function describeAnalysis(target: { kind: string; id: string }, analysis: AudioAnalysis) {
  return {
    target,
    duration: analysis.duration,
    integrated_lufs: analysis.integrated_lufs,
    lra: analysis.lra,
    true_peak_dbfs: analysis.true_peak_dbfs,
    mean_volume_db: analysis.mean_volume_db,
    max_volume_db: analysis.max_volume_db,
    silence: analysis.silence,
    active: analysis.active,
  };
}

export const audioAnalyze = defineCommand({
  path: "audio analyze",
  summary: "measure integrated loudness, peaks and silence of a track, a clip or an asset",
  description: "Runs one audio-only ffmpeg pass (ebur128 / volumedetect / silencedetect). Reads only (docs/04 §11).",
  workflows: ["W-07"],
  positionals: [{ name: "target", describe: "track ID (A1) or clip ID (c2)" }],
  options: {
    asset: { type: "string", describe: "analyze an asset file instead of the timeline" },
    "noise-db": { type: "number", describe: "silence threshold in dBFS (default -40)" },
    "min-silence": { type: "number", describe: "shortest silence to report, in seconds (default 0.3)" },
  },
  examples: [{ cmd: "montash audio analyze A1 --json" }],
  async handler(ctx: CommandContext, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
    const opts = {
      source: (asset: { path: string }) => resolveAssetPath(dir, asset.path),
      ...(args.noiseDb !== undefined ? { noiseDb: Number(args.noiseDb) } : {}),
      ...(args.minSilence !== undefined ? { minSilence: Number(args.minSilence) } : {}),
    };
    if ((args.asset === undefined) === (args.target === undefined))
      throw errors.usage("specify either a track/clip ID or --asset <id>");

    let described: ReturnType<typeof describeAnalysis>;
    if (args.asset !== undefined) {
      const asset = project.assets[String(args.asset)];
      if (!asset)
        throw new MontashError("E_ASSET_NOT_FOUND", `asset "${args.asset}" not found`, {
          hint: "Run `montash assets list --json` to see the available assets.",
        });
      if (asset.type !== "audio" && asset.type !== "video")
        throw errors.usage(`asset "${asset.id}" has no audio stream`);
      const duration = asset.duration_f
        ? framesToSeconds(asset.duration_f, project.settings.fps)
        : Number.POSITIVE_INFINITY;
      const analysis = await analyzeGraph(bins, assetGraph(project, resolveAssetPath(dir, asset.path)), duration, opts);
      described = describeAnalysis({ kind: "asset", id: asset.id }, analysis);
    } else {
      const total = timelineDurationF(project);
      if (!total) throw new MontashError("E_EMPTY_TIMELINE", "the timeline is empty");
      const id = String(args.target);
      const track = project.tracks.find((t) => t.id === id);
      let keep: { track?: string; clip?: string };
      let target: { kind: string; id: string };
      if (track) {
        if (track.kind !== "audio") throw errors.usage(`track "${id}" is not an audio track`);
        keep = { track: track.id };
        target = { kind: "track", id: track.id };
      } else {
        const found = audioClip(project, id);
        if (found.track.kind !== "audio")
          throw errors.usage(`clip "${id}" has no audio clip to analyze (is it video-only?)`);
        keep = { track: found.track.id, clip: found.clip.id };
        target = { kind: "clip", id: found.clip.id };
      }
      const analysis = await analyzeProjectAudio(bins, project, total, keep, opts);
      described = describeAnalysis(target, analysis);
    }
    return {
      result: described,
      head: await currentHead(dir),
      human: [
        `${described.target.kind} ${described.target.id}`,
        `  integrated: ${described.integrated_lufs ?? "-inf"} LUFS   LRA: ${described.lra ?? "-"} LU`,
        `  true peak:  ${described.true_peak_dbfs ?? "-inf"} dBFS   max: ${described.max_volume_db ?? "-inf"} dB`,
        `  silence:    ${described.silence.length} span(s)`,
      ].join("\n"),
    };
  },
});

// ---------------------------------------------------------------------------
// audio show
// ---------------------------------------------------------------------------

export const audioShow = defineCommand({
  path: "audio show",
  summary: "list gains, fades, ducking and normalization settings",
  workflows: ["W-07"],
  options: {},
  examples: [{ cmd: "montash audio show --json" }],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const tracks = project.tracks
      .filter((t) => t.kind === "audio")
      .map((track) => ({
        id: track.id,
        name: track.name ?? track.id,
        muted: track.muted,
        gain_db: project.audio.track_gain_db[track.id] ?? 0,
        fade: { in_f: track.fade.in_f, out_f: track.fade.out_f },
        clips: track.clips.filter(isMediaClip).map((clip) => ({
          id: clip.id,
          label: clip.label ?? null,
          start_f: clip.start_f,
          end_f: clipEndF(clip),
          gain_db: clip.audio?.gain_db ?? 0,
          fade: clip.audio?.fade ?? { in_f: 0, out_f: 0, curve: "tri" },
          offset_smp: clip.audio?.offset_smp ?? 0,
          muted: clip.audio?.muted ?? false,
        })),
      }));
    const result = {
      master_gain_db: project.audio.master_gain_db,
      normalize: { ...project.audio.normalize },
      ducking: project.audio.ducking.map(describeDuck),
      tracks,
      sample_rate: project.settings.sample_rate,
      channels: project.settings.channels,
    };
    const lines = [
      `master ${result.master_gain_db}dB   normalize ${
        result.normalize.enabled
          ? `I ${result.normalize.i} TP ${result.normalize.tp} LRA ${result.normalize.lra}`
          : "off"
      }`,
      ...tracks.map(
        (t) =>
          `${t.id}${t.muted ? " (muted)" : ""}  gain ${t.gain_db}dB  fade ${t.fade.in_f}/${t.fade.out_f}f\n${t.clips
            .map(
              (c) =>
                `    ${c.id}  f:${c.start_f}..f:${c.end_f}  ${c.gain_db}dB  fade ${c.fade.in_f}/${c.fade.out_f}f${
                  c.offset_smp ? `  offset ${c.offset_smp}smp` : ""
                }${c.muted ? "  muted" : ""}`,
            )
            .join("\n")}`,
      ),
      ...result.ducking.map((d) => `duck ${d.id}  ${d.target} <- ${d.sidechain}  ${d.threshold_db}dB / ${d.ratio}:1`),
    ];
    return { result, head: await currentHead(dir), human: lines.join("\n") };
  },
});
