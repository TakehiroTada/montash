/**
 * 組み込みエフェクトが実際にフィルタグラフへ差し込まれること（計画 P1-3、docs/07 §3a）。
 *
 * `tests/unit/ffmpeg/graph-build.test.ts` の「clip effects are expanded ...」がレジストリ経由の
 * 差し込み位置そのものを見ているのに対し、ここは **組み込みエフェクトが素通しでグラフに乗るか** を見る。
 * とくに `rotate` は 90/270 で幅と高さが入れ替わるので、`scale`/`pad` との順序を明示的に確認する。
 */
import { expect, test } from "bun:test";
import { createProject } from "../../../src/core/project.ts";
import { type Asset, ClipSchema, type Project, VideoAssetSchema } from "../../../src/core/schema.ts";
import { buildGraph } from "../../../src/ffmpeg/graph/builder.ts";

const RES = { width: 640, height: 360 };
const source = (asset: Asset) => `/fixtures/${asset.path}`;

function base(): Project {
  const project = createProject({ name: "builtin-effects", fps: { num: 30, den: 1 }, resolution: RES });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 300 });
  return project;
}

function clip(id: string, start: number, inF: number, outF: number, extra: Record<string, unknown> = {}) {
  return ClipSchema.parse({ id, type: "media", asset: "a", start_f: start, in_f: inF, out_f: outF, ...extra });
}

/** 1 クリップに `effects[]` を掛けたときのフィルタチェーン（`;` 区切りの 1 本目相当を含む全文） */
function chainWith(effects: readonly unknown[]): string {
  const project = base();
  project.tracks[0]!.clips.push(clip("c1", 0, 0, 30, { effects }));
  return buildGraph(project, { resolution: RES, source }).filterComplex;
}

test("blur / mosaic / lut3d / flip がそのままフィルタグラフに乗る", () => {
  const chain = chainWith([
    { type: "blur", params: { sigma: 12 } },
    { type: "mosaic", params: { size: 24 } },
    { type: "lut3d", params: { file: "/luts/film.cube" } },
    { type: "flip", params: { direction: "both" } },
  ]);
  for (const filter of [
    "gblur=sigma=12",
    "pixelize=w=24:h=24:mode=avg",
    "lut3d=file='/luts/film.cube'",
    "hflip",
    "vflip",
  ])
    expect(chain).toContain(filter);
});

test("effects[] は配列順に、setsar のあと・format の前へ入る（docs/07 §3a）", () => {
  const chain = chainWith([{ type: "mosaic", params: { size: 8 } }, { type: "blur" }]);
  const order = ["setsar=1", "pixelize=w=8:h=8:mode=avg", "gblur=sigma=4", "format=yuv420p"].map((f) =>
    chain.indexOf(f),
  );
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

test("既定値だけでも掛けられる（params 省略）", () => {
  expect(chainWith([{ type: "blur" }])).toContain("gblur=sigma=4");
  expect(chainWith([{ type: "mosaic" }])).toContain("pixelize=w=16:h=16:mode=avg");
  expect(chainWith([{ type: "flip" }])).toContain("hflip");
});

test("sigma=0 のぼかしはグラフに何も足さない", () => {
  expect(chainWith([{ type: "blur", params: { sigma: 0 } }])).not.toContain("gblur");
});

test("rotate 90 は transpose のあとに解像度へ戻す scale/pad が続く（concat が壊れない）", () => {
  const chain = chainWith([{ type: "rotate", params: { angle: "90" } }]);
  // 正規化の scale/pad（fit）→ setsar → transpose → 戻しの scale/pad → format の順
  expect(chain).toContain(
    "setsar=1,transpose=1,scale=640:360:force_original_aspect_ratio=decrease:flags=bicubic," +
      "pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p",
  );
});

test("rotate 180 は大きさが変わらないので戻しが入らない", () => {
  expect(chainWith([{ type: "rotate", params: { angle: "180" } }])).toContain("setsar=1,hflip,vflip,format=yuv420p");
});

test("rotate 90 を掛けても連結されるクリップの本数と尺は変わらない", () => {
  const project = base();
  project.tracks[0]!.clips.push(
    clip("c1", 0, 0, 30, { effects: [{ type: "rotate", params: { angle: "90" } }] }),
    clip("c2", 30, 60, 90),
  );
  const graph = buildGraph(project, { resolution: RES, source });
  expect(graph.totalFrames).toBe(60);
  expect(graph.filterComplex).toContain("concat=n=2:v=1:a=0");
  // 回転したクリップだけが戻しの pad を持ち、タイムライン解像度は変わらない
  expect(graph.filterComplex.match(/pad=640:360:\(ow-iw\)\/2:\(oh-ih\)\/2(?!:)/g)?.length).toBe(1);
  expect(graph.resolution).toEqual(RES);
});

test("未登録の種別は E_PLUGIN_MISSING（hint に組み込みの一覧が出る）", () => {
  try {
    chainWith([{ type: "glow" }]);
    throw new Error("should have thrown");
  } catch (e) {
    const err = e as { code?: string; hint?: string };
    expect(err.code).toBe("E_PLUGIN_MISSING");
    expect(err.hint).toContain("blur");
    expect(err.hint).toContain("mosaic");
  }
});
