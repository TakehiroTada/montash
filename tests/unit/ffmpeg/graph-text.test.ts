/**
 * テキスト・字幕の焼き込み結線（docs/07 §6, §7、docs/12 ADR-10）。
 *
 * `buildGraph()` は純関数のままで、ASS の生成・書き出し（I/O）は `prepareText()` が行う。
 * ここでは「用意された ASS がグラフのどこに、どんな形で入るか」と
 * 「区間レンダーで ASS の時刻がセグメント先頭基準にシフトされるか」を確かめる。
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject } from "../../../src/core/project.ts";
import {
  type Asset,
  AssetSchema,
  ClipSchema,
  type Project,
  SubtitleClipSchema,
  TextClipSchema,
  TrackSchema,
  VideoAssetSchema,
} from "../../../src/core/schema.ts";
import { parseSubtitleCues, shiftAssDocument } from "../../../src/ffmpeg/ass.ts";
import { buildGraph } from "../../../src/ffmpeg/graph/builder.ts";
import { drawtextPosition } from "../../../src/ffmpeg/graph/text.ts";
import { prepareText, shiftClipsToRange } from "../../../src/ffmpeg/text-prepare.ts";

const RES = { width: 320, height: 180 };
const source = (asset: Asset) => `/fixtures/${asset.path}`;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "montash-graph-text-"));
  dirs.push(dir);
  return dir;
}

/** 30fps / 640x360、映像 1 本（5 秒）のプロジェクト */
function base(): Project {
  const project = createProject({ name: "text", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 300 });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 150 }),
  );
  return project;
}

function addTextTrack(project: Project, clips: unknown[]): void {
  project.tracks.push(TrackSchema.parse({ id: "T1", kind: "text", clips }));
}

const SRT = `1
00:00:01,000 --> 00:00:02,000
最初の字幕

2
00:00:03,500 --> 00:00:04,500
<i>二番目</i>
の字幕
`;

/** 映像の最終チェーン（`[V<n>]` で終わるもの） */
const videoChain = (filter: string): string => filter.split(";").find((c) => /\[V\d+\]$/.test(c)) ?? "";

/** スナップショットからパスとハッシュの揺れを取り除く */
const stable = (filter: string, dir: string): string[] =>
  filter.split(";").map((chain) => chain.replaceAll(dir, "<tmp>").replace(/[0-9a-f]{16}\.(ass|txt)/g, "<hash>.$1"));

// ---------------------------------------------------------------------------
// 純関数
// ---------------------------------------------------------------------------

test("SRT / VTT を表示単位に分解する（番号行・インラインタグ・空行は落とす）", () => {
  const cues = parseSubtitleCues(SRT);
  expect(cues).toEqual([
    { startMs: 1000, endMs: 2000, text: "最初の字幕" },
    { startMs: 3500, endMs: 4500, text: "二番目\nの字幕" },
  ]);
  // VTT（時が省略でき、小数点は "."）
  const vtt = parseSubtitleCues("WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nhello\n");
  expect(vtt).toEqual([{ startMs: 1000, endMs: 2000, text: "hello" }]);
});

test("区間シフトは先頭を 0 にし、はみ出す部分を切り詰める", () => {
  const clips = [
    { id: "x1", start_f: 0, duration_f: 90, text: "a" },
    { id: "x2", start_f: 100, duration_f: 30, text: "b" },
    { id: "x3", start_f: 200, duration_f: 30, text: "c" },
  ];
  expect(shiftClipsToRange(clips, { from_f: 60, to_f: 120 })).toEqual([
    // 先頭で切られた分だけ短くなる（f:60..90 → ローカル 0..30）
    { id: "x1", start_f: 0, duration_f: 30, text: "a" },
    // 末尾で切られる（f:100..120 → ローカル 40..60）
    { id: "x2", start_f: 40, duration_f: 20, text: "b" },
  ]);
});

test("ASS 素材の時刻シフトは本文に触らず Dialogue だけを動かす", () => {
  const doc = ["[Events]", "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\b1}hi", "Comment: 0,x"].join("\n");
  expect(shiftAssDocument(doc, 1500)).toBe(
    ["[Events]", "Dialogue: 0,0:00:02.50,0:00:03.50,Default,,0,0,0,,{\\b1}hi", "Comment: 0,x"].join("\n"),
  );
  // 前に出しすぎて負になった行は落とす
  expect(shiftAssDocument(doc, -3000)).toBe(["[Events]", "Comment: 0,x"].join("\n"));
  expect(shiftAssDocument(doc, 0)).toBe(doc);
});

test("drawtext の位置式はプリセットと座標のどちらも出せる", () => {
  expect(drawtextPosition("bottom-center", "center", RES, 16, 9)).toEqual({ x: "(w-tw)/2", y: "h-th-9" });
  expect(drawtextPosition("top-left", "left", RES, 16, 9)).toEqual({ x: "16", y: "9" });
  expect(drawtextPosition({ x: 100, y: 50 }, "right", RES, 16, 9)).toEqual({ x: "100-tw", y: "50" });
});

