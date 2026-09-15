/**
 * ゴールデンテスト（docs/12 ADR-09）。
 *
 * `xfade` の `offset` / `duration` は秒でしか渡せないため、30 / 29.97 / 59.94 fps それぞれで
 * 「合成後のフレーム数 = `timelineDurationF(project)`」を `ffprobe -count_frames` で厳密に確認する。
 * 29.97 では さらにトランジション前後のフレームが素材のどのフレームかを PSNR で照合する。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timelineDurationF } from "../../../src/core/assets.ts";
import { createProject } from "../../../src/core/project.ts";
import { ClipSchema, type Fps, type Project, TransitionSchema, VideoAssetSchema } from "../../../src/core/schema.ts";
import { ensureFixtures } from "../../../src/ffmpeg/fixtures.ts";
import { locateBinaries } from "../../../src/ffmpeg/locate.ts";
import { buildRenderPlan, verifyRender } from "../../../src/ffmpeg/render.ts";
import { runFfmpeg } from "../../../src/ffmpeg/run.ts";

const bins = locateBinaries();
const RESOLUTION = { width: 320, height: 180 };
/** 素材の切り出し（c1: 10..50、c2: 60..100。どちらも 40 フレーム） */
const C1 = { in_f: 10, out_f: 50 };
const C2 = { in_f: 60, out_f: 100 };
const TOTAL_F = 80;

let fixtures: Record<string, string>;
const dirs: string[] = [];
beforeAll(async () => {
  fixtures = await ensureFixtures(bins, "tests/fixtures", ["a", "a2997"]);
}, 120000);
afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const NORMALIZE =
  "scale=320:180:force_original_aspect_ratio=decrease:flags=bicubic,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=#000000,setsar=1,format=yuv420p";

async function setup(name: string, fps: Fps, fixture: string, durationF: number) {
  const dir = await mkdtemp(join(tmpdir(), `montash-golden-${name}-`));
  dirs.push(dir);
  await copyFile(fixture, join(dir, "a.mp4"));
  const project = createProject({ name, fps, resolution: { width: 640, height: 360 } });
  // 5 秒の素材。fps 変換後のフレーム数の下限を使う（ハンドル分の余白は十分にある）
  const duration_f = Math.floor((5 * fps.num) / fps.den) - 1;
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", asset: "a", start_f: 0, ...C1, link: "c2" }),
    ClipSchema.parse({ id: "c3", asset: "a", start_f: 40, ...C2, link: "c4" }),
  );
  project.tracks[1]!.clips.push(
    ClipSchema.parse({ id: "c2", asset: "a", start_f: 0, ...C1, link: "c1" }),
    ClipSchema.parse({ id: "c4", asset: "a", start_f: 40, ...C2, link: "c3" }),
  );
  project.transitions.push(
    TransitionSchema.parse({ id: "t1", track: "V1", from: "c1", to: "c3", type: "fade", duration_f: durationF }),
  );
  return { dir, project };
}

async function render(project: Project, dir: string, output: string, crf = 35) {
  const plan = await buildRenderPlan(project, dir, output, {
    preset: "web-preview",
    resolution: RESOLUTION,
    crf,
    speed: "ultrafast",
    threads: 2,
  });
  await runFfmpeg(bins, ["-y", ...plan.args], { timeoutMs: 120_000 });
  return verifyRender(bins, output, project, RESOLUTION);
}

/** 動画の K フレーム目を PNG に抜く（`-fps_mode passthrough` で select の結果をそのまま書く） */
async function extractFrame(input: string, frame: number, output: string, pre: string[] = []) {
  await runFfmpeg(
    bins,
    [
      "-y",
      "-i",
      input,
      "-vf",
      [...pre, `select=eq(n\\,${frame})`].join(","),
      "-fps_mode",
      "passthrough",
      "-frames:v",
      "1",
      output,
    ],
    { timeoutMs: 60_000 },
  );
}

