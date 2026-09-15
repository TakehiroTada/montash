/**
 * `text add|set|remove|list|presets` のハンドラを直接呼ぶテスト
 * （tests/unit/cli/clip-edit.test.ts と同じ書き方。yargs を通さないので camelCase で渡す）。
 */
import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setFontCache, textAdd, textList, textPresets, textRemove, textSet } from "../../../src/cli/commands/text.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { AssetSchema, isTextClip, type TextClip } from "../../../src/core/schema.ts";
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
  { family: "Helvetica Neue", style: "Regular", path: "/System/Library/Fonts/HelveticaNeue.ttc", cjk: false },
];

/** 29.97fps / 1920x1080 のプロジェクト（W-06 の例に合わせる） */
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-text-"));
  const project = createProject({
    name: "t",
    fps: { num: 30000, den: 1001 },
    resolution: { width: 1920, height: 1080 },
  });
  project.assets.title_main = AssetSchema.parse({
    id: "title_main",
    type: "text",
    path: "assets/text/title_main.txt",
    owned: true,
    text_preview: "Summer Trip 2026",
    line_count: 1,
  });
  project.assets.a = AssetSchema.parse({
    id: "a",
    type: "video",
    path: "a.mp4",
    duration_s: 5,
    duration_f: 150,
    video: { codec: "h264", width: 1920, height: 1080 },
  });
  await initProjectDir(dir, project, { force: true });
  await mkdir(join(dir, "assets", "text"), { recursive: true });
  await writeFile(join(dir, "assets", "text", "title_main.txt"), "Summer Trip 2026\n", "utf8");
  await recordInitialOp(dir, project, ctx(["init"]));
}

beforeEach(async () => {
  __setFontCache(FONTS);
  await setup();
});

const clipsOf = async (): Promise<TextClip[]> =>
  (await loadProject(dir)).tracks.flatMap((t) => t.clips.filter(isTextClip));

// ---------------------------------------------------------------------------
// text add
// ---------------------------------------------------------------------------

test("text add はテキストトラックが無ければ T1 を自動作成する", async () => {
  const res = (await call(textAdd, { text: "Summer Trip 2026", at: "f:0", duration: "f:90" })) as any;
  expect(res.result.track_created).toBe("T1");
  const project = await loadProject(dir);
  expect(project.tracks.map((t) => t.id)).toEqual(["V1", "A1", "T1"]);
  expect(project.tracks[2]?.kind).toBe("text");
  expect(res.result.clip.id).toBe("x1");
  expect(res.op).toBeTruthy();

  // 2 本目は既存の T1 に載る
  const second = (await call(textAdd, { text: "second", at: "f:120", duration: "f:30" })) as any;
  expect(second.result.track_created).toBeNull();
  expect(second.result.clip.id).toBe("x2");
  expect((await clipsOf()).map((c) => c.id)).toEqual(["x1", "x2"]);
});

test("プリセットがスタイルとフェードの土台になる", async () => {
  await call(textAdd, {
    text: "Summer Trip 2026",
    at: "f:0",
    duration: "f:90",
    preset: "title-center",
    fadeIn: "f:15",
    fadeOut: "f:15",
  });
  const [clip] = await clipsOf();
  expect(clip?.style.preset).toBe("title-center");
  expect(clip?.style.size).toBe(96);
  expect(clip?.style.position).toBe("center");
  expect(clip?.style.outline).toEqual({ width: 2, color: "#000000" });
  expect(clip?.fade).toEqual({ in_f: 15, out_f: 15 });
});

test("明示オプションはプリセットを上書きする", async () => {
  await call(textAdd, {
    text: "福岡到着",
    at: "f:360",
    duration: "f:90",
    preset: "lower-third",
    size: 60,
    color: "#FFEE00",
    bg: "none",
    position: "5%,85%",
    align: "left",
    shadow: "2,2,#000000AA",
    outline: "3,#000000",
    bold: true,
    wrap: false,
    markup: "ass",
  });
  const [clip] = await clipsOf();
  expect(clip?.style.size).toBe(60);
  expect(clip?.style.color).toBe("#FFEE00");
  expect(clip?.style.bg).toBeNull();
  expect(clip?.style.position).toEqual({ x: "5%", y: "85%" });
  expect(clip?.style.shadow).toEqual({ x: 2, y: 2, color: "#000000AA" });
  expect(clip?.style.outline).toEqual({ width: 3, color: "#000000" });
  expect(clip?.style.bold).toBe(true);
  expect(clip?.style.wrap).toBe(false);
  expect(clip?.markup).toBe("ass");
});

