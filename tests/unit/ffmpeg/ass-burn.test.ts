/**
 * 生成した ASS を実際に libass（`subtitles` フィルタ）で焼く検証（docs/07 §6, ADR-10）。
 *
 * - libass 無しのビルド（`doctor` が textEngine: drawtext と判定する環境）では丸ごと skip する
 * - 判定は「単色背景に焼いた 1 フレームの画が変わるか」で行う（表示区間の中と外を比べる）
 * - 日本語が豆腐になっていないことは、同じ文字数の未定義文字（私用領域）を焼いた画と
 *   ピクセル単位で一致しないことで確認する（豆腐同士なら同じ .notdef が並ぶので一致する）
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fps, type Resolution, SubtitleStyleSchema } from "../../../src/core/schema.ts";
import {
  buildAssDocument,
  prepareFontsDir,
  subtitleMarginV,
  subtitlesFilter,
  subtitleTextStyle,
  type TextClipLike,
  writeAssFile,
} from "../../../src/ffmpeg/ass.ts";
import { listFonts } from "../../../src/ffmpeg/fonts.ts";
import { type Binaries, inspectFfmpeg, locateBinaries } from "../../../src/ffmpeg/locate.ts";
import { runFfmpeg } from "../../../src/ffmpeg/run.ts";

const RES: Resolution = { width: 320, height: 180 };
const FPS: Fps = { num: 30, den: 1 };

// skipIf はモジュール読み込み時に評価されるので、libass の有無もトップレベルで調べる
const bins: Binaries = locateBinaries();
const hasLibass = (await inspectFfmpeg(bins)).textEngine === "libass";

let dir: string;
let fontsDir: string;
let cjkFamily: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-ass-burn-"));
  // fontsdir には CJK フォールバックが必ず入る（prepareFontsDir の保証）
  fontsDir = await prepareFontsDir([], dir);
  cjkFamily = (await listFonts()).fonts.find((f) => f.cjk)?.family;
}, 30000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** 単色（既定は灰色）の 2 秒（30fps）に ASS を焼き、指定フレームを PNG で 1 枚取り出す */
async function burnFrame(assPath: string, frame: number, out: string, fonts = fontsDir, bg = "gray"): Promise<number> {
  const filter = [
    subtitlesFilter({ assPath, fontsDir: fonts, originalSize: RES }),
    `trim=start_frame=${frame}:end_frame=${frame + 1}`,
    "setpts=PTS-STARTPTS",
  ].join(",");
  const result = await runFfmpeg(
    bins,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${bg}:s=${RES.width}x${RES.height}:r=30:d=2`,
      "-vf",
      filter,
      "-frames:v",
      "1",
      "-c:v",
      "png",
      "-f",
      "image2",
      out,
    ],
    { timeoutMs: 30000 },
  );
  return result.exitCode;
}

/** 1 フレーム PNG の signalstats を 1 つ読む（YAVG / YMIN） */
async function lumaStat(png: string, key: "YAVG" | "YMIN"): Promise<number> {
  let value = Number.NaN;
  await runFfmpeg(
    bins,
    ["-i", png, "-vf", `signalstats,metadata=print:key=lavfi.signalstats.${key}`, "-f", "null", "-"],
    {
      timeoutMs: 30000,
      onStderrLine: (line) => {
        const m = new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`).exec(line);
        if (m?.[1]) value = Number(m[1]);
      },
    },
  );
  return value;
}

/** 1 フレーム PNG の平均輝度（signalstats の YAVG） */
const averageLuma = (png: string): Promise<number> => lumaStat(png, "YAVG");

const clip = (text: string, style: TextClipLike["style"] = {}): TextClipLike => ({
  id: "x1",
  start_f: 0,
  duration_f: 30,
  text,
  style: { size: 40, color: "#FFFFFF", position: "center", ...style },
});

test.skipIf(!hasLibass)(
  "libass が生成した ASS を受理し、表示区間の中だけ画が変わる",
  async () => {
    const doc = buildAssDocument([clip("Hello montash", { bg: "#000000CC", bg_padding: 8 })], {
      resolution: RES,
      fps: FPS,
      ...(cjkFamily !== undefined ? { defaultFont: cjkFamily } : {}),
    });
    const ass = await writeAssFile(doc, dir);
    const inside = join(dir, "inside.png");
    const outside = join(dir, "outside.png");

    expect(await burnFrame(ass, 15, inside)).toBe(0);
    expect(await burnFrame(ass, 45, outside)).toBe(0);

    const lumaInside = await averageLuma(inside);
    const lumaOutside = await averageLuma(outside);
    // 表示区間の外は灰一色、中は文字と背景ボックスが乗るので平均輝度が変わる
    expect(Math.abs(lumaInside - lumaOutside)).toBeGreaterThan(1);
    // 区間外のフレームは焼く前と同じ単色のまま
    expect(lumaOutside).toBeGreaterThan(100);
  },
  60000,
);