/** 2 枚の PNG の PSNR（dB）。完全一致なら Infinity */
async function psnr(a: string, b: string): Promise<number> {
  let value = Number.NaN;
  await runFfmpeg(
    bins,
    [
      "-i",
      a,
      "-i",
      b,
      "-filter_complex",
      "[0:v]format=yuv420p[x];[1:v]format=yuv420p[y];[x][y]psnr",
      "-f",
      "null",
      "-",
    ],
    {
      timeoutMs: 60_000,
      onStderrLine: (line) => {
        const m = /average:([0-9.]+|inf)/.exec(line);
        if (m) value = m[1] === "inf" ? Number.POSITIVE_INFINITY : Number(m[1]);
      },
    },
  );
  return value;
}

const CASES: Array<{ name: string; fps: Fps; fixture: "a" | "a2997" }> = [
  { name: "30", fps: { num: 30, den: 1 }, fixture: "a" },
  { name: "29.97", fps: { num: 30000, den: 1001 }, fixture: "a2997" },
  { name: "59.94", fps: { num: 60000, den: 1001 }, fixture: "a" },
];

for (const c of CASES) {
  // duration_f は奇数（ext 8/7）と偶数（ext 8/8）の両方
  for (const durationF of [15, 16]) {
    test(`xfade of f:${durationF} at ${c.name}fps keeps the exact frame count`, async () => {
      const { dir, project } = await setup(`${c.name}-${durationF}`, c.fps, fixtures[c.fixture]!, durationF);
      expect(timelineDurationF(project)).toBe(TOTAL_F);
      const result = await render(project, dir, join(dir, "out.mp4"));
      expect(result.valid).toBe(true);
      expect(result.actual_frames).toBe(TOTAL_F);
      expect(result.expected_frames).toBe(TOTAL_F);
    }, 120000);
  }
}

test("at 29.97fps the frames around the xfade come from the expected source frames", async () => {
  const durationF = 15; // ext_from = 8, ext_to = 7
  const { dir, project } = await setup("2997-psnr", { num: 30000, den: 1001 }, fixtures.a2997!, durationF);
  const out = join(dir, "out.mp4");
  // PSNR で素材と比べるので、この 1 本だけ高品質に焼く
  const result = await render(project, dir, out, 16);
  expect(result.actual_frames).toBe(TOTAL_F);

  // v0 は素材 [10, 58)、v1 は素材 [53, 100)。offset = 48 - 15 = 33 フレーム
  //   k in [0, 33)  → 素材 10 + k
  //   k in [48, 80) → 素材 53 + (k - 33)
  const pairs: Array<{ k: number; source: number }> = [
    { k: 0, source: C1.in_f },
    { k: 32, source: C1.in_f + 32 },
    { k: 48, source: C2.in_f - 7 + 15 },
    { k: 79, source: C2.in_f - 7 + 46 },
  ];
  for (const { k, source } of pairs) {
    const actual = join(dir, `out-${k}.png`);
    const expected = join(dir, `src-${source}.png`);
    await extractFrame(out, k, actual);
    await extractFrame(join(dir, "a.mp4"), source, expected, ["fps=30000/1001", NORMALIZE]);
    const db = await psnr(actual, expected);
    if (process.env.MONTASH_GOLDEN_VERBOSE) console.log(`  frame ${k} vs source ${source}: PSNR ${db} dB`);
    expect(db).toBeGreaterThanOrEqual(30);
  }

  // トランジションの途中は両方のどちらとも一致しない（実際にブレンドされている）
  const middle = join(dir, "out-40.png");
  await extractFrame(out, 40, middle);
  const left = join(dir, "src-50.png");
  await extractFrame(join(dir, "a.mp4"), C1.in_f + 40, left, ["fps=30000/1001", NORMALIZE]);
  expect(await psnr(middle, left)).toBeLessThan(30);
}, 180000);