test("--position は px でもプリセット名でも指定できる", async () => {
  await call(textAdd, { text: "a", at: "f:0", duration: "f:30", position: "960,540" });
  await call(textAdd, { text: "b", at: "f:30", duration: "f:30", position: "bottom-center" });
  const clips = await clipsOf();
  expect(clips[0]?.style.position).toEqual({ x: 960, y: 540 });
  expect(clips[1]?.style.position).toBe("bottom-center");
  await expect(call(textAdd, { text: "c", at: "f:60", duration: "f:30", position: "nope" })).rejects.toThrow(
    /invalid position/,
  );
});

test("--font 未指定なら default_font → CJK 対応フォントの順に解決する", async () => {
  // 既定の "Noto Sans CJK JP" はこの環境に無いので CJK フォールバックが選ばれる
  await call(textAdd, { text: "日本語", at: "f:0", duration: "f:30" });
  expect((await clipsOf())[0]?.style.font).toBe("Hiragino Sans");
});

test("未検出のフォントは E_FONT_NOT_FOUND（hint に候補）", async () => {
  const err = await call(textAdd, { text: "a", at: "f:0", duration: "f:30", font: "Helvetika" }).catch((e) => e);
  expect(err).toBeInstanceOf(MontashError);
  expect((err as MontashError).code).toBe("E_FONT_NOT_FOUND");
  expect((err as MontashError).detail?.candidates).toContain("Helvetica");
  // 失敗したコマンドは何も書かない
  expect(await clipsOf()).toHaveLength(0);
});

test("--asset はテキスト素材を参照する（本文はレンダー時に読む）", async () => {
  const res = (await call(textAdd, { asset: "title_main", at: "f:0", duration: "f:90" })) as any;
  expect(res.result.clip.asset).toBe("title_main");
  expect(res.result.clip.text).toBe("");

  const err = await call(textAdd, { asset: "a", at: "f:120", duration: "f:30" }).catch((e) => e);
  expect((err as MontashError).code).toBe("E_ASSET_TYPE_MISMATCH");
});

test("--text-file はファイルから本文を読む。--text の \\n は改行になる", async () => {
  await writeFile(join(dir, "body.txt"), "1 行目\n2 行目\n", "utf8");
  const res = (await call(textAdd, { "text-file": "body.txt", at: "f:0", duration: "f:30" })) as any;
  expect(res.result.clip.text).toBe("1 行目\n2 行目\n");

  await call(textAdd, { text: "a\\nb", at: "f:60", duration: "f:30" });
  expect((await clipsOf())[1]?.text).toBe("a\nb");

  await expect(call(textAdd, { "text-file": "missing.txt", at: "f:120", duration: "f:30" })).rejects.toThrow(
    /cannot read/,
  );
});

test("本文の指定は排他で、どれか 1 つは必須", async () => {
  await expect(call(textAdd, { text: "a", asset: "title_main", at: "f:0", duration: "f:30" })).rejects.toThrow(
    /only one of/,
  );
  await expect(call(textAdd, { at: "f:0", duration: "f:30" })).rejects.toThrow(/--text, --text-file or --asset/);
});

test("秒指定はフレームに丸めて W_SNAPPED を返す（29.97fps）", async () => {
  const res = (await call(textAdd, { text: "a", at: "12", duration: "3" })) as any;
  expect(res.result.clip.start_f).toBe(360);
  expect(res.result.clip.duration_f).toBe(90);
  expect(res.warnings.map((w: any) => w.code)).toContain("W_SNAPPED");
});

test("--until で終了位置を指定できる。長さ 0 以下は使い方エラー", async () => {
  const res = (await call(textAdd, { text: "a", at: "f:30", until: "f:120" })) as any;
  expect(res.result.clip.duration_f).toBe(90);
  await expect(call(textAdd, { text: "b", at: "f:300", until: "f:200" })).rejects.toThrow(/would last/);
  await expect(call(textAdd, { text: "b", at: "f:300", duration: "f:30", until: "f:400" })).rejects.toThrow(
    /--duration or --until/,
  );
});

test("--at 省略はトラック末尾、重なりは E_CLIP_OVERLAP", async () => {
  await call(textAdd, { text: "a", at: "f:0", duration: "f:30" });
  const appended = (await call(textAdd, { text: "b", duration: "f:30" })) as any;
  expect(appended.result.clip.start_f).toBe(30);
  const err = await call(textAdd, { text: "c", at: "f:10", duration: "f:30" }).catch((e) => e);
  expect((err as MontashError).code).toBe("E_CLIP_OVERLAP");
});

