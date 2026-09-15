/**
 * 音声コマンドのハンドラを直接呼ぶテスト（tests/unit/cli/clip-edit.test.ts と同じ書き方）。
 * yargs を通さないので、オプション名は yargs が渡す camelCase で与える。
 */
import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  audioAnalyze,
  audioDuck,
  audioDuckRemove,
  audioFade,
  audioGain,
  audioNormalize,
  audioOffset,
  audioShow,
  parseOffsetSamples,
} from "../../../src/cli/commands/audio.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { AssetSchema, type Clip, ClipSchema, type Project, TrackSchema } from "../../../src/core/schema.ts";
import { locateBinaries } from "../../../src/ffmpeg/locate.ts";
import { runFfmpeg } from "../../../src/ffmpeg/run.ts";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: true,
  quiet: false,
  verbose: false,
  dryRun: false,
  yes: true,
  noColor: true,
  timeFormat: "frames",
  ...over,
});

let dir: string;

function ctx(argv: string[], over: Partial<GlobalOptions> = {}) {
  return createContext(globals({ project: dir, ...over }), {
    cwd: dir,
    env: { MONTASH_ACTOR: "ai" },
    isTTY: false,
    argv,
  });
}

/** ハンドラは各コマンド固有の Args 型を持つので、ここでは緩い形で渡す */
// biome-ignore lint/suspicious/noExplicitAny: コマンドごとの Args 型をテストからは緩く渡す
type Args = Record<string, any>;

const call = (spec: { handler: (c: never, a: never) => unknown }, args: Args, over?: Partial<GlobalOptions>) =>
  spec.handler(ctx(["test"], over) as never, args as never) as Promise<CommandResult>;

// biome-ignore lint/suspicious/noExplicitAny: 結果 JSON をテストから読むためのヘルパ
const res = (r: CommandResult) => r.result as any;

/** 保存されたクリップの audio ブロック（トラック index / クリップ index で引く） */
const clipAudio = (project: Project, track: number, clip = 0) => (project.tracks[track]!.clips[clip]! as Clip).audio!;

/**
 * 30fps・V1/A1/A2・映像 a（リンクされた c1/c2）と BGM c3 を持つプロジェクト。
 * 素材は実ファイルとして書き出す（`audio analyze` が ffmpeg で読めるように）。
 */
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-audio-"));
  const bins = locateBinaries();
  await runFfmpeg(
    bins,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:r=48000:d=2",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      "-t",
      "2",
      join(dir, "bgm.wav"),
    ],
    { timeoutMs: 60_000 },
  );
  const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 320, height: 180 } });
  project.assets.a = AssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 300, audio: {} });
  project.assets.bgm = AssetSchema.parse({ id: "bgm", type: "audio", path: "bgm.wav", duration_f: 60 });
  project.tracks.push(TrackSchema.parse({ id: "A2", kind: "audio" }));
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 60, link: "c2", video: {} }),
  );
  project.tracks[1]!.clips.push(
    ClipSchema.parse({ id: "c2", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 60, link: "c1", audio: {} }),
  );
  project.tracks[2]!.clips.push(
    ClipSchema.parse({ id: "c3", type: "media", asset: "bgm", start_f: 0, in_f: 0, out_f: 60, audio: {} }),
  );
  await initProjectDir(dir, project);
  await recordInitialOp(dir, project, ctx(["init"]) as never);
}

beforeEach(async () => {
  await setup();
});

// ---------------------------------------------------------------------------
// audio gain
// ---------------------------------------------------------------------------

test("audio gain writes the clip, track and master gains", async () => {
  const clip = await call(audioGain, { clip: "c3", db: -12 });
  expect(res(clip).gain_db).toBe(-12);
  expect(res(clip).previous_db).toBe(0);
  expect(clip.op).toBeTruthy();

  await call(audioGain, { track: "A2", db: -3 });
  await call(audioGain, { master: true, db: -1.5 });
  const project = await loadProject(dir);
  expect(clipAudio(project, 2).gain_db).toBe(-12);
  expect(project.audio.track_gain_db.A2).toBe(-3);
  expect(project.audio.master_gain_db).toBe(-1.5);
});

test("audio gain on a video clip lands on its linked audio clip", async () => {
  await call(audioGain, { clip: "c1", db: -6 });
  const project = await loadProject(dir);
  expect(clipAudio(project, 1).gain_db).toBe(-6);
});

