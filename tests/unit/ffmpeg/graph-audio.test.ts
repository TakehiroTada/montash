/**
 * 音声グラフ（docs/07 §8）のスナップショットと単体検証。
 *
 * ダッキング（§8.3）の `asplit` + `sidechaincompress`、`--simple` フォールバック、
 * `loudnorm` の 2 パス（§8.4）、クリップのゲイン・フェード・オフセット、複数音声トラックを見る。
 */
import { expect, test } from "bun:test";
import { createProject } from "../../../src/core/project.ts";
import {
  type Asset,
  AudioAssetSchema,
  ClipSchema,
  DuckingSchema,
  type Project,
  TrackSchema,
  VideoAssetSchema,
} from "../../../src/core/schema.ts";
import { dbToAmplitude } from "../../../src/ffmpeg/graph/audio.ts";
import { buildGraph } from "../../../src/ffmpeg/graph/builder.ts";
import type { GraphOptions } from "../../../src/ffmpeg/graph/types.ts";

const RES = { width: 320, height: 180 };
const source = (asset: Asset) => `/fixtures/${asset.path}`;
const chains = (filter: string) => filter.split(";");

/** V1 に映像 1 本、A1（会話）と A2（BGM）を持つ 30fps のプロジェクト */
function base(): Project {
  const project = createProject({ name: "audio", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 300 });
  project.assets.bgm = AudioAssetSchema.parse({ id: "bgm", type: "audio", path: "bgm.wav", duration_f: 300 });
  project.tracks.push(TrackSchema.parse({ id: "A2", kind: "audio" }));
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", asset: "a", start_f: 0, in_f: 0, out_f: 90, link: "c2", video: {} }),
  );
  project.tracks[1]!.clips.push(
    ClipSchema.parse({ id: "c2", asset: "a", start_f: 0, in_f: 0, out_f: 90, link: "c1", audio: {} }),
  );
  project.tracks[2]!.clips.push(
    ClipSchema.parse({ id: "c3", asset: "bgm", start_f: 0, in_f: 0, out_f: 90, audio: {} }),
  );
  return project;
}

function duck(project: Project, extra: Record<string, unknown> = {}) {
  project.audio.ducking.push(
    DuckingSchema.parse({
      id: "d1",
      target: "A2",
      sidechain: "A1",
      threshold_db: -30,
      ratio: 8,
      attack_ms: 20,
      release_ms: 500,
      makeup_db: 0,
      ...extra,
    }),
  );
  return project;
}

const graphOf = (project: Project, opts: Partial<GraphOptions> = {}) =>
  buildGraph(project, { resolution: RES, source, ...opts });

