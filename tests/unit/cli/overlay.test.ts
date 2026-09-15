/**
 * `overlay add|set|remove|list` のハンドラを直接呼ぶテスト（docs/04 §10、W-08）。
 * yargs を通さないので、オプション名は yargs が渡す camelCase で与える。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlayAdd, overlayList, overlayRemove, overlaySet } from "../../../src/cli/commands/overlay.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { AssetSchema } from "../../../src/core/schema.ts";
import { validateProject } from "../../../src/core/validate.ts";

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

function ctx(over: Partial<GlobalOptions> = {}) {
  return createContext(globals({ project: dir, ...over }), {
    cwd: dir,
    env: { MONTASH_ACTOR: "ai" },
    isTTY: false,
    argv: ["test"],
  });
}

/** ハンドラは各コマンド固有の Args 型を持つので、ここでは緩い形で渡す */
// biome-ignore lint/suspicious/noExplicitAny: yargs が渡す argv を模す
type Args = Record<string, any>;

const call = (spec: { handler: (c: never, a: never) => unknown }, args: Args, over?: Partial<GlobalOptions>) =>
  spec.handler(ctx(over) as never, args as never) as Promise<CommandResult>;

/** 30fps・V1/A1、映像 a（5 秒）・画像 logo（256x128）を持つプロジェクト */
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-overlay-"));
  const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = AssetSchema.parse({
    id: "a",
    path: "a.mp4",
    type: "video",
    duration_s: 5,
    duration_f: 150,
    video: { codec: "h264", width: 640, height: 360, fps: { num: 30, den: 1 } },
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
  });
  project.assets.logo = AssetSchema.parse({
    id: "logo",
    path: "logo.png",
    type: "image",
    duration_s: null,
    duration_f: null,
    video: { codec: "png", width: 256, height: 128, pix_fmt: "rgba", has_alpha: true },
  });
  project.assets.note = AssetSchema.parse({ id: "note", path: "note.txt", type: "text" });
  // V1 に 60 フレームのベースクリップを置く（タイムライン尺 = 60）
  project.tracks[0]!.clips.push({
    id: "c1",
    type: "media",
    asset: "a",
    start_f: 0,
    in_f: 0,
    out_f: 60,
    speed: 1,
    pitch_keep: false,
    loop: false,
    link: null,
    video: {
      opacity: 1,
      transform: null,
      crop: null,
      color: null,
      lut: null,
      keep_alpha: false,
      fade: { in_f: 0, out_f: 0, color: "black" },
    },
    effects: [],
  });
  await initProjectDir(dir, project);
  await recordInitialOp(dir, project, ctx());
}

// biome-ignore lint/suspicious/noExplicitAny: result はコマンドごとに形が違う
const res = (r: CommandResult) => r.result as any;

