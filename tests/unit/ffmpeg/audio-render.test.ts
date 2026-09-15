/**
 * 実 ffmpeg でのレンダー検証（docs/07 §8.3, §8.4、W-07）。
 *
 * - BGM（200Hz の連続音）+ 会話（3kHz を 1 秒だけ）でダッキングを掛け、
 *   ローパスで BGM だけを取り出して「会話区間のほうが静か」であることを dB で確認する。
 * - `audio normalize --loudness -14` 相当のレンダーが −14 LUFS 付近（±1.5 LU）に収まることを確認する。
 * - フレーム数・音声尺は `render verify`（verifyRender）で確認する。
 *
 * 映像デコードを伴わない素材（無音の黒背景 + WAV）なので、どのケースも数秒で終わる。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timelineDurationF } from "../../../src/core/assets.ts";
import { createProject } from "../../../src/core/project.ts";
import { AudioAssetSchema, ClipSchema, DuckingSchema, type Project, TrackSchema } from "../../../src/core/schema.ts";
import { locateBinaries } from "../../../src/ffmpeg/locate.ts";
import { prepareAudio } from "../../../src/ffmpeg/loudnorm.ts";
import { buildRenderPlan, verifyRender } from "../../../src/ffmpeg/render.ts";
import { runFfmpeg } from "../../../src/ffmpeg/run.ts";

const bins = locateBinaries();
const RESOLUTION = { width: 160, height: 90 };
/** 素材は 4 秒（120 フレーム @30fps）。会話は 1.0〜2.0 秒だけ鳴る */
const DURATION_F = 120;
const SPEECH: [number, number] = [1, 2];

let dir: string;

