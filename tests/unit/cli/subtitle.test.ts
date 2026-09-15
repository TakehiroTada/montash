/**
 * `subtitle add|set|remove|list` のハンドラを直接呼ぶテスト（docs/04 §12、W-14）。
 * tests/unit/cli/text.test.ts と同じ書き方（yargs を通さないので camelCase で渡す）。
 */
import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setSubtitleFontCache,
  subtitleAdd,
  subtitleList,
  subtitleRemove,
  subtitleSet,
} from "../../../src/cli/commands/subtitle.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { AssetSchema, ClipSchema, isSubtitleClip, type SubtitleClip } from "../../../src/core/schema.ts";
import type { FontEntry } from "../../../src/ffmpeg/fonts.ts";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: true,
  quiet: false,
  verbose: false,
  dryRun: false,
  yes: true,
  noColor: true,
  timeFormat: "frames",
  ...over,
});

let dir: string;

function ctx(argv: string[], over: Partial<GlobalOptions> = {}) {
  return createContext(globals({ project: dir, ...over }), {
    cwd: dir,
    env: { MONTASH_ACTOR: "ai" },
    isTTY: false,
    argv,
  });
}

type Args = Record<string, any>;
const call = (spec: { handler: (c: never, a: never) => unknown }, args: Args = {}, over?: Partial<GlobalOptions>) =>
  spec.handler(ctx(["test"], over) as never, args as never) as Promise<CommandResult>;

/** システムフォントに依存しないよう、列挙結果を固定する */
const FONTS: FontEntry[] = [
  { family: "Hiragino Sans", style: "W3", path: "/System/Library/Fonts/Hiragino.ttc", cjk: true },
  { family: "Helvetica", style: "Regular", path: "/System/Library/Fonts/Helvetica.ttc", cjk: false },
];

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nこんにちは\n";

/** 30fps / 1920x1080、映像 1 本と字幕素材 2 つ（srt と ass） */
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-subtitle-"));
  const project = createProject({ name: "s", fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 } });
  project.assets.a = AssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_s: 5, duration_f: 150 });
  project.assets.ja_srt = AssetSchema.parse({ id: "ja_srt", type: "subtitle", path: "ja.srt", format: "srt" });
  project.assets.styled = AssetSchema.parse({ id: "styled", type: "subtitle", path: "styled.ass", format: "ass" });
  project.tracks[0]!.clips.push(ClipSchema.parse({ id: "c1", asset: "a", start_f: 0, in_f: 0, out_f: 150 }));
  await initProjectDir(dir, project, { force: true });
  await writeFile(join(dir, "ja.srt"), SRT, "utf8");
  await writeFile(join(dir, "styled.ass"), "[Events]\n", "utf8");
  await recordInitialOp(dir, project, ctx(["init"]));
}

beforeEach(async () => {
  __setSubtitleFontCache(FONTS);
  await setup();
});

const clipsOf = async (): Promise<SubtitleClip[]> =>
  (await loadProject(dir)).tracks.flatMap((t) => t.clips.filter(isSubtitleClip));

// ---------------------------------------------------------------------------
// subtitle add
// ---------------------------------------------------------------------------

test("subtitle add はテキストトラックが無ければ T1 を自動作成し s1 を発行する", async () => {
  const res = (await call(subtitleAdd, { asset: "ja_srt", mode: "burn" })) as any;
  expect(res.result.track_created).toBe("T1");
  expect(res.result.clip.id).toBe("s1");
  expect(res.result.clip.mode).toBe("burn");
  expect(res.result.clip.format).toBe("srt");
  expect(res.op).toBeTruthy();

  const project = await loadProject(dir);
  expect(project.tracks.map((t) => t.id)).toEqual(["V1", "A1", "T1"]);
  // 字幕クリップは尺を持たないのでタイムライン長を伸ばさない
  expect(project.tracks[2]?.clips[0]?.start_f).toBe(0);

  const second = (await call(subtitleAdd, { asset: "ja_srt", mode: "soft", lang: "ja" })) as any;
  expect(second.result.track_created).toBeNull();
  expect(second.result.clip.id).toBe("s2");
  expect((await clipsOf()).map((c) => c.id)).toEqual(["s1", "s2"]);
});

test("--font / --size / --color / --margin-bottom はスタイルに入る", async () => {
  await call(subtitleAdd, {
    asset: "ja_srt",
    mode: "burn",
    font: "Hiragino Sans",
    size: 40,
    color: "#FFEE00",
    marginBottom: 60,
  });
  const [clip] = await clipsOf();
  expect(clip?.style).toEqual({ font: "Hiragino Sans", size: 40, color: "#FFEE00", margin_bottom: 60 });
});

