import { expect, test } from "bun:test";
import { createProject } from "../../../src/core/project.ts";
import {
  type Asset,
  ClipSchema,
  type Project,
  TrackSchema,
  TransitionSchema,
  VideoAssetSchema,
} from "../../../src/core/schema.ts";
import { buildGraph } from "../../../src/ffmpeg/graph/builder.ts";
import { serializeGraph } from "../../../src/ffmpeg/graph/serialize.ts";

const RES = { width: 320, height: 180 };
const source = (asset: Asset) => `/fixtures/${asset.path}`;

/** 30fps / 640x360 のプロジェクトに映像アセット a を 1 つ持たせる */
function base(fps = { num: 30, den: 1 }): Project {
  const project = createProject({ name: "graph", fps, resolution: { width: 640, height: 360 } });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 300 });
  return project;
}

function clip(id: string, start: number, inF: number, outF: number, extra: Record<string, unknown> = {}) {
  return ClipSchema.parse({ id, type: "media", asset: "a", start_f: start, in_f: inF, out_f: outF, ...extra });
}

function graphOf(project: Project, opts: Parameters<typeof buildGraph>[1] = { resolution: RES, source }) {
  return buildGraph(project, opts);
}

/** `;` 区切りのチェーンを読みやすい配列にする（スナップショット用） */
const chains = (filter: string) => filter.split(";");

test("clips without transitions are concatenated with background gaps", () => {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 30), clip("c3", 45, 60, 90));
  const graph = graphOf(project);
  expect(graph.totalFrames).toBe(75);
  expect(graph.filterComplex).toContain("concat=n=3:v=1:a=0");
  // ギャップは settings.background の color ソース
  expect(graph.filterComplex).toContain("color=c=#000000:s=320x180:r=30/1,trim=end_frame=15");
  expect(graph.filterComplex).not.toContain("xfade");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("a transition folds into xfade and the untouched cut stays a concat", () => {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 30), clip("c2", 30, 60, 90), clip("c3", 60, 120, 150));
  project.transitions.push(
    TransitionSchema.parse({ id: "t1", track: "V1", from: "c1", to: "c2", type: "wipeleft", duration_f: 10 }),
  );
  const graph = graphOf(project);
  expect(graph.totalFrames).toBe(90);
  // handle: ext_from = 5, ext_to = 5 → 素材を前後に広げて重ねる（project.json は変えない）
  expect(graph.filterComplex).toContain("trim=start_frame=0:end_frame=35");
  expect(graph.filterComplex).toContain("trim=start_frame=55:end_frame=90");
  // offset = len(v0) - d = 35 - 10 = 25 フレーム = 0.833333 秒
  expect(graph.filterComplex).toContain("xfade=transition=wipeleft:duration=0.333333:offset=0.833333");
  // xfade 区間（c1+c2）と単独の c3 は concat で繋ぐ
  expect(graph.filterComplex).toContain("concat=n=2:v=1:a=0");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("chained transitions keep the exact timeline length at 29.97fps", () => {
  const project = base({ num: 30000, den: 1001 });
  project.tracks[0]!.clips.push(clip("c1", 0, 20, 60), clip("c2", 40, 80, 120), clip("c3", 80, 140, 180));
  project.transitions.push(
    TransitionSchema.parse({ id: "t1", track: "V1", from: "c1", to: "c2", duration_f: 15 }),
    TransitionSchema.parse({ id: "t2", track: "V1", from: "c2", to: "c3", duration_f: 16 }),
  );
  const graph = graphOf(project);
  expect(graph.totalFrames).toBe(120);
  // 奇数 15 → ext 8/7、偶数 16 → ext 8/8。長さは 48 + 55 - 15 = 88、88 + 48 - 16 = 120
  expect(graph.filterComplex).toContain("xfade=transition=fade:duration=0.500500:offset=1.101100");
  expect(graph.filterComplex).toContain("xfade=transition=fade:duration=0.533867:offset=2.402400");
  expect(graph.filterComplex).toContain("trim=end_frame=120");
});