test("clip gain, fade and sample offset are applied per clip (docs/07 §8.1)", () => {
  const project = base();
  const bgm = project.tracks[2]!.clips[0]!;
  Object.assign(bgm, {
    audio: { gain_db: -12, fade: { in_f: 0, out_f: 60, curve: "tri" }, offset_smp: -480, muted: false },
  });
  const graph = graphOf(project);
  expect(graph.filterComplex).toContain("volume=-12dB");
  // 60 フレーム = 96000 サンプルのフェードアウト。クリップ長 90f = 144000 サンプル
  expect(graph.filterComplex).toContain("afade=t=out:ss=48000:ns=96000:curve=tri");
  // 負のオフセットは adelay できないので先頭を削る（§8.1）
  expect(graph.filterComplex).toContain("atrim=start_sample=480");
  expect(graph.filterComplex).not.toContain("adelay=-");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("ducking splits the sidechain and compresses the target (docs/07 §8.3)", () => {
  const graph = graphOf(duck(base()));
  // サイドチェイン側は asplit で複製され、片方が sidechaincompress の 2 入力目になる
  expect(graph.filterComplex).toContain("asplit=2");
  const compress = /sidechaincompress=[^,[\]]+/.exec(graph.filterComplex)?.[0];
  expect(compress).toBeDefined();
  // threshold は dB ではなく線形振幅（10^(-30/20) = 0.031623）
  expect(compress).toContain(`threshold=${Number(dbToAmplitude(-30).toFixed(6))}`);
  expect(compress).toContain("threshold=0.031623");
  expect(compress).toContain("ratio=8");
  expect(compress).toContain("attack=20");
  expect(compress).toContain("release=500");
  // makeup も線形（0dB → 1。ffmpeg の makeup は 1..64）
  expect(compress).toContain("makeup=1");
  // 2 入力（会話のコピー + BGM）で受ける
  expect(graph.filterComplex).toMatch(/\[a\d+\]\[a\d+\]sidechaincompress=/);
  expect(graph.warnings).toEqual([]);
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("makeup and threshold in dB are converted to linear amplitude", () => {
  const graph = graphOf(duck(base(), { threshold_db: -20, makeup_db: 6, ratio: 4 }));
  const compress = /sidechaincompress=[^,[\]]+/.exec(graph.filterComplex)?.[0] ?? "";
  expect(compress).toContain("threshold=0.1");
  expect(compress).toContain("makeup=1.995262");
  expect(compress).toContain("ratio=4");
});

test("--simple ducking uses the analysed windows with a volume expression", () => {
  const project = duck(base(), { simple: true });
  const graph = graphOf(project, {
    ducking: { d1: { windows: [{ from: 0.5, to: 1.5 }], level_db: -6 } },
  });
  expect(graph.filterComplex).not.toContain("sidechaincompress");
  // (-6 - -30) * (1 - 1/8) = 21 dB 下げる → 10^(-21/20) = 0.089125
  expect(graph.filterComplex).toContain("volume='if(between(t,0.5,1.5),0.089125,1)':eval=frame");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("--simple ducking without an analysis pass is skipped with a warning", () => {
  const graph = graphOf(duck(base(), { simple: true }));
  expect(graph.filterComplex).not.toContain("sidechaincompress");
  expect(graph.filterComplex).not.toContain("eval=frame");
  expect(graph.warnings.map((w) => w.code)).toEqual(["W_DUCK_ANALYSIS_MISSING"]);
});

test("ducking a track with no audible sidechain warns instead of failing", () => {
  const project = base();
  project.tracks[1]!.clips = [];
  duck(project);
  const graph = graphOf(project);
  expect(graph.filterComplex).not.toContain("sidechaincompress");
  expect(graph.warnings.map((w) => w.code)).toEqual(["W_DUCK_NO_SIDECHAIN"]);
});

test("track and master gains are applied around the mix (docs/07 §8.3)", () => {
  const project = base();
  project.audio.track_gain_db = { A2: -12 };
  project.audio.master_gain_db = -3;
  const graph = graphOf(project);
  expect(graph.filterComplex).toContain("volume=-12dB");
  expect(graph.filterComplex).toContain("volume=-3dB");
  expect(graph.filterComplex).toContain("amix=inputs=2:normalize=0:dropout_transition=0");
});

test("loudnorm pass 2 adds the measured values and linear=true (docs/07 §8.4)", () => {
  const graph = graphOf(base(), {
    loudnorm: {
      i: -14,
      tp: -1,
      lra: 11,
      measured: { input_i: -21.06, input_tp: -18.98, input_lra: 0, input_thresh: -31.06, target_offset: -0.04 },
    },
  });
  expect(graph.filterComplex).toContain(
    "loudnorm=I=-14:TP=-1:LRA=11:measured_I=-21.06:measured_TP=-18.98:measured_LRA=0:measured_thresh=-31.06:offset=-0.04:linear=true",
  );
  // loudnorm は内部で 192kHz に上げるのでプロジェクトのレートへ戻す
  expect(graph.filterComplex).toContain("loudnorm=I=-14:TP=-1:LRA=11:measured_I");
  expect(graph.filterComplex).toMatch(/linear=true,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo/);
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("loudnorm without measurements stays a single dynamic pass", () => {
  const graph = graphOf(base(), { loudnorm: { i: -16, tp: -1.5, lra: 9 } });
  expect(graph.filterComplex).toContain("loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000");
  expect(graph.filterComplex).not.toContain("linear=true");
});

test("several audio tracks are mixed with normalize=0 and fitted to the timeline", () => {
  const project = base();
  project.tracks.push(TrackSchema.parse({ id: "A3", kind: "audio" }));
  project.tracks[3]!.clips.push(
    ClipSchema.parse({ id: "c4", asset: "bgm", start_f: 30, in_f: 0, out_f: 60, audio: { gain_db: -6 } }),
  );
  const graph = graphOf(project);
  expect(graph.filterComplex).toContain("amix=inputs=3:normalize=0:dropout_transition=0");
  // タイムライン位置へはサンプル単位の adelay（30 フレーム = 48000 サンプル）
  expect(graph.filterComplex).toContain("adelay=48000S:all=1");
  expect(graph.filterComplex).toContain("atrim=end_sample=144000");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("audio-only graphs are built for the whole timeline", () => {
  const graph = graphOf(duck(base()), { video: false });
  expect(graph.mapVideo).toBe("");
  expect(graph.mapAudio).toMatch(/^\[a\d+\]$/);
  expect(graph.totalFrames).toBe(90);
});