// ---------------------------------------------------------------------------
// 結線
// ---------------------------------------------------------------------------

test("テキストトラックは overlay の後・出力 format の前に subtitles で 1 回焼かれる", async () => {
  const dir = await tmp();
  const project = base();
  addTextTrack(project, [
    TextClipSchema.parse({ id: "x1", type: "text", start_f: 0, duration_f: 90, text: "Summer Trip 2026" }),
    TextClipSchema.parse({ id: "x2", type: "text", start_f: 120, duration_f: 30, text: "福岡到着" }),
  ]);

  const text = await prepareText(project, dir, { engine: "libass", tmpDir: dir, fonts: [] });
  expect(text.engine).toBe("libass");
  expect(text.burn?.layers).toHaveLength(1);
  // ASS の PlayRes は出力解像度ではなくプロジェクト解像度（px 指定が 1:1 になる）
  expect(text.burn?.originalSize).toEqual({ width: 640, height: 360 });

  const graph = buildGraph(project, { resolution: RES, source, text: text.burn! });
  const last = videoChain(graph.filterComplex);
  expect(last).toContain("subtitles=filename=");
  expect(last).toContain("original_size=640x360");
  // 焼くのは出力 format の直前（docs/07 §6）
  expect(last.indexOf("subtitles=")).toBeLessThan(last.indexOf("format=yuv420p"));
  expect(graph.totalFrames).toBe(150);
  expect(stable(graph.filterComplex, dir)).toMatchSnapshot();

  const doc = await readFile(text.burn!.layers![0]!.assPath, "utf8");
  expect(doc).toContain("PlayResX: 640");
  expect(doc).toContain("Dialogue: 0,0:00:00.00,0:00:03.00,x1,");
  expect(doc).toContain("Dialogue: 0,0:00:04.00,0:00:05.00,x2,");
  expect(doc).toContain("福岡到着");
});

test("burn 字幕（SRT）はテロップと同じ ASS の Events に統合される", async () => {
  const dir = await tmp();
  const project = base();
  project.assets.ja_srt = AssetSchema.parse({ id: "ja_srt", type: "subtitle", path: "ja.srt", format: "srt" });
  await writeFile(join(dir, "ja.srt"), SRT, "utf8");
  addTextTrack(project, [
    TextClipSchema.parse({ id: "x1", type: "text", start_f: 0, duration_f: 30, text: "title" }),
    SubtitleClipSchema.parse({
      id: "s1",
      type: "subtitle",
      asset: "ja_srt",
      mode: "burn",
      start_f: 0,
      offset_f: 15,
      style: { size: 40, margin_bottom: 60 },
      lang: "ja",
    }),
  ]);

  const text = await prepareText(project, dir, { engine: "libass", tmpDir: dir, fonts: [] });
  expect(text.soft).toHaveLength(0);
  // 生成 ASS は 1 つだけ（SRT は Events に統合されるので別フィルタにならない）
  expect(text.burn?.layers).toHaveLength(1);

  const doc = await readFile(text.burn!.layers![0]!.assPath, "utf8");
  // offset_f = 15 フレーム = 0.5 秒ぶんずれる
  expect(doc).toContain("Dialogue: 0,0:00:01.50,0:00:02.50,s1_0,");
  expect(doc).toContain("Dialogue: 0,0:00:04.00,0:00:05.00,s1_1,");
  // margin_bottom は Style の MarginV に入る
  expect(doc).toMatch(/Style: s1_0,[^\n]*,2,32,32,60,1/);
  expect(doc).toContain("二番目\\Nの字幕");

  const graph = buildGraph(project, { resolution: RES, source, text: text.burn! });
  expect(graph.filterComplex.match(/subtitles=/g)).toHaveLength(1);
});

test("burn の ASS 素材はスタイルを尊重して別の subtitles で焼く", async () => {
  const dir = await tmp();
  const project = base();
  project.assets.styled = AssetSchema.parse({ id: "styled", type: "subtitle", path: "styled.ass", format: "ass" });
  await writeFile(
    join(dir, "styled.ass"),
    "[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,source styled\n",
    "utf8",
  );
  addTextTrack(project, [
    TextClipSchema.parse({ id: "x1", type: "text", start_f: 0, duration_f: 30, text: "title" }),
    SubtitleClipSchema.parse({ id: "s1", type: "subtitle", asset: "styled", mode: "burn", start_f: 0, offset_f: 30 }),
  ]);
  const text = await prepareText(project, dir, { engine: "libass", tmpDir: dir, fonts: [] });
  expect(text.burn?.layers).toHaveLength(2);
  const shifted = await readFile(text.burn!.layers![1]!.assPath, "utf8");
  expect(shifted).toContain("Dialogue: 0,0:00:02.00,0:00:03.00,Default,,0,0,0,,source styled");

  const graph = buildGraph(project, { resolution: RES, source, text: text.burn! });
  expect(graph.filterComplex.match(/subtitles=/g)).toHaveLength(2);
});

