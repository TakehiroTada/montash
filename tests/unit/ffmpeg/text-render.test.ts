/**
 * テロップ焼き込みのゴールデンテスト（docs/03 W-06、docs/07 §6、docs/12 ADR-09）。
 *
 * 実際に ffmpeg を回して次を確かめる:
 *   - 焼き込んでも出力フレーム数が `timelineDurationF(project)` と**厳密に一致**する（`render verify` 相当）
 *   - テロップの表示区間の中のフレームだけ画が変わり、区間外は焼く前と同じ
 *   - 日本語が豆腐にならない（同じ文字数の未定義文字を焼いた画と一致しない）
 *   - 29.97fps（分数 fps）でも同じ結果になる
 *
 * libass 無しのビルドでは丸ごと skip する（`tests/unit/ffmpeg/ass-burn.test.ts` と同じ判定）。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timelineDurationF } from "../../../src/core/assets.ts";
import { createProject } from "../../../src/core/project.ts";
import {
  ClipSchema,
  type Fps,
  type Project,
  TextClipSchema,
  TrackSchema,
  VideoAssetSchema,
} from "../../../src/core/schema.ts";
import { ensureFixtures } from "../../../src/ffmpeg/fixtures.ts";
import { listFonts } from "../../../src/ffmpeg/fonts.ts";
import { type Binaries, inspectFfmpeg, locateBinaries } from "../../../src/ffmpeg/locate.ts";
import { buildPreview } from "../../../src/ffmpeg/preview.ts";
import { buildRenderPlan, verifyRender } from "../../../src/ffmpeg/render.ts";
import { runFfmpeg } from "../../../src/ffmpeg/run.ts";

const bins: Binaries = locateBinaries();
// skipIf はモジュール読み込み時に評価されるので、libass と CJK フォントの有無もここで調べる
const hasLibass = (await inspectFfmpeg(bins)).textEngine === "libass";
const cjkFamily = (await listFonts()).fonts.find((f) => f.cjk)?.family;

/** 出力解像度（プロジェクトは 640x360。ASS の PlayRes と出力サイズをわざとずらす） */
const RESOLUTION = { width: 320, height: 180 };
/** タイムライン: 2 秒。テロップは [TEXT_FROM, TEXT_TO) */
const TOTAL_F = 60;
const TEXT_FROM = 20;
const TEXT_TO = 40;

let fixtures: Record<string, string>;
const dirs: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtures(bins, "tests/fixtures", ["a", "a2997"]);
}, 120000);
afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(name: string, fps: Fps, fixture: string): Promise<{ dir: string; project: Project }> {
  const dir = await mkdtemp(join(tmpdir(), `montash-text-render-${name}-`));
  dirs.push(dir);
  await copyFile(fixture, join(dir, "a.mp4"));
  const project = createProject({ name, fps, resolution: { width: 640, height: 360 } });
  if (cjkFamily !== undefined) project.settings.default_font = cjkFamily;
  project.assets.a = VideoAssetSchema.parse({
    id: "a",
    type: "video",
    path: "a.mp4",
    duration_f: Math.floor((5 * fps.num) / fps.den) - 1,
  });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: TOTAL_F }),
  );
  return { dir, project };
}

/** テキストトラックを足した複製を返す（元のプロジェクトは変えない） */
function withText(project: Project, text: string): Project {
  const copy = structuredClone(project);
  copy.tracks.push(
    TrackSchema.parse({
      id: "T1",
      kind: "text",
      clips: [
        TextClipSchema.parse({
          id: "x1",
          type: "text",
          start_f: TEXT_FROM,
          duration_f: TEXT_TO - TEXT_FROM,
          text,
          style: { size: 64, color: "#FFFFFF", bg: "#000000EE", bg_padding: 10, position: "center" },
        }),
      ],
    }),
  );
  return copy;
}

async function render(project: Project, dir: string, output: string) {
  const plan = await buildRenderPlan(project, dir, output, {
    preset: "web-preview",
    resolution: RESOLUTION,
    crf: 18,
    speed: "ultrafast",
    threads: 2,
  });
  await runFfmpeg(bins, ["-y", ...plan.args], { timeoutMs: 120_000 });
  return { plan, verified: await verifyRender(bins, output, project, RESOLUTION) };
}