describe("overlay add", () => {
  beforeEach(setup);

  test("creates the target track and writes video.transform", async () => {
    const r = await call(overlayAdd, {
      asset: "logo",
      track: "V2",
      at: "f:0",
      duration: "timeline",
      position: "top-right",
      margin: "24",
      scale: "0.12",
      opacity: 0.9,
    });
    expect(res(r).track_added).toBe("V2");
    expect(res(r).overlay).toMatchObject({
      track: "V2",
      asset: "logo",
      start_f: 0,
      end_f: 60,
      opacity: 0.9,
      transform: { position: "top-right", margin: 24, scale: 0.12, x: null, y: null },
    });
    const project = await loadProject(dir);
    // 合成順で V1 の 1 つ上（配列の後ろ側）に入る
    expect(project.tracks.map((t) => t.id)).toEqual(["V1", "V2", "A1"]);
    expect(validateProject(project).errors).toEqual([]);
  });

  test("without --track it uses the next video track above the top one", async () => {
    const r = await call(overlayAdd, { asset: "logo", duration: "f:30" });
    expect(res(r).overlay.track).toBe("V2");
    expect(res(r).track_added).toBe("V2");
    const r2 = await call(overlayAdd, { asset: "logo", at: "f:0", duration: "f:30" });
    expect(res(r2).overlay.track).toBe("V3");
  });

  test("an image without --duration falls back to default_image_duration_f", async () => {
    const project = await loadProject(dir);
    const r = await call(overlayAdd, { asset: "logo", track: "V2" });
    expect(res(r).overlay.duration_f).toBe(project.settings.default_image_duration_f);
  });

  test("--until is the timeline position to stop at", async () => {
    const r = await call(overlayAdd, { asset: "logo", track: "V2", at: "f:10", until: "f:40" });
    expect(res(r).overlay).toMatchObject({ start_f: 10, end_f: 40, duration_f: 30 });
  });

  test("x,y and percent coordinates clear the preset", async () => {
    const r = await call(overlayAdd, { asset: "logo", track: "V2", duration: "f:30", position: "12,34" });
    expect(res(r).overlay.transform).toMatchObject({ position: null, x: 12, y: 34 });
    const r2 = await call(overlayAdd, { asset: "logo", track: "V3", duration: "f:30", position: "10%,75%" });
    expect(res(r2).overlay.transform).toMatchObject({ position: null, x: "10%", y: "75%" });
  });

  test("--scale accepts a box and folds it into a ratio", async () => {
    // 256x128 を 128x128 に収める → min(128/256, 128/128) = 0.5
    const r = await call(overlayAdd, { asset: "logo", track: "V2", duration: "f:30", scale: "128x128" });
    expect(res(r).overlay.transform.scale).toBe(0.5);
  });

  test("fades and keep-alpha land on the video block", async () => {
    const r = await call(overlayAdd, {
      asset: "logo",
      track: "V2",
      duration: "f:30",
      fadeIn: "f:5",
      fadeOut: "f:6",
      keepAlpha: true,
    });
    expect(res(r).overlay.fade).toMatchObject({ in_f: 5, out_f: 6 });
    expect(res(r).overlay.keep_alpha).toBe(true);
  });

  test("rejects unknown presets, bad opacity, text assets and overlaps", async () => {
    await expect(
      call(overlayAdd, { asset: "logo", track: "V2", duration: "f:30", position: "nowhere" }),
    ).rejects.toThrow(/unknown position preset/);
    await expect(call(overlayAdd, { asset: "logo", track: "V2", duration: "f:30", opacity: 2 })).rejects.toThrow(
      /--opacity/,
    );
    await expect(call(overlayAdd, { asset: "note", track: "V2", duration: "f:30" })).rejects.toMatchObject({
      code: "E_ASSET_TYPE_MISMATCH",
    });
    await expect(call(overlayAdd, { asset: "logo", track: "A1", duration: "f:30" })).rejects.toThrow(
      /incompatible kind/,
    );
    await call(overlayAdd, { asset: "logo", track: "V2", at: "f:0", duration: "f:30" });
    await expect(call(overlayAdd, { asset: "logo", track: "V2", at: "f:10", duration: "f:30" })).rejects.toMatchObject({
      code: "E_CLIP_OVERLAP",
    });
  });

  test("--duration and --until are mutually exclusive", async () => {
    await expect(call(overlayAdd, { asset: "logo", duration: "f:30", until: "f:30" })).rejects.toBeInstanceOf(
      MontashError,
    );
  });
});

describe("overlay set / remove / list", () => {
  beforeEach(async () => {
    await setup();
    await call(overlayAdd, {
      asset: "logo",
      track: "V2",
      at: "f:0",
      duration: "f:30",
      position: "top-right",
      scale: "0.12",
    });
  });

  test("set changes only the requested style fields", async () => {
    const r = await call(overlaySet, { id: "c2", position: "bottom-right", margin: "16", opacity: 0.5 });
    expect(res(r).overlay.transform).toMatchObject({ position: "bottom-right", margin: 16, scale: 0.12 });
    expect(res(r).overlay.opacity).toBe(0.5);
  });

  test("set requires at least one option and refuses non-overlay clips", async () => {
    await expect(call(overlaySet, { id: "c2" })).rejects.toThrow(/specify at least one/);
    await expect(call(overlaySet, { id: "c1", opacity: 0.5 })).rejects.toMatchObject({ code: "E_CLIP_NOT_FOUND" });
  });

  test("list returns the overlays with their transforms", async () => {
    const r = await call(overlayList, {});
    expect(res(r).overlays).toHaveLength(1);
    expect(res(r).overlays[0]).toMatchObject({ id: "c2", track: "V2", asset: "logo" });
    // ベースクリップ（transform 無し）は出てこない
    expect(res(r).overlays.map((o: { id: string }) => o.id)).not.toContain("c1");
  });

  test("remove drops the clip and leaves the track", async () => {
    const r = await call(overlayRemove, { id: "c2" });
    expect(res(r).removed).toBe("c2");
    const project = await loadProject(dir);
    expect(project.tracks.find((t) => t.id === "V2")!.clips).toEqual([]);
    expect((await call(overlayList, {})).result).toMatchObject({ overlays: [] });
  });
});
