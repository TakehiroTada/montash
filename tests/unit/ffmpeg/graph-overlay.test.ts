/**
 * オーバーレイのフィルタグラフ（docs/07 §5）。
 * `video.transform` が付いた映像クリップが上位トラックに乗ったときの overlay チェーンを固定する。
 */
import { expect, test } from "bun:test";
import { createProject } from "../../../src/core/project.ts";
import {
  type Asset,
  ClipSchema,
  ImageAssetSchema,
  type Project,
  TrackSchema,
  VideoAssetSchema,
} from "../../../src/core/schema.ts";
import { buildGraph } from "../../../src/ffmpeg/graph/builder.ts";

const RES = { width: 320, height: 180 };
const source = (asset: Asset) => `/fixtures/${asset.path}`;
const chains = (filter: string) => filter.split(";");

/** 30fps / 640x360、映像 a（10 秒）とアルファ PNG logo を持つプロジェクト */
function base(): Project {
  const project = createProject({ name: "overlay", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 300 });
  project.assets.logo = ImageAssetSchema.parse({
    id: "logo",
    type: "image",
    path: "logo.png",
    video: { width: 256, height: 128, pix_fmt: "rgba", has_alpha: true },
  });
  project.tracks[0]!.clips.push(ClipSchema.parse({ id: "c1", asset: "a", start_f: 0, in_f: 0, out_f: 120 }));
  return project;
}

/** 上位映像トラックに transform 付きクリップを 1 本足す */
function overlayOn(project: Project, trackId: string, clip: Record<string, unknown>): void {
  let track = project.tracks.find((t) => t.id === trackId);
  if (!track) {
    track = TrackSchema.parse({ id: trackId, kind: "video", name: trackId });
    project.tracks.splice(project.tracks.map((t) => t.kind).lastIndexOf("video") + 1, 0, track);
  }
  track.clips.push(ClipSchema.parse(clip));
}

test("one overlay scales, keeps alpha and is enabled by base frame numbers", () => {
  const project = base();
  overlayOn(project, "V2", {
    id: "c2",
    asset: "logo",
    start_f: 0,
    in_f: 0,
    out_f: 120,
    video: { opacity: 0.9, transform: { position: "top-right", margin: 24, scale: 0.12 } },
  });
  const graph = buildGraph(project, { resolution: RES, source });
  expect(graph.totalFrames).toBe(120);
  expect(graph.filterComplex).toContain("scale=iw*0.12:-2");
  expect(graph.filterComplex).toContain("format=yuva420p,colorchannelmixer=aa=0.9");
  expect(graph.filterComplex).toContain("overlay=x=W-w-24:y=24:enable='between(n,0,119)':eof_action=pass");
  // start_f = 0 のオーバーレイは setpts のシフトを挟まない
  expect(graph.filterComplex).not.toContain("setpts=PTS+0/TB");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("two overlays on separate tracks stack in array order", () => {
  const project = base();
  overlayOn(project, "V2", {
    id: "c2",
    asset: "logo",
    start_f: 0,
    in_f: 0,
    out_f: 120,
    video: { transform: { position: "top-right", margin: 24, scale: 0.12 } },
  });
  overlayOn(project, "V3", {
    id: "c3",
    asset: "a",
    start_f: 30,
    in_f: 60,
    out_f: 90,
    video: { transform: { position: "bottom-right", margin: 16, scale: 0.3 } },
  });
  const graph = buildGraph(project, { resolution: RES, source });
  expect(graph.totalFrames).toBe(120);
  // 下 → 上の順に 2 回 overlay する
  const overlays = graph.filterComplex.match(/overlay=x=/g) ?? [];
  expect(overlays).toHaveLength(2);
  expect(graph.filterComplex).toContain("overlay=x=W-w-24:y=24:enable='between(n,0,119)'");
  expect(graph.filterComplex).toContain("overlay=x=W-w-16:y=H-h-16:enable='between(n,30,59)'");
  // 区間の頭出し: 30 フレーム = 1 秒ぶんのシフト
  expect(graph.filterComplex).toContain("setpts=PTS+1.000000/TB");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("percent coordinates resolve against the output resolution", () => {
  const project = base();
  overlayOn(project, "V2", {
    id: "c2",
    asset: "logo",
    start_f: 0,
    in_f: 0,
    out_f: 60,
    video: { transform: { position: null, x: "10%", y: "75%", scale: 0.5 } },
  });
  const graph = buildGraph(project, { resolution: RES, source });
  // x = 320 * 10 / 100、y = 180 * 75 / 100
  expect(graph.filterComplex).toContain("overlay=x=320*10/100:y=180*75/100");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});

test("pixel coordinates pass through unchanged", () => {
  const project = base();
  overlayOn(project, "V2", {
    id: "c2",
    asset: "logo",
    start_f: 0,
    in_f: 0,
    out_f: 60,
    video: { transform: { position: null, x: 12, y: 34 } },
  });
  const graph = buildGraph(project, { resolution: RES, source });
  expect(graph.filterComplex).toContain("overlay=x=12:y=34");
  // scale = 1 のときは scale フィルタを挟まない
  expect(graph.filterComplex).not.toContain("scale=iw*1:-2");
});

test("an alpha PNG overlay keeps yuva420p through keep_alpha", () => {
  const project = base();
  overlayOn(project, "V2", {
    id: "c2",
    asset: "logo",
    start_f: 0,
    in_f: 0,
    out_f: 60,
    video: { keep_alpha: true, transform: { position: "center" } },
  });
  const graph = buildGraph(project, { resolution: RES, source });
  // 画像は -loop 1 -framerate で入力し、アルファを保ったまま重ねる
  expect(graph.inputs.some((i) => i.includes("-loop"))).toBe(true);
  expect(graph.filterComplex).toContain("format=yuva420p");
  expect(graph.filterComplex).toContain("overlay=x=(W-w)/2:y=(H-h)/2");
  expect(chains(graph.filterComplex)).toMatchSnapshot();
});