/** 動画の K フレーム目を PNG に抜く */
async function extractFrame(input: string, frame: number, output: string): Promise<void> {
  await runFfmpeg(
    bins,
    ["-y", "-i", input, "-vf", `select=eq(n\\,${frame})`, "-fps_mode", "passthrough", "-frames:v", "1", output],
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
];

for (const c of CASES) {
  test.skipIf(!hasLibass)(
    `${c.name}fps: テロップを焼いてもフレーム数が一致し、表示区間の中だけ画が変わる`,
    async () => {
      const { dir, project } = await setup(c.name, c.fps, fixtures[c.fixture]!);
      const plain = join(dir, "plain.mp4");
      const burned = join(dir, "burned.mp4");

      const bare = await render(project, dir, plain);
      const text = withText(project, cjkFamily !== undefined ? "日本語テロップ" : "montash telop");
      // テキストクリップは映像の内側に収まっているので尺は変わらない
      expect(timelineDurationF(text)).toBe(TOTAL_F);
      const withTelop = await render(text, dir, burned);

      // `render verify` 相当: nb_read_frames == timelineDurationF(project)
      expect(withTelop.verified.valid).toBe(true);
      expect(withTelop.verified.actual_frames).toBe(TOTAL_F);
      expect(withTelop.verified.expected_frames).toBe(TOTAL_F);
      expect(bare.verified.actual_frames).toBe(TOTAL_F);
      // 焼き込みは subtitles フィルタ 1 回だけ（docs/07 §6）
      expect(withTelop.plan.filter_complex.match(/subtitles=/g)).toHaveLength(1);

      // 表示区間の中: 焼く前と画が違う
      const inside = Math.floor((TEXT_FROM + TEXT_TO) / 2);
      await extractFrame(burned, inside, join(dir, "in-burned.png"));
      await extractFrame(plain, inside, join(dir, "in-plain.png"));
      const insideDb = await psnr(join(dir, "in-burned.png"), join(dir, "in-plain.png"));
      expect(insideDb).toBeLessThan(35);

      // 表示区間の外: 焼く前とほぼ同じ（区間外にはみ出していない）
      for (const k of [TEXT_FROM - 5, TEXT_TO + 5]) {
        await extractFrame(burned, k, join(dir, `out-${k}-burned.png`));
        await extractFrame(plain, k, join(dir, `out-${k}-plain.png`));
        const db = await psnr(join(dir, `out-${k}-burned.png`), join(dir, `out-${k}-plain.png`));
        if (process.env.MONTASH_GOLDEN_VERBOSE) console.log(`  ${c.name}fps frame ${k}: PSNR ${db} dB`);
        expect(db).toBeGreaterThan(40);
      }
    },
    180000,
  );
}

// CJK フォントが無い環境では日本語も .notdef になり比較にならないので skip する
test.skipIf(!hasLibass || cjkFamily === undefined)(
  "日本語が豆腐にならない（fontsdir の CJK フォールバックが効く）",
  async () => {
    const { dir, project } = await setup("cjk", { num: 30, den: 1 }, fixtures.a!);
    const japanese = join(dir, "jp.mp4");
    const notdef = join(dir, "notdef.mp4");
    await render(withText(project, "日本語表示"), dir, japanese);
    // 同じ文字数の私用領域（グリフを持つフォントは無い = 必ず .notdef）と比べる
    const pua = String.fromCharCode(0xe000, 0xe001, 0xe002, 0xe003, 0xe004);
    await render(withText(project, pua), dir, notdef);

    const frame = Math.floor((TEXT_FROM + TEXT_TO) / 2);
    await extractFrame(japanese, frame, join(dir, "jp.png"));
    await extractFrame(notdef, frame, join(dir, "notdef.png"));
    const [jp, nd] = await Promise.all([readFile(join(dir, "jp.png")), readFile(join(dir, "notdef.png"))]);
    // 豆腐同士なら同じ .notdef が 5 つ並んで完全一致する
    expect(Buffer.compare(jp, nd)).not.toBe(0);
    expect(await psnr(join(dir, "jp.png"), join(dir, "notdef.png"))).toBeLessThan(40);
  },
  180000,
);

// ---------------------------------------------------------------------------
// プレビュー（セグメントごとの ASS 時刻シフト。docs/07 §11.1）
// ---------------------------------------------------------------------------

test.skipIf(!hasLibass)(
  "プレビューのセグメントでもテロップがタイムライン上の正しい位置に出る",
  async () => {
    // テキストクリップの端もセグメント境界になるので、149 フレームは [0,60) と [60,149) に割れる。
    // テロップは f:60..90 なので 2 本目のセグメントのローカル f:0..30 に現れる必要がある
    // （シフトを忘れるとローカル f:60..90 = タイムライン f:120..150 にずれて出る）。
    const { dir, project } = await setup("preview", { num: 30, den: 1 }, fixtures.a!);
    project.tracks[0]!.clips[0] = ClipSchema.parse({
      id: "c1",
      type: "media",
      asset: "a",
      start_f: 0,
      in_f: 0,
      out_f: 149,
    });

    const plain = await buildPreview(project, dir, { height: 180 });
    expect(plain.status.duration_f).toBe(149);
    await copyFile(plain.status.path!, join(dir, "plain-preview.mp4"));

    const text = structuredClone(project);
    text.tracks.push(
      TrackSchema.parse({
        id: "T1",
        kind: "text",
        clips: [
          TextClipSchema.parse({
            id: "x1",
            type: "text",
            start_f: 60,
            duration_f: 30,
            text: "LATE",
            style: { size: 120, color: "#FFFFFF", position: "center" },
          }),
        ],
      }),
    );
    const burned = await buildPreview(text, dir, { height: 180 });
    expect(burned.status.duration_f).toBe(149);
    expect(burned.built_segments).toBe(2);

    const compare = async (frame: number): Promise<number> => {
      await extractFrame(join(dir, "plain-preview.mp4"), frame, join(dir, `p-${frame}.png`));
      await extractFrame(burned.status.path!, frame, join(dir, `b-${frame}.png`));
      return psnr(join(dir, `p-${frame}.png`), join(dir, `b-${frame}.png`));
    };
    // 表示区間の手前と後ろは同じ絵、区間の中だけ変わる（シフトを忘れると全区間で一致してしまう）
    expect(await compare(50)).toBeGreaterThan(40);
    expect(await compare(75)).toBeLessThan(35);
    expect(await compare(125)).toBeGreaterThan(40);
  },
  180000,
);
