/**
 * 出力プリセット（docs/07 §9）と出力段の単体テスト。ffmpeg は起動しない。
 *
 * - 各プリセットが期待する ffmpeg 引数を作ること（スナップショット）
 * - `--reframe` の crop 式
 * - `--hwaccel auto` の選択順と `W_CRF_IGNORED`
 * - `--two-pass` が 1 パス目（`-f null`）と 2 パス目を作ること
 * - `project.render_presets`（`base` 継承）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MontashError } from "../../../src/cli/errors.ts";
import { createProject } from "../../../src/core/project.ts";
import { type Project, VideoAssetSchema } from "../../../src/core/schema.ts";
import {
  BUILTIN_PRESETS,
  buildRenderPlan,
  HWACCEL_ORDER,
  PRESET_NAMES,
  type PresetSpec,
  parseReframe,
  planResolution,
  reframeCrop,
  resolvePresets,
  selectHwEncoder,
  supportsTwoPass,
} from "../../../src/ffmpeg/render.ts";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "montash-presets-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "a.mp4"), "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 30fps / 640x360、クリップ 1 本（f:0..30）のプロジェクト */
function base(): Project {
  const project = createProject({ name: "p", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = VideoAssetSchema.parse({
    id: "a",
    type: "video",
    path: "assets/a.mp4",
    duration_f: 300,
    width: 640,
    height: 360,
    fps: { num: 30, den: 1 },
  });
  project.tracks[0]?.clips.push({
    id: "c1",
    type: "media",
    asset: "a",
    start_f: 0,
    in_f: 0,
    out_f: 30,
    speed: 1,
    pitch_keep: false,
    loop: false,
    link: null,
    effects: [],
    video: {
      opacity: 1,
      transform: null,
      crop: null,
      color: null,
      lut: null,
      keep_alpha: false,
      fade: { in_f: 0, out_f: 0, color: "black" },
    },
    audio: null,
    // biome-ignore lint/suspicious/noExplicitAny: ClipSchema の既定値をそのまま使うためのテスト用リテラル
  } as any);
  return project;
}

/** 入力パスを除いた引数（環境に依存しない部分だけ）をスナップショットにする */
function plainArgs(args: string[]): string[] {
  return args.map((a) => (a.startsWith(dir) ? "<tmp>" : a));
}

describe("RENDER_PRESETS", () => {
  test("docs/07 §9 + docs/04 §14 の 10 プリセットが揃っている", () => {
    expect(PRESET_NAMES).toEqual([
      "youtube-1080p",
      "youtube-4k",
      "instagram-reel",
      "twitter",
      "web-preview",
      "prores-422",
      "archive-h265",
      "audio-only-mp3",
      "gif",
      "thumbnail",
    ]);
  });

  for (const name of Object.keys(BUILTIN_PRESETS)) {
    test(`${name} が期待する ffmpeg 引数を作る`, async () => {
      const project = base();
      const preset = BUILTIN_PRESETS[name as keyof typeof BUILTIN_PRESETS] as PresetSpec;
      const output = join(dir, `out${preset.ext}`);
      const plan = await buildRenderPlan(project, dir, output, { preset: name });
      expect({
        preset: plan.preset,
        format: plan.format,
        resolution: plan.resolution,
        vcodec: plan.vcodec,
        acodec: plan.acodec,
        verifiable: plan.verifiable,
        // filter_complex は graph/ 側のスナップショットに任せ、ここでは出力段だけを見る
        args: plainArgs(plan.args).filter((a) => a !== plan.filter_complex),
      }).toMatchSnapshot();
    });
  }

  test("解像度は --resolution > プリセット > タイムライン の順", () => {
    const project = base();
    const of = (name: keyof typeof BUILTIN_PRESETS): PresetSpec => BUILTIN_PRESETS[name] as PresetSpec;
    expect(planResolution(project, of("youtube-1080p"))).toEqual({ width: 1920, height: 1080 });
    expect(planResolution(project, of("prores-422"))).toEqual({ width: 640, height: 360 });
    // gif は幅 480 でアスペクト維持（偶数）
    expect(planResolution(project, of("gif"))).toEqual({ width: 480, height: 270 });
    expect(planResolution(project, of("gif"), { width: 200, height: 100 })).toEqual({ width: 200, height: 100 });
  });

  test("gif は palettegen / paletteuse を出力段に足し、15fps でフレーム数を数え直す", async () => {
    const plan = await buildRenderPlan(base(), dir, join(dir, "a.gif"), { preset: "gif" });
    expect(plan.filter_complex).toContain("palettegen");
    expect(plan.filter_complex).toContain("paletteuse");
    expect(plan.fps).toEqual({ num: 15, den: 1 });
    expect(plan.duration_f).toBe(15); // 30 フレーム @30fps → 15 フレーム @15fps
    expect(plan.args).toContain("-an");
    expect(plan.verifiable).toBe(false);
  });
});

describe("--reframe", () => {
  test("16:9 → 9:16 は幅を切る。基準は center / left / right / x%", () => {
    const from = { width: 1920, height: 1080 };
    const to = { width: 1080, height: 1920 };
    expect(reframeCrop(from, to, "center")).toEqual({ w: 608, h: 1080, x: 656, y: 0 });
    expect(reframeCrop(from, to, "left")).toEqual({ w: 608, h: 1080, x: 0, y: 0 });
    expect(reframeCrop(from, to, "right")).toEqual({ w: 608, h: 1080, x: 1312, y: 0 });
    expect(reframeCrop(from, to, { percent: 25 })).toEqual({ w: 608, h: 1080, x: 328, y: 0 });
  });

  test("9:16 → 16:9 は高さを切る。アスペクトが同じなら crop しない", () => {
    expect(reframeCrop({ width: 1080, height: 1920 }, { width: 1920, height: 1080 }, "center")).toEqual({
      w: 1080,
      h: 608,
      x: 0,
      y: 656,
    });
    expect(reframeCrop({ width: 1920, height: 1080 }, { width: 1280, height: 720 }, "center")).toBeNull();
  });

  test("指定すると crop + scale が出力段に入り、省略するとレターボックス（pad）のまま", async () => {
    const reframed = await buildRenderPlan(base(), dir, join(dir, "r.mp4"), {
      preset: "instagram-reel",
      reframe: parseReframe("center"),
    });
    expect(reframed.filter_complex).toContain("crop=202:360:218:0,scale=1080:1920:flags=bicubic,setsar=1");
    expect(reframed.resolution).toEqual({ width: 1080, height: 1920 });

    const letterboxed = await buildRenderPlan(base(), dir, join(dir, "l.mp4"), { preset: "instagram-reel" });
    expect(letterboxed.filter_complex).not.toContain("crop=");
    expect(letterboxed.filter_complex).toContain("pad=1080:1920");
  });

  test("不正な値は E_USAGE", () => {
    expect(() => parseReframe("middle")).toThrow(MontashError);
    expect(() => parseReframe("120%")).toThrow(MontashError);
    expect(parseReframe("40%")).toEqual({ percent: 40 });
  });
});

describe("--hwaccel", () => {
  const all = new Set(HWACCEL_ORDER.map((h) => h.encoder));

  test("auto は videotoolbox → nvenc → vaapi → qsv の順に選ぶ", () => {
    expect(selectHwEncoder("auto", all).encoder).toBe("h264_videotoolbox");
    expect(selectHwEncoder("auto", new Set(["h264_nvenc", "h264_vaapi"])).encoder).toBe("h264_nvenc");
    expect(selectHwEncoder("auto", new Set(["h264_qsv"])).encoder).toBe("h264_qsv");
  });

  test("auto で 1 つも無ければ libx264 のまま W_HWACCEL_UNAVAILABLE", () => {
    const sel = selectHwEncoder("auto", new Set());
    expect(sel.encoder).toBeNull();
    expect(sel.warnings.map((w) => w.code)).toEqual(["W_HWACCEL_UNAVAILABLE"]);
  });

  test("明示指定が使えなければ E_FFMPEG_FEATURE_MISSING、none は何もしない", () => {
    expect(() => selectHwEncoder("nvenc", new Set())).toThrow(MontashError);
    expect(selectHwEncoder("none", all).encoder).toBeNull();
  });

  test("ビットレート指定に切り替わり、-crf は無視されて W_CRF_IGNORED", async () => {
    const plan = await buildRenderPlan(base(), dir, join(dir, "hw.mp4"), {
      preset: "youtube-1080p",
      hwaccel: "auto",
      encoders: new Set(["h264_videotoolbox"]),
    });
    expect(plan.vcodec).toBe("h264_videotoolbox");
    expect(plan.args).not.toContain("-crf");
    expect(plan.args.join(" ")).toContain("-b:v 8M");
    expect(plan.warnings.map((w) => w.code)).toContain("W_CRF_IGNORED");
  });
});

describe("--two-pass", () => {
  test("libx264 + ビットレートなら 1 パス目（-f null）と 2 パス目を作る", async () => {
    const plan = await buildRenderPlan(base(), dir, join(dir, "tp.mp4"), {
      preset: "youtube-1080p",
      vbitrate: "8M",
      twoPass: true,
    });
    expect(plan.two_pass).toBe(true);
    expect(plan.pass1_args?.join(" ")).toContain("-pass 1");
    expect(plan.pass1_args?.slice(-2)).toEqual(["null", "/dev/null"]);
    // 1 パス目は映像だけ（未使用の音声出力ラベルがあると ffmpeg が失敗する）
    expect(plan.pass1_args).toContain("-an");
    expect(plan.args.join(" ")).toContain("-pass 2");
    expect(supportsTwoPass("libx264")).toBe(true);
    expect(supportsTwoPass("h264_videotoolbox")).toBe(false);
  });

  test("ビットレート指定が無ければ無視して W_TWO_PASS_IGNORED", async () => {
    const plan = await buildRenderPlan(base(), dir, join(dir, "tp2.mp4"), { preset: "youtube-1080p", twoPass: true });
    expect(plan.two_pass).toBe(false);
    expect(plan.pass1_args).toBeNull();
    expect(plan.warnings.map((w) => w.code)).toContain("W_TWO_PASS_IGNORED");
  });
});

describe("project.render_presets", () => {
  test("base を継承して一部だけ上書きできる", async () => {
    const project = base();
    project.render_presets = { "yt-fast": { base: "youtube-1080p", crf: 30, preset_speed: "ultrafast" } };
    const table = resolvePresets(project);
    expect(table["yt-fast"]?.source).toBe("project");
    expect(table["yt-fast"]?.video?.crf).toBe(30);
    expect(table["yt-fast"]?.video?.speed).toBe("ultrafast");
    expect(table["yt-fast"]?.resolution).toEqual({ width: 1920, height: 1080 });
    const plan = await buildRenderPlan(project, dir, join(dir, "u.mp4"), { preset: "yt-fast", presets: table });
    expect(plan.args.join(" ")).toContain("-crf 30");
    expect(plan.args.join(" ")).toContain("-preset ultrafast");
  });

  test("base 省略時は youtube-1080p、循環と未知キーは E_USAGE", () => {
    const project = base();
    project.render_presets = { plain: { resolution: "800x600" } };
    expect(resolvePresets(project).plain?.resolution).toEqual({ width: 800, height: 600 });

    project.render_presets = { a: { base: "b" }, b: { base: "a" } };
    expect(() => resolvePresets(project)).toThrow(MontashError);

    project.render_presets = { bad: { base: "youtube-1080p", nope: 1 } };
    expect(() => resolvePresets(project)).toThrow(MontashError);
  });
});