test("区間レンダーでは ASS の時刻がセグメント先頭基準にシフトする", async () => {
  const dir = await tmp();
  const project = base();
  addTextTrack(project, [
    TextClipSchema.parse({ id: "x1", type: "text", start_f: 60, duration_f: 60, text: "middle" }),
    TextClipSchema.parse({ id: "x2", type: "text", start_f: 130, duration_f: 20, text: "later" }),
  ]);
  const range = { from_f: 90, to_f: 150 };
  const text = await prepareText(project, dir, { engine: "libass", tmpDir: dir, fonts: [], range });
  const doc = await readFile(text.burn!.layers![0]!.assPath, "utf8");
  // x1 は f:60..120 → 区間 [90,150) のローカル 0..30（頭が切られる）
  expect(doc).toContain("Dialogue: 0,0:00:00.00,0:00:01.00,x1,");
  // x2 は f:130..150 → ローカル 40..60
  expect(doc).toContain("Dialogue: 0,0:00:01.33,0:00:02.00,x2,");

  const graph = buildGraph(project, { resolution: RES, source, range, audio: false, text: text.burn! });
  expect(graph.totalFrames).toBe(60);
  expect(stable(graph.filterComplex, dir)).toMatchSnapshot();
});

test("soft 字幕は焼かずに多重化の指定だけを返す", async () => {
  const dir = await tmp();
  const project = base();
  project.assets.ja_srt = AssetSchema.parse({ id: "ja_srt", type: "subtitle", path: "ja.srt", format: "srt" });
  await writeFile(join(dir, "ja.srt"), SRT, "utf8");
  addTextTrack(project, [
    SubtitleClipSchema.parse({
      id: "s1",
      type: "subtitle",
      asset: "ja_srt",
      mode: "soft",
      start_f: 0,
      offset_f: 30,
      lang: "ja",
    }),
  ]);
  const text = await prepareText(project, dir, { engine: "libass", tmpDir: dir, fonts: [] });
  expect(text.burn).toBeUndefined();
  expect(text.soft).toEqual([
    { path: join(dir, "ja.srt"), codec: "mov_text", language: "ja", offsetS: "1.000000", default: true },
  ]);
  // 焼かないのでグラフは字幕が無いときと 1 文字も変わらない
  const withText = buildGraph(project, { resolution: RES, source });
  expect(withText.filterComplex).not.toContain("subtitles=");
});

test("libass 無しビルドは drawtext にフォールバックして W_TEXT_ENGINE_LIMITED を出す", async () => {
  const dir = await tmp();
  const project = base();
  addTextTrack(project, [
    TextClipSchema.parse({
      id: "x1",
      type: "text",
      start_f: 30,
      duration_f: 60,
      text: "fallback",
      style: { size: 48, color: "#FFEE00", bg: "#000000CC", bg_padding: 8, position: "bottom-center" },
      fade: { in_f: 15, out_f: 15 },
    }),
  ]);
  const text = await prepareText(project, dir, { engine: "drawtext", tmpDir: dir, fonts: [] });
  expect(text.engine).toBe("drawtext");
  expect(text.warnings.map((w) => w.code)).toContain("W_TEXT_ENGINE_LIMITED");
  expect(text.burn?.draws).toHaveLength(1);

  const graph = buildGraph(project, { resolution: RES, source, text: text.burn! });
  const last = videoChain(graph.filterComplex);
  expect(last).toContain("drawtext=textfile=");
  // 320x180 は 640x360 の半分なので px は半分に縮む
  expect(last).toContain("fontsize=24");
  expect(last).toContain("fontcolor=0xFFEE00@1");
  expect(last).toContain("box=1:boxcolor=0x000000@0.8:boxborderw=4");
  expect(last).toContain("enable='between(n\\,30\\,89)'");
  expect(stable(graph.filterComplex, dir)).toMatchSnapshot();
});

test("subtitles も drawtext も無いビルドではテキストを飛ばしてレンダーを続ける", async () => {
  const dir = await tmp();
  const project = base();
  addTextTrack(project, [TextClipSchema.parse({ id: "x1", type: "text", start_f: 0, duration_f: 30, text: "hi" })]);
  const text = await prepareText(project, dir, { engine: "none", tmpDir: dir, fonts: [] });
  expect(text.burn).toBeUndefined();
  expect(text.warnings[0]?.code).toBe("W_TEXT_ENGINE_LIMITED");
  // E_NOT_IMPLEMENTED では落ちない
  const graph = buildGraph(project, { resolution: RES, source });
  expect(graph.totalFrames).toBe(150);
  expect(graph.filterComplex).not.toContain("subtitles=");
});

test("ミュートしたテキストトラックは焼かれない", async () => {
  const dir = await tmp();
  const project = base();
  project.tracks.push(
    TrackSchema.parse({
      id: "T1",
      kind: "text",
      muted: true,
      clips: [TextClipSchema.parse({ id: "x1", type: "text", start_f: 0, duration_f: 30, text: "hidden" })],
    }),
  );
  const text = await prepareText(project, dir, { engine: "libass", tmpDir: dir, fonts: [] });
  expect(text.burn).toBeUndefined();
});