test("audio gain needs exactly one target", async () => {
  expect(call(audioGain, { db: -6 })).rejects.toThrow(/exactly one/);
  expect(call(audioGain, { clip: "c3", track: "A2", db: -6 })).rejects.toThrow(/exactly one/);
});

// ---------------------------------------------------------------------------
// audio fade
// ---------------------------------------------------------------------------

test("audio fade sets the clip fade in frames and clamps to the clip length", async () => {
  const out = await call(audioFade, { clip: "c3", out: "1.0", curve: "exp" });
  expect(res(out).fade).toEqual({ in_f: 0, out_f: 30, curve: "exp" });

  const clamped = await call(audioFade, { clip: "c3", in: "5.0" });
  expect(res(clamped).fade.in_f).toBe(60);
  expect(clamped.warnings?.map((w) => w.code)).toContain("W_CLIP_SHORTER_THAN_REQUESTED");
  expect(call(audioFade, { clip: "c3" })).rejects.toThrow(/at least one/);
});

// ---------------------------------------------------------------------------
// audio duck
// ---------------------------------------------------------------------------

test("audio duck stores a sidechain setting and updates it in place", async () => {
  const added = await call(audioDuck, { target: "A2", sidechain: "A1", threshold: "-30dB", ratio: 8, release: "0.5" });
  expect(res(added).added.target).toBe("A2");
  expect(res(added).added.sidechain).toBe("A1");
  expect(res(added).added.threshold_db).toBe(-30);
  // `--release 0.5` は秒として読む（docs/03 W-07 の書き方）
  expect(res(added).added.release_ms).toBe(500);
  expect(added.warnings?.map((w) => w.code)).toContain("W_TIME_UNIT_GUESSED");
  const id = res(added).added.id;

  const updated = await call(audioDuck, { target: "A2", sidechain: "A1", ratio: 4, release: "300ms", attack: "20ms" });
  expect(res(updated).added.id).toBe(id);
  expect(res(updated).added.ratio).toBe(4);
  expect(res(updated).added.release_ms).toBe(300);
  expect(res(updated).ducking.length).toBe(1);

  const project = await loadProject(dir);
  expect(project.audio.ducking.length).toBe(1);
  expect(project.audio.ducking[0]!.attack_ms).toBe(20);
});

test("audio duck --simple marks the fallback and rejects bad arguments", async () => {
  const simple = await call(audioDuck, { target: "A2", sidechain: "A1", simple: true });
  expect(res(simple).added.simple).toBe(true);
  expect(call(audioDuck, { target: "A2" })).rejects.toThrow(/--sidechain/);
  expect(call(audioDuck, { target: "A2", sidechain: "A2" })).rejects.toThrow(/different tracks/);
  expect(call(audioDuck, { target: "A2", sidechain: "A9" })).rejects.toThrow(MontashError);
});

test("audio duck --off and audio duck remove delete the setting", async () => {
  const added = await call(audioDuck, { target: "A2", sidechain: "A1" });
  const id = res(added).added.id;
  const removed = await call(audioDuckRemove, { id });
  expect(res(removed).removed[0].id).toBe(id);
  expect((await loadProject(dir)).audio.ducking).toEqual([]);
  expect(call(audioDuckRemove, { id })).rejects.toThrow(/not found/);

  await call(audioDuck, { target: "A2", sidechain: "A1" });
  const off = await call(audioDuck, { target: "A2", off: true });
  expect(res(off).removed.length).toBe(1);
  const again = await call(audioDuck, { target: "A2", off: true });
  expect(again.op).toBeNull();
});

// ---------------------------------------------------------------------------
// audio normalize
// ---------------------------------------------------------------------------

test("audio normalize stores the render-time targets", async () => {
  const on = await call(audioNormalize, { loudness: -14, truePeak: -1, lra: 11 });
  expect(res(on).normalize).toEqual({ enabled: true, i: -14, tp: -1, lra: 11 });
  const off = await call(audioNormalize, { off: true });
  expect(res(off).normalize.enabled).toBe(false);
  expect((await loadProject(dir)).audio.normalize.i).toBe(-14);
  expect(call(audioNormalize, { off: true, loudness: -14 })).rejects.toThrow(/--off/);
  expect(call(audioNormalize, { truePeak: 2 })).rejects.toThrow(/true-peak/);
});

// ---------------------------------------------------------------------------
// audio offset
// ---------------------------------------------------------------------------