test("overlap mode uses the clip positions as stored", () => {
  const project = base();
  // overlap では to.start_f が既に duration_f ぶん前倒しされている
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 30), clip("c2", 20, 60, 90));
  project.transitions.push(
    TransitionSchema.parse({ id: "t1", track: "V1", from: "c1", to: "c2", duration_f: 10, mode: "overlap" }),
  );
  const graph = graphOf(project);
  expect(graph.totalFrames).toBe(50);
  expect(graph.filterComplex).toContain("trim=start_frame=0:end_frame=30");
  expect(graph.filterComplex).toContain("trim=start_frame=60:end_frame=90");
  expect(graph.filterComplex).toContain("xfade=transition=fade:duration=0.333333:offset=0.666667");
});

test("an upper video track is composited with overlay and frame-number enable", () => {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 60));
  project.tracks.push(TrackSchema.parse({ id: "V2", kind: "video" }));
  project.tracks
    .find((t) => t.id === "V2")!
    .clips.push(
      clip("c2", 10, 0, 30, {
        video: { opacity: 0.5, transform: { position: "top-right", margin: 8, scale: 0.25 } },
      }),
    );
  const graph = graphOf(project);
  expect(graph.filterComplex).toContain("scale=iw*0.25:-2");
  expect(graph.filterComplex).toContain("format=yuva420p,colorchannelmixer=aa=0.5");
  expect(graph.filterComplex).toContain("setpts=PTS+0.333333/TB");
  expect(graph.filterComplex).toContain("overlay=x=W-w-8:y=8:enable='between(n,10,39)':eof_action=pass");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("track and clip fades become frame-indexed fade filters", () => {
  const project = base();
  project.tracks[0]!.fade = { in_f: 10, out_f: 12, color: "white" };
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 60, { video: { fade: { in_f: 4, out_f: 6, color: "black" } } }));
  project.tracks[1]!.fade = { in_f: 10, out_f: 12, color: "black" };
  project.tracks[1]!.clips.push(clip("c2", 0, 0, 60, { audio: { fade: { in_f: 3, out_f: 5, curve: "tri" } } }));
  const graph = graphOf(project);
  expect(graph.filterComplex).toContain("fade=t=in:s=0:n=4:color=black");
  expect(graph.filterComplex).toContain("fade=t=out:s=54:n=6:color=black");
  expect(graph.filterComplex).toContain("fade=t=in:s=0:n=10:color=white");
  expect(graph.filterComplex).toContain("fade=t=out:s=48:n=12:color=white");
  // 音声はサンプル指定（30fps / 48kHz なので 1 フレーム = 1600 サンプル）
  expect(graph.filterComplex).toContain("afade=t=in:ss=0:ns=4800:curve=tri");
  expect(graph.filterComplex).toContain("afade=t=in:ss=0:ns=16000:curve=tri");
  expect(graph.filterComplex).toContain("afade=t=out:ss=76800:ns=19200:curve=tri");
});

test("speed changes setpts on video and atempo on audio", () => {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 120, { speed: 2 }));
  project.tracks[1]!.clips.push(clip("c2", 0, 0, 120, { speed: 2, pitch_keep: true }));
  const graph = graphOf(project);
  expect(graph.totalFrames).toBe(60);
  expect(graph.filterComplex).toContain("setpts=PTS/2");
  expect(graph.filterComplex).toContain("tpad=stop=-1:stop_mode=clone");
  expect(graph.filterComplex).toContain("trim=end_frame=60");
  expect(graph.filterComplex).toContain("atempo=2");
  expect(graph.filterComplex).toContain("atrim=end_sample=96000");
});

test("audio offsets shift by samples and negative offsets trim the head", () => {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 60));
  project.tracks[1]!.clips.push(clip("c2", 30, 0, 30, { audio: { offset_smp: -960 } }));
  const graph = graphOf(project);
  // adelay = smp(30) - 960 = 48000 - 960
  expect(graph.filterComplex).toContain("adelay=47040S:all=1");
  project.tracks[1]!.clips[0] = clip("c2", 0, 0, 30, { audio: { offset_smp: -960 } });
  expect(buildGraph(project, { resolution: RES, source }).filterComplex).toContain("atrim=start_sample=960");
});