/** lavfi で WAV を 1 本作る */
async function makeWav(name: string, source: string): Promise<string> {
  const path = join(dir, name);
  await runFfmpeg(bins, ["-y", "-f", "lavfi", "-i", source, "-ac", "2", "-c:a", "pcm_s16le", "-t", "4", path], {
    timeoutMs: 60_000,
  });
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-audio-render-"));
  await Promise.all([
    // BGM: 200Hz を通して鳴らす（ローパスで取り出せる）
    makeWav("bgm.wav", "sine=f=200:r=48000:d=4"),
    // 会話: 3kHz を 1.0〜2.0 秒だけ（前後は無音なので silencedetect でも拾える）
    makeWav("voice.wav", `sine=f=3000:r=48000:d=4,volume='if(between(t,${SPEECH[0]},${SPEECH[1]}),1,0)':eval=frame`),
  ]);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A1 = 会話、A2 = BGM（-6dB）のプロジェクト。映像トラックは空（背景色） */
function project(): Project {
  const p = createProject({ name: "audio-render", fps: { num: 30, den: 1 }, resolution: RESOLUTION });
  p.settings.background = "#000000";
  p.assets.voice = AudioAssetSchema.parse({ id: "voice", type: "audio", path: "voice.wav", duration_f: DURATION_F });
  p.assets.bgm = AudioAssetSchema.parse({ id: "bgm", type: "audio", path: "bgm.wav", duration_f: DURATION_F });
  p.tracks.push(TrackSchema.parse({ id: "A2", kind: "audio" }));
  p.tracks[1]!.clips.push(
    ClipSchema.parse({ id: "c1", type: "media", asset: "voice", start_f: 0, in_f: 0, out_f: DURATION_F, audio: {} }),
  );
  p.tracks[2]!.clips.push(
    ClipSchema.parse({
      id: "c2",
      type: "media",
      asset: "bgm",
      start_f: 0,
      in_f: 0,
      out_f: DURATION_F,
      audio: { gain_db: -6 },
    }),
  );
  p.audio.normalize.enabled = false;
  return p;
}

function addDucking(p: Project, extra: Record<string, unknown> = {}): Project {
  p.audio.ducking.push(
    DuckingSchema.parse({
      id: "d1",
      target: "A2",
      sidechain: "A1",
      threshold_db: -30,
      ratio: 8,
      attack_ms: 20,
      release_ms: 200,
      makeup_db: 0,
      ...extra,
    }),
  );
  return p;
}

/** プロジェクトをレンダーして `render verify` 相当まで確認する */
async function render(p: Project, name: string) {
  const output = join(dir, name);
  const passes = await prepareAudio(bins, p, { source: (asset) => join(dir, asset.path) });
  const plan = await buildRenderPlan(p, dir, output, {
    preset: "web-preview",
    resolution: RESOLUTION,
    crf: 40,
    speed: "ultrafast",
    threads: 2,
    audio: passes.passes,
  });
  await runFfmpeg(bins, ["-y", ...plan.args], { timeoutMs: 300_000 });
  const verified = await verifyRender(bins, output, p, RESOLUTION);
  return { output, verified, passes };
}

/** `[from, to)` の平均音量（dB）。`filter` で帯域を絞ってトラックを切り分ける */
async function meanVolume(path: string, from: number, to: number, filter: string): Promise<number> {
  const lines: string[] = [];
  await runFfmpeg(
    bins,
    [
      "-ss",
      String(from),
      "-t",
      String(to - from),
      "-i",
      path,
      "-vn",
      "-af",
      `${filter},volumedetect`,
      "-f",
      "null",
      "-",
    ],
    { onStderrLine: (l) => lines.push(l), timeoutMs: 60_000 },
  );
  const line = lines.find((l) => l.includes("mean_volume:"));
  const value = line ? /mean_volume:\s*(-?[\d.]+|-inf)/.exec(line)?.[1] : undefined;
  expect(value).toBeDefined();
  return value === "-inf" ? Number.NEGATIVE_INFINITY : Number(value);
}

/** 統合ラウドネス（LUFS） */
async function integratedLoudness(path: string): Promise<number> {
  const lines: string[] = [];
  await runFfmpeg(bins, ["-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], {
    onStderrLine: (l) => lines.push(l),
    timeoutMs: 120_000,
  });
  const at = lines.findLastIndex((l) => l.includes("Summary:"));
  const line = lines.slice(at).find((l) => /^\s*I:\s+/.test(l));
  const value = line ? /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(line)?.[1] : undefined;
  expect(value).toBeDefined();
  return Number(value);
}

/** BGM（200Hz）だけを取り出す。会話は 3kHz なのでローパスで落ちる */
const BGM_ONLY = "lowpass=f=600,lowpass=f=600";

test("sidechaincompress lowers the BGM while the dialogue plays", async () => {
  const plain = await render(project(), "plain.mp4");
  const ducked = await render(addDucking(project()), "ducked.mp4");
  expect(ducked.verified.valid).toBe(true);

  // ダッキング無しでは BGM の音量は会話区間でも変わらない（差は 1dB 未満）
  const plainQuiet = await meanVolume(plain.output, 0.1, 0.9, BGM_ONLY);
  const plainSpeech = await meanVolume(plain.output, 1.2, 1.9, BGM_ONLY);
  expect(Math.abs(plainQuiet - plainSpeech)).toBeLessThan(1);

  // ダッキング有りでは会話区間の BGM が明確に下がる
  const quiet = await meanVolume(ducked.output, 0.1, 0.9, BGM_ONLY);
  const speech = await meanVolume(ducked.output, 1.2, 1.9, BGM_ONLY);
  expect(quiet - speech).toBeGreaterThan(6);
  // 会話が終われば元の音量に戻る（release 200ms の後）
  const after = await meanVolume(ducked.output, 2.5, 3.5, BGM_ONLY);
  expect(Math.abs(after - quiet)).toBeLessThan(1.5);
  // 会話の無い区間はダッキング前と同じ音量のまま
  expect(Math.abs(quiet - plainQuiet)).toBeLessThan(1);
}, 180_000);

test("--simple ducking lowers the BGM using the analysed speech windows", async () => {
  const p = addDucking(project(), { simple: true });
  const rendered = await render(p, "simple.mp4");
  // 事前解析（silencedetect）で 1.0〜2.0 秒の発話区間が見つかっている
  const analysis = rendered.passes.passes.ducking?.d1;
  expect(analysis).toBeDefined();
  expect(analysis!.windows.length).toBe(1);
  expect(analysis!.windows[0]!.from).toBeLessThan(SPEECH[0] + 0.2);
  expect(analysis!.windows[0]!.to).toBeGreaterThan(SPEECH[1] - 0.2);

  const quiet = await meanVolume(rendered.output, 0.1, 0.7, BGM_ONLY);
  const speech = await meanVolume(rendered.output, 1.3, 1.8, BGM_ONLY);
  expect(quiet - speech).toBeGreaterThan(6);
}, 180_000);

test("two-pass loudnorm brings the render to the requested integrated loudness", async () => {
  const p = project();
  p.audio.normalize = { enabled: true, i: -14, tp: -1, lra: 11 };
  const rendered = await render(p, "normalized.mp4");
  // パス 1 の測定値が使われている（linear=true の 2 パス目）
  expect(rendered.passes.passes.loudnorm?.measured).toBeDefined();
  expect(rendered.verified.valid).toBe(true);
  expect(rendered.verified.actual_frames).toBe(DURATION_F);

  const loudness = await integratedLoudness(rendered.output);
  expect(Math.abs(loudness - -14)).toBeLessThan(1.5);

  // 正規化しない同じ素材はもっと静か（測定値どおり）
  const plain = await render(project(), "plain-loudness.mp4");
  expect(await integratedLoudness(plain.output)).toBeLessThan(loudness - 2);
}, 180_000);

test("frame count and audio duration match the timeline (render verify)", async () => {
  const p = addDucking(project());
  p.audio.normalize = { enabled: true, i: -16, tp: -1, lra: 11 };
  const rendered = await render(p, "verified.mp4");
  expect(rendered.verified.valid).toBe(true);
  expect(rendered.verified.expected_frames).toBe(timelineDurationF(p));
  expect(rendered.verified.actual_frames).toBe(timelineDurationF(p));
  const audio = rendered.verified.output.streams.find((s) => s.codec_type === "audio");
  expect(Number(audio?.sample_rate)).toBe(48000);
  expect(Math.abs(Number(audio?.duration) - 4)).toBeLessThan(1 / 30);
}, 180_000);