test("--font を省くと CJK 対応フォントに解決される（burn の SRT のみ）", async () => {
  await call(subtitleAdd, { asset: "ja_srt", mode: "burn" });
  expect((await clipsOf())[0]?.style.font).toBe("Hiragino Sans");
  // soft は焼かないのでフォントを埋めない
  await call(subtitleAdd, { asset: "ja_srt", mode: "soft", lang: "ja" });
  expect((await clipsOf())[1]?.style.font).toBeUndefined();
});

test("--offset はフレームに丸めて offset_f に入る（±t も受ける）", async () => {
  const res = (await call(subtitleAdd, { asset: "ja_srt", offset: "+0.5" })) as any;
  expect(res.result.clip.offset_f).toBe(15);
  expect(res.result.clip.offset).toBeCloseTo(0.5, 6);
  await call(subtitleSet, { id: "s1", offset: "-f:30" });
  expect((await clipsOf())[0]?.offset_f).toBe(-30);
});

test("ASS 素材に --font/--size を渡すと素材のスタイルが勝つと警告する", async () => {
  const res = (await call(subtitleAdd, { asset: "styled", mode: "burn", size: 40 })) as any;
  expect(res.warnings.map((w: { code: string }) => w.code)).toContain("W_SUBTITLE_STYLE_IGNORED");
  expect(res.result.clip.format).toBe("ass");
});

test("字幕素材でない asset は E_ASSET_TYPE_MISMATCH", async () => {
  const err = await call(subtitleAdd, { asset: "a" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MontashError);
  expect((err as MontashError).code).toBe("E_ASSET_TYPE_MISMATCH");
  expect((await clipsOf()).length).toBe(0);
});

test("知らないフォントは E_ASSET_NOT_FOUND ではなく E_FONT_NOT_FOUND", async () => {
  const err = await call(subtitleAdd, { asset: "ja_srt", font: "NoSuchFontXYZ" }).catch((e: unknown) => e);
  expect((err as MontashError).code).toBe("E_FONT_NOT_FOUND");
  expect((err as MontashError).detail?.candidates).toEqual([]);
});

test("映像トラックを --track に指定すると E_USAGE", async () => {
  const err = await call(subtitleAdd, { asset: "ja_srt", track: "V1" }).catch((e: unknown) => e);
  expect((err as MontashError).code).toBe("E_USAGE");
});

// ---------------------------------------------------------------------------
// subtitle set / remove / list
// ---------------------------------------------------------------------------

test("subtitle set は mode / lang / asset を差し替える", async () => {
  await call(subtitleAdd, { asset: "ja_srt", mode: "burn", size: 40 });
  const res = (await call(subtitleSet, { id: "s1", mode: "soft", lang: "ja" })) as any;
  expect(res.result.clip.mode).toBe("soft");
  expect(res.result.clip.lang).toBe("ja");
  // 触っていないスタイルは残る
  expect(res.result.clip.style.size).toBe(40);

  const swapped = (await call(subtitleSet, { id: "s1", asset: "styled" })) as any;
  expect(swapped.result.clip.asset).toBe("styled");
  expect(swapped.result.clip.format).toBe("ass");
});

test("同じ値での subtitle set は op を作らない", async () => {
  await call(subtitleAdd, { asset: "ja_srt", mode: "burn" });
  const res = (await call(subtitleSet, { id: "s1", mode: "burn" })) as any;
  expect(res.op).toBeNull();
});

test("テキストクリップの ID を渡すと E_CLIP_NOT_FOUND", async () => {
  await call(subtitleAdd, { asset: "ja_srt" });
  const err = await call(subtitleSet, { id: "nope", mode: "soft" }).catch((e: unknown) => e);
  expect((err as MontashError).code).toBe("E_CLIP_NOT_FOUND");
});

test("subtitle remove はクリップを消し、list は残りを並べる", async () => {
  await call(subtitleAdd, { asset: "ja_srt", mode: "burn" });
  await call(subtitleAdd, { asset: "ja_srt", mode: "soft", lang: "ja" });
  const removed = (await call(subtitleRemove, { id: "s1" })) as any;
  expect(removed.result.removed.id).toBe("s1");

  const listed = (await call(subtitleList, {})) as any;
  expect(listed.result.clips.map((c: { id: string }) => c.id)).toEqual(["s2"]);
  expect(listed.result.clips[0].mode).toBe("soft");
  expect(listed.result.clips[0].lang).toBe("ja");
  expect(listed.op).toBeUndefined();
});

test("--dry-run は書き込まずに差分だけを返す", async () => {
  const res = (await call(subtitleAdd, { asset: "ja_srt" }, { dryRun: true })) as any;
  expect(res.result.dry_run).toBe(true);
  expect(res.op).toBeNull();
  expect((await clipsOf()).length).toBe(0);
});