test("a range build produces only the segment and starts at frame 0", () => {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 60), clip("c2", 60, 100, 160));
  const graph = buildGraph(project, { resolution: RES, source, range: { from_f: 40, to_f: 100 }, audio: false });
  expect(graph.totalFrames).toBe(60);
  expect(graph.mapAudio).toBe("");
  // 区間にかかる 2 クリップだけが入力になる
  expect(graph.inputs).toHaveLength(2);
  // 単独クリップは切り出しを素材側にたたみ込む（c1 の 40..60、c2 の先頭 40 フレーム）
  expect(graph.filterComplex).toContain("trim=start_frame=40:end_frame=60");
  expect(graph.filterComplex).toContain("trim=start_frame=100:end_frame=140");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("a range build keeps a transition group whole and slices the result", () => {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 60), clip("c2", 60, 100, 160));
  project.transitions.push(TransitionSchema.parse({ id: "t1", track: "V1", from: "c1", to: "c2", duration_f: 12 }));
  const graph = buildGraph(project, { resolution: RES, source, range: { from_f: 60, to_f: 120 }, audio: false });
  expect(graph.totalFrames).toBe(60);
  expect(graph.filterComplex).toContain("xfade=");
  // グループ全体（120 フレーム）を作ってから区間を切り出す
  expect(graph.filterComplex).toContain("trim=start_frame=60:end_frame=120");
});

test("serializeGraph emits one -filter_complex argument and pins the frame count", () => {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 45));
  const graph = graphOf(project);
  const args = serializeGraph(graph, {
    path: "/out/x.mp4",
    format: "mp4",
    video: { codec: "libx264", preset: "ultrafast", crf: 35, pixFmt: "yuv420p", gop: 60 },
    audio: { codec: "aac", bitrate: "96k", sampleRate: 48000, channels: 2 },
    faststart: true,
  });
  expect(args.filter((a) => a === "-filter_complex")).toHaveLength(1);
  expect(args[args.indexOf("-filter_complex") + 1]).toBe(graph.filterComplex);
  expect(args.slice(args.indexOf("-frames:v"), args.indexOf("-frames:v") + 2)).toEqual(["-frames:v", "45"]);
  expect(args.at(-1)).toBe("/out/x.mp4");
  expect(args).toContain("+faststart");
  // 映像だけ / 音声だけの出力は -an / -vn になる
  const videoOnly = buildGraph(project, { resolution: RES, source, audio: false, range: { from_f: 0, to_f: 45 } });
  expect(serializeGraph(videoOnly, { path: "/o.mp4", format: "mp4", video: { codec: "libx264" } })).toContain("-an");
});

// テロップの焼き込み（#21）とダッキング / loudnorm（#22）は結線済みなので、ここでは扱わない。
// まだ残っている未対応は「ループ」「クリップエフェクト」「3D LUT」「3ch 以上の音声」だけ。
test("unsupported constructs still fail with E_NOT_IMPLEMENTED", () => {
  const looped = base();
  looped.tracks[0]!.clips.push(clip("c1", 0, 0, 30, { loop: true }));
  expect(() => graphOf(looped)).toThrow(/looped clips/);

  const effects = base();
  effects.tracks[0]!.clips.push(clip("c1", 0, 0, 30, { effects: [{ type: "blur", params: { sigma: 4 } }] }));
  expect(() => graphOf(effects)).toThrow(/clip effects/);

  const lut = base();
  const c = clip("c1", 0, 0, 30);
  c.video = { ...c.video, lut: "/tmp/x.cube" } as typeof c.video;
  lut.tracks[0]!.clips.push(c);
  expect(() => graphOf(lut)).toThrow(/LUT/);

  const surround = base();
  surround.settings.channels = 6;
  surround.tracks[0]!.clips.push(clip("c1", 0, 0, 30));
  expect(() => graphOf(surround)).toThrow(/two audio channels/);
});