// CJK フォントが無い環境では日本語も .notdef になり比較にならないので skip する
test.skipIf(!hasLibass || cjkFamily === undefined)(
  "日本語が豆腐にならない（fontsdir の CJK フォールバックが効く）",
  async () => {
    const opts = { resolution: RES, fps: FPS, ...(cjkFamily !== undefined ? { defaultFont: cjkFamily } : {}) };
    // 同じ文字数の私用領域（グリフを持つフォントは無い = 必ず .notdef）と比べる
    const japanese = await writeAssFile(buildAssDocument([clip("日本語表示")], opts), dir);
    const notdef = await writeAssFile(buildAssDocument([clip("\uE000\uE001\uE002\uE003\uE004")], opts), dir);
    const jpPng = join(dir, "jp.png");
    const notdefPng = join(dir, "notdef.png");
    expect(await burnFrame(japanese, 15, jpPng)).toBe(0);
    expect(await burnFrame(notdef, 15, notdefPng)).toBe(0);

    const [jp, nd] = await Promise.all([readFile(jpPng), readFile(notdefPng)]);
    // 豆腐同士なら同じ .notdef が 5 つ並んで完全一致する
    expect(Buffer.compare(jp, nd)).not.toBe(0);
    // 文字が実際に描かれている（表示区間外の灰一色とは違う）
    const blank = join(dir, "jp-blank.png");
    expect(await burnFrame(japanese, 45, blank)).toBe(0);
    expect(Math.abs((await averageLuma(jpPng)) - (await averageLuma(blank)))).toBeGreaterThan(0.5);
  },
  60000,
);

test.skipIf(!hasLibass)(
  "BorderStyle=3 フォールバックでも libass は ASS を受理する",
  async () => {
    const doc = buildAssDocument([clip("fallback", { bg: "#000000CC", bg_padding: 8 })], {
      resolution: RES,
      fps: FPS,
      borderStyle: 3,
      ...(cjkFamily !== undefined ? { defaultFont: cjkFamily } : {}),
    });
    const ass = await writeAssFile(doc, dir);
    const out = join(dir, "border3.png");
    expect(await burnFrame(ass, 15, out)).toBe(0);
    expect(await averageLuma(out)).toBeLessThan(126);
  },
  60000,
);

// ---------------------------------------------------------------------------
// 白背景のスライドに字幕を焼く（docs/04 §12: 縁取り・背景ボックス）
// ---------------------------------------------------------------------------

/** 字幕クリップ 1 件を CLI と同じ経路（`subtitleTextStyle`）で ASS にする */
function subtitleAss(style: Record<string, unknown>): string {
  const parsed = SubtitleStyleSchema.parse({ size: 40, color: "#FFFFFF", ...style });
  const marginV = subtitleMarginV(parsed);
  return buildAssDocument(
    [
      {
        id: "s1_0",
        start_f: 0,
        duration_f: 30,
        text: "Hello montash",
        markup: "plain",
        style: subtitleTextStyle(parsed, cjkFamily),
        ...(marginV !== undefined ? { marginV } : {}),
      },
    ],
    { resolution: RES, fps: FPS, ...(cjkFamily !== undefined ? { defaultFont: cjkFamily } : {}) },
  );
}

test.skipIf(!hasLibass)(
  "白背景では白字だけだと読めず、--outline / --bg を足すと読めるようになる",
  async () => {
    const plain = join(dir, "white-plain.png");
    const outlined = join(dir, "white-outline.png");
    const boxed = join(dir, "white-bg.png");

    // 白背景 + 白字（縁取りも箱も無い）= スライドの白に溶ける
    expect(await burnFrame(await writeAssFile(subtitleAss({}), dir), 15, plain, fontsDir, "white")).toBe(0);
    // 同じ白字に 3px の黒縁を足す
    const outline = subtitleAss({ outline: { width: 3, color: "#000000" } });
    expect(await burnFrame(await writeAssFile(outline, dir), 15, outlined, fontsDir, "white")).toBe(0);
    // 背景ボックス（不透明の黒）
    const bg = subtitleAss({ bg: "#000000", bg_padding: 8 });
    expect(await burnFrame(await writeAssFile(bg, dir), 15, boxed, fontsDir, "white")).toBe(0);

    // 縁取りも箱も無いと、最も暗い画素すら白のまま = 文字の輪郭がどこにも無い
    expect(await lumaStat(plain, "YMIN")).toBeGreaterThan(200);
    // 縁取り・箱があれば暗い画素が現れる（= 白背景でも文字が分離できている）
    expect(await lumaStat(outlined, "YMIN")).toBeLessThan(80);
    expect(await lumaStat(boxed, "YMIN")).toBeLessThan(80);
    // 箱のほうが面積が広いぶん、画全体は暗くなる
    expect(await averageLuma(boxed)).toBeLessThan(await averageLuma(outlined));
  },
  90000,
);