test("audio offset shifts by samples and detects linked clips", async () => {
  // c2 は c1 とリンクしているので、まず unlink が必要（docs/04 §11）
  const linked = call(audioOffset, { clip: "c2", by: "s:-960" });
  expect(linked).rejects.toThrow(MontashError);
  await linked.catch((e: MontashError) => {
    expect(e.code).toBe("E_CLIP_LINKED");
    expect(e.hint).toContain("clip unlink");
  });

  const by = await call(audioOffset, { clip: "c3", by: "s:-960" });
  expect(res(by).offset_smp).toBe(-960);
  expect(res(by).offset_ms).toBeCloseTo(-20, 6);
  const again = await call(audioOffset, { clip: "c3", by: "s:+480" });
  expect(res(again).offset_smp).toBe(-480);
  const set = await call(audioOffset, { clip: "c3", set: "s:240" });
  expect(res(set).offset_smp).toBe(240);
  expect(clipAudio(await loadProject(dir), 2).offset_smp).toBe(240);
  expect(call(audioOffset, { clip: "c3" })).rejects.toThrow(/--by or --set/);
});

test("audio offset accepts seconds and frames without snapping to frames", () => {
  const fps = { num: 30, den: 1 };
  expect(parseOffsetSamples("s:-960", 48000, fps)).toBe(-960);
  // 0.02 秒はフレーム境界に無いが、サンプルへは正確に落ちる（round(0.02 * 48000)）
  expect(parseOffsetSamples("0.02", 48000, fps)).toBe(960);
  expect(parseOffsetSamples("-0.02", 48000, fps)).toBe(-960);
  expect(parseOffsetSamples("+f:1", 48000, fps)).toBe(1600);
  expect(() => parseOffsetSamples("bogus", 48000, fps)).toThrow(MontashError);
});

// ---------------------------------------------------------------------------
// audio show / analyze
// ---------------------------------------------------------------------------

test("audio show lists gains, fades, ducking and normalization without recording an op", async () => {
  await call(audioGain, { clip: "c3", db: -12 });
  await call(audioGain, { track: "A2", db: -2 });
  await call(audioFade, { clip: "c3", out: "1.0" });
  await call(audioDuck, { target: "A2", sidechain: "A1" });
  const shown = await call(audioShow, {});
  const result = res(shown);
  expect(shown.op).toBeUndefined();
  expect(result.master_gain_db).toBe(0);
  expect(result.normalize.i).toBe(-14);
  expect(result.ducking[0].target).toBe("A2");
  expect(result.tracks.map((t: { id: string }) => t.id)).toEqual(["A1", "A2"]);
  const a2 = result.tracks.find((t: { id: string }) => t.id === "A2");
  expect(a2.gain_db).toBe(-2);
  expect(a2.clips[0]).toMatchObject({ id: "c3", gain_db: -12, offset_smp: 0, muted: false });
  expect(a2.clips[0].fade.out_f).toBe(30);
});

test("audio analyze returns loudness, peaks and silence for an asset", async () => {
  const out = await call(audioAnalyze, { asset: "bgm" });
  const result = res(out);
  expect(result.target).toEqual({ kind: "asset", id: "bgm" });
  expect(result.integrated_lufs).toBeLessThan(0);
  expect(result.true_peak_dbfs).toBeLessThanOrEqual(1);
  expect(result.max_volume_db).toBeLessThanOrEqual(0);
  expect(Array.isArray(result.silence)).toBe(true);
  expect(Array.isArray(result.active)).toBe(true);
  // 440Hz の連続音なので無音区間は無い
  expect(result.silence.length).toBe(0);
  expect(out.op).toBeUndefined();
  expect(call(audioAnalyze, { asset: "bgm", target: "A1" })).rejects.toThrow(/either/);
  expect(call(audioAnalyze, { asset: "nope" })).rejects.toThrow(/not found/);
}, 60_000);

test("audio analyze measures a single audio track of the timeline", async () => {
  const out = await call(audioAnalyze, { target: "A2" });
  const result = res(out);
  expect(result.target).toEqual({ kind: "track", id: "A2" });
  expect(result.duration).toBeCloseTo(2, 3);
  expect(result.integrated_lufs).toBeLessThan(0);
  expect(call(audioAnalyze, { target: "V1" })).rejects.toThrow(/not an audio track/);
}, 60_000);