test("--dry-run は何も書かない", async () => {
  const res = (await call(textAdd, { text: "a", at: "f:0", duration: "f:30" }, { dryRun: true })) as any;
  expect(res.result.dry_run).toBe(true);
  expect(res.op).toBeNull();
  expect(await clipsOf()).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// text set / remove
// ---------------------------------------------------------------------------

test("text set は指定した項目だけを変える", async () => {
  await call(textAdd, { text: "福岡到着", at: "f:360", duration: "f:90", preset: "lower-third" });
  const res = (await call(textSet, { id: "x1", text: "福岡に到着", position: "5%,85%" })) as any;
  expect(res.result.clip.text).toBe("福岡に到着");
  const [clip] = await clipsOf();
  expect(clip?.style.position).toEqual({ x: "5%", y: "85%" });
  // 触っていない項目は保たれる
  expect(clip?.style.size).toBe(48);
  expect(clip?.style.bg).toBe("#00000099");
  expect(clip?.start_f).toBe(360);
  expect(clip?.duration_f).toBe(90);
});

test("text set は位置・長さ・プリセットも変えられる", async () => {
  await call(textAdd, { text: "a", at: "f:0", duration: "f:30" });
  await call(textSet, { id: "x1", at: "f:60", duration: "f:45", preset: "caption-bottom" });
  const [clip] = await clipsOf();
  expect(clip?.start_f).toBe(60);
  expect(clip?.duration_f).toBe(45);
  expect(clip?.style.preset).toBe("caption-bottom");
  expect(clip?.style.size).toBe(40);
});

test("text set は自分自身と重なったとみなさない", async () => {
  await call(textAdd, { text: "a", at: "f:0", duration: "f:30" });
  await call(textAdd, { text: "b", at: "f:60", duration: "f:30" });
  await expect(call(textSet, { id: "x1", text: "a2" })).resolves.toBeTruthy();
  const err = await call(textSet, { id: "x1", at: "f:50", duration: "f:30" }).catch((e) => e);
  expect((err as MontashError).code).toBe("E_CLIP_OVERLAP");
});

test("text set は --asset でも本文を差し替えられる", async () => {
  await call(textAdd, { text: "inline", at: "f:0", duration: "f:30" });
  await call(textSet, { id: "x1", asset: "title_main" });
  expect((await clipsOf())[0]?.asset).toBe("title_main");
  await call(textSet, { id: "x1", text: "inline again" });
  expect((await clipsOf())[0]?.asset).toBeNull();
});

test("知らない ID は E_CLIP_NOT_FOUND", async () => {
  const err = await call(textSet, { id: "x9", text: "a" }).catch((e) => e);
  expect((err as MontashError).code).toBe("E_CLIP_NOT_FOUND");
});

test("text remove はクリップを消す", async () => {
  await call(textAdd, { text: "a", at: "f:0", duration: "f:30" });
  await call(textAdd, { text: "b", at: "f:60", duration: "f:30" });
  const res = (await call(textRemove, { id: "x1" })) as any;
  expect(res.result.removed.id).toBe("x1");
  expect((await clipsOf()).map((c) => c.id)).toEqual(["x2"]);
});

// ---------------------------------------------------------------------------
// text list / presets
// ---------------------------------------------------------------------------

test("text list はタイムライン順に並べる", async () => {
  await call(textAdd, { text: "b", at: "f:60", duration: "f:30" });
  await call(textAdd, { text: "a", at: "f:0", duration: "f:30" });
  const res = (await call(textList)) as any;
  expect(res.result.clips.map((c: any) => c.id)).toEqual(["x2", "x1"]);
  expect(res.result.clips[0]).toMatchObject({ track: "T1", start_f: 0, end_f: 30 });
  expect(res.op).toBeUndefined();
});

test("text presets は組み込みとプロジェクト定義を返す", async () => {
  const project = await loadProject(dir);
  project.text_presets = { "title-center": { size: 120 }, "brand-tag": { size: 24, position: "bottom-left" } };
  await Bun.write(join(dir, "project.json"), `${JSON.stringify(project, null, 2)}\n`);

  const res = (await call(textPresets)) as any;
  const byName = Object.fromEntries(res.result.presets.map((p: any) => [p.name, p]));
  expect(Object.keys(byName).sort()).toEqual([
    "brand-tag",
    "caption-bottom",
    "corner-tag",
    "lower-third",
    "title-center",
  ]);
  expect(byName["title-center"].source).toBe("overridden");
  expect(byName["title-center"].preset.size).toBe(120);
  // 上書きされていない項目は組み込みのまま
  expect(byName["title-center"].preset.position).toBe("center");
  expect(byName["brand-tag"].source).toBe("project");
  expect(byName["caption-bottom"].source).toBe("builtin");

  await call(textAdd, { text: "a", at: "f:0", duration: "f:30", preset: "brand-tag" });
  expect((await clipsOf())[0]?.style.size).toBe(24);
  await expect(call(textAdd, { text: "b", at: "f:60", duration: "f:30", preset: "nope" })).rejects.toThrow(/not found/);
});
