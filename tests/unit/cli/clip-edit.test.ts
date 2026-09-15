/**
 * クリップ編集コマンドのハンドラを直接呼ぶテスト（tests/unit/cli/mutate.test.ts と同じ書き方）。
 * yargs を通さないので、オプション名は yargs が渡す camelCase で与える。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipAdd } from "../../../src/cli/commands/clip.ts";
import { clipDelete, clipMove, clipSet, clipSplit, clipTrim } from "../../../src/cli/commands/clip-edit.ts";
import { timelineGaps } from "../../../src/cli/commands/timeline.ts";
import { trackAdd, trackList, trackLock, trackMove, trackMute, trackRemove } from "../../../src/cli/commands/track.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { timelineDurationF } from "../../../src/core/assets.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { AssetSchema, clipDurationF } from "../../../src/core/schema.ts";
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

function ctx(argv: string[], over: Partial<GlobalOptions> = {}) {
  return createContext(globals({ project: dir, ...over }), {
    cwd: dir,
    env: { MONTASH_ACTOR: "ai" },
    isTTY: false,
    argv,
  });
}

/** ハンドラは各コマンド固有の Args 型を持つので、ここでは緩い形で渡す */
type Args = Record<string, any>;

const call = (spec: { handler: (c: never, a: never) => unknown }, args: Args, over?: Partial<GlobalOptions>) =>
  spec.handler(ctx(["test"], over) as never, args as never) as Promise<CommandResult>;

/** 30fps・V1/A1・アセット a（5 秒、音声あり）のプロジェクトを作る */
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-clipedit-"));
  const project = createProject({
    name: "t",
    fps: { num: 30, den: 1 },
    resolution: { width: 640, height: 360 },
  });
  project.assets.a = AssetSchema.parse({
    id: "a",
    path: "a.mp4",
    type: "video",
    duration_s: 5,
    duration_f: 150,
    video: { codec: "h264", width: 640, height: 360, fps: { num: 30, den: 1 } },
    audio: { codec: "aac", sample_rate: 48000, channels: 2 },
  });
  project.assets.bgm = AssetSchema.parse({
    id: "bgm",
    path: "bgm.wav",
    type: "audio",
    duration_s: 10,
    duration_f: 300,
    audio: { codec: "pcm_s16le", sample_rate: 48000, channels: 2 },
  });
  await initProjectDir(dir, project, { force: true });
  await recordInitialOp(dir, project, ctx(["init"]));
}

/** V1/A1 に 30 フレームずつ 3 組並べる */
async function threeCuts() {
  for (const at of [0, 1, 2]) {
    await call(clipAdd, { asset: "a", in: String(at), out: String(at + 1), at: "end" });
  }
}

const layout = async () => {
  const project = await loadProject(dir);
  return project.tracks.map((t) => ({
    id: t.id,
    clips: t.clips.map((c) => `${c.id}@${c.start_f}`),
  }));
};

beforeEach(setup);

describe("clip trim", () => {
  test("--in +0.5 --ripple は 15f 縮めて後続を全トラックで詰める", async () => {
    await threeCuts();
    const res = await call(clipTrim, { id: "c1", in: "+0.5", ripple: "" });
    const result = res.result as { delta_f: number; clip: { end_f: number }; linked_clip: { id: string } };
    expect(result.delta_f).toBe(-15);
    expect(result.clip.end_f).toBe(15);
    expect(result.linked_clip.id).toBe("c2");
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c1@0", "c3@15", "c5@45"] },
      { id: "A1", clips: ["c2@0", "c4@15", "c6@45"] },
    ]);
    expect(timelineDurationF(await loadProject(dir))).toBe(75);
  });

  test("--ripple 無しは start_f を保ち W_GAP_CREATED を返す", async () => {
    await threeCuts();
    const res = await call(clipTrim, { id: "c1", in: "+f:15" });
    expect(res.warnings?.map((w) => w.code)).toContain("W_GAP_CREATED");
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c1@0", "c3@30", "c5@60"] },
      { id: "A1", clips: ["c2@0", "c4@30", "c6@60"] },
    ]);
  });

  test("尺が 1 フレーム未満になると E_TRIM_EXCEEDS_CLIP で何も書かない", async () => {
    await threeCuts();
    await expect(call(clipTrim, { id: "c1", in: "+f:30" })).rejects.toMatchObject({ code: "E_TRIM_EXCEEDS_CLIP" });
    expect(timelineDurationF(await loadProject(dir))).toBe(90);
  });

  test("ソース外へのトリムは E_RANGE_OUT_OF_ASSET", async () => {
    await threeCuts();
    await expect(call(clipTrim, { id: "c5", out: "+f:120" })).rejects.toMatchObject({ code: "E_RANGE_OUT_OF_ASSET" });
  });

  test("--unlink は映像だけを縮め、リンクを外す", async () => {
    await threeCuts();
    const res = await call(clipTrim, { id: "c1", out: "-f:10", unlink: true, ripple: "track" });
    expect((res.result as { linked_clip: unknown }).linked_clip).toBeNull();
    const project = await loadProject(dir);
    expect(validateProject(project).ok).toBe(true);
    expect(project.tracks[0]!.clips[0]).toMatchObject({ id: "c1", link: null, out_f: 20 });
  });

  test("引数が無ければ E_USAGE", async () => {
    await threeCuts();
    await expect(call(clipTrim, { id: "c1" })).rejects.toMatchObject({ code: "E_USAGE" });
  });
});

describe("clip move", () => {
  test("--before --ripple で順序を入れ替える", async () => {
    await threeCuts();
    await call(clipMove, { id: "c5", before: "c3", ripple: "" });
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c1@0", "c5@30", "c3@60"] },
      { id: "A1", clips: ["c2@0", "c6@30", "c4@60"] },
    ]);
    expect(validateProject(await loadProject(dir)).ok).toBe(true);
  });

  test("--by は符号付きオフセットだけ受け付ける", async () => {
    await threeCuts();
    await expect(call(clipMove, { id: "c5", by: "f:10" })).rejects.toMatchObject({ code: "E_USAGE" });
    const res = await call(clipMove, { id: "c5", by: "+f:10" });
    expect((res.result as { clip: { start_f: number } }).clip.start_f).toBe(70);
  });

  test("既定の --on-overlap error は E_CLIP_OVERLAP", async () => {
    await threeCuts();
    await expect(call(clipMove, { id: "c5", to: "f:0" })).rejects.toMatchObject({ code: "E_CLIP_OVERLAP" });
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c1@0", "c3@30", "c5@60"] },
      { id: "A1", clips: ["c2@0", "c4@30", "c6@60"] },
    ]);
  });

  test("--on-overlap push は移動先以降を押し出す", async () => {
    await threeCuts();
    await call(clipMove, { id: "c5", to: "f:0", onOverlap: "push" });
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c5@0", "c1@30", "c3@60"] },
      { id: "A1", clips: ["c6@0", "c2@30", "c4@60"] },
    ]);
  });

  test("--on-overlap overwrite は重なった分を既存クリップから削る", async () => {
    await threeCuts();
    await call(clipMove, { id: "c5", to: "f:15", onOverlap: "overwrite" });
    const project = await loadProject(dir);
    expect(project.tracks[0]!.clips.map((c) => `${c.id}@${c.start_f}+${clipDurationF(c)}`)).toEqual([
      "c1@0+15",
      "c5@15+30",
      "c3@45+15",
    ]);
    expect(validateProject(project).ok).toBe(true);
  });

  test("別トラックへ動かすとリンク音声も対応トラックへ移る", async () => {
    await threeCuts();
    await call(trackAdd, { kind: "video", name: "V2" });
    await call(trackAdd, { kind: "audio", name: "A2" });
    await call(clipMove, { id: "c1", track: "V2" });
    const project = await loadProject(dir);
    expect(project.tracks.find((t) => t.id === "V2")?.clips.map((c) => c.id)).toEqual(["c1"]);
    expect(project.tracks.find((t) => t.id === "A2")?.clips.map((c) => c.id)).toEqual(["c2"]);
    expect(validateProject(project).ok).toBe(true);
  });

  test("種別の違うトラックへは動かせない", async () => {
    await threeCuts();
    await call(trackAdd, { kind: "text", name: "T1" });
    await expect(call(clipMove, { id: "c1", track: "T1" })).rejects.toBeInstanceOf(MontashError);
  });
});

describe("clip split", () => {
  test("前半は元 ID、後半は新 ID（ADR-12）。リンク音声も前後で結び直す", async () => {
    await threeCuts();
    const res = await call(clipSplit, { id: "c1", at: "f:15" });
    const result = res.result as {
      kept: { id: string; start_f: number; end_f: number };
      created: { id: string; start_f: number; end_f: number };
      linked: { kept: string; created: string };
    };
    expect(result.kept).toMatchObject({ id: "c1", start_f: 0, end_f: 15 });
    expect(result.created.id).not.toBe("c1");
    expect(result.created).toMatchObject({ start_f: 15, end_f: 30 });
    expect(result.linked.kept).toBe("c2");
    const project = await loadProject(dir);
    expect(validateProject(project).ok).toBe(true);
    expect(timelineDurationF(project)).toBe(90);
  });

  test("--new-id を尊重し、既存 ID なら E_ID_EXISTS", async () => {
    await threeCuts();
    await expect(call(clipSplit, { id: "c1", at: "f:15", newId: "c3" })).rejects.toMatchObject({
      code: "E_ID_EXISTS",
    });
    const res = await call(clipSplit, { id: "c1", at: "f:15", newId: "c99" });
    expect((res.result as { created: { id: string } }).created.id).toBe("c99");
  });

  test("端での分割は E_SPLIT_AT_EDGE", async () => {
    await threeCuts();
    await expect(call(clipSplit, { id: "c1", at: "f:0" })).rejects.toMatchObject({ code: "E_SPLIT_AT_EDGE" });
    await expect(call(clipSplit, { id: "c1", at: "f:30" })).rejects.toMatchObject({ code: "E_SPLIT_AT_EDGE" });
  });

  test("--dry-run は ID カウンタもプロジェクトも進めない", async () => {
    await threeCuts();
    const before = await Bun.file(join(dir, ".montash/ids.json")).text();
    const res = await call(clipSplit, { id: "c1", at: "f:15" }, { dryRun: true });
    expect(res.op).toBeNull();
    expect(await Bun.file(join(dir, ".montash/ids.json")).text()).toBe(before);
    expect((await loadProject(dir)).tracks[0]!.clips).toHaveLength(3);
  });
});

describe("clip delete", () => {
  test("--ripple は削除区間以降を全トラックで詰める", async () => {
    await threeCuts();
    const res = await call(clipDelete, { ids: ["c3"], ripple: "" });
    expect((res.result as { deleted: string[] }).deleted.sort()).toEqual(["c3", "c4"]);
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c1@0", "c5@30"] },
      { id: "A1", clips: ["c2@0", "c6@30"] },
    ]);
    expect(timelineDurationF(await loadProject(dir))).toBe(60);
  });

  test("--ripple 無しはギャップが残る", async () => {
    await threeCuts();
    await call(clipDelete, { ids: ["c3"] });
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c1@0", "c5@60"] },
      { id: "A1", clips: ["c2@0", "c6@60"] },
    ]);
  });

  test("複数 ID をまとめて消せる", async () => {
    await threeCuts();
    await call(clipDelete, { ids: ["c1", "c5"], ripple: "" });
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c3@0"] },
      { id: "A1", clips: ["c4@0"] },
    ]);
  });

  test("跨いでいる BGM は尺が縮む", async () => {
    await threeCuts();
    await call(trackAdd, { kind: "audio", name: "A2" });
    await call(clipAdd, { asset: "bgm", track: "A2", at: "f:0", duration: "f:90" });
    await call(clipDelete, { ids: ["c3"], ripple: "" });
    const project = await loadProject(dir);
    const bgm = project.tracks.find((t) => t.id === "A2")!.clips[0]!;
    expect(bgm.start_f).toBe(0);
    expect(bgm.out_f).toBe(60);
    expect(validateProject(project).ok).toBe(true);
  });
});

describe("clip set", () => {
  test("label / volume / opacity はリンク相手の該当ブロックに書く", async () => {
    await threeCuts();
    await call(clipSet, { id: "c1", label: "opening", volume: -6, opacity: 0.5 });
    const project = await loadProject(dir);
    expect(project.tracks[0]!.clips[0]).toMatchObject({ label: "opening" });
    expect((project.tracks[0]!.clips[0] as { video: { opacity: number } }).video.opacity).toBe(0.5);
    expect((project.tracks[1]!.clips[0] as { audio: { gain_db: number } }).audio.gain_db).toBe(-6);
  });

  test("--speed は尺を変え、--ripple で後続を詰める", async () => {
    await threeCuts();
    await call(clipSet, { id: "c1", speed: 2, ripple: "" });
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c1@0", "c3@15", "c5@45"] },
      { id: "A1", clips: ["c2@0", "c4@15", "c6@45"] },
    ]);
    expect(timelineDurationF(await loadProject(dir))).toBe(75);
  });

  test("不正な値と空の指定は E_USAGE", async () => {
    await threeCuts();
    await expect(call(clipSet, { id: "c1" })).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(call(clipSet, { id: "c1", speed: 0 })).rejects.toMatchObject({ code: "E_USAGE" });
    await expect(call(clipSet, { id: "c1", opacity: 2 })).rejects.toMatchObject({ code: "E_USAGE" });
  });
});

describe("track", () => {
  test("add は種別ごとの連番、--above/--below で位置を決める", async () => {
    const added = await call(trackAdd, { kind: "video" });
    expect((added.result as { track: { id: string } }).track.id).toBe("V2");
    await call(trackAdd, { kind: "text", below: "V1" });
    const list = await call(trackList, {});
    expect((list.result as { tracks: Array<{ id: string }> }).tracks.map((t) => t.id)).toEqual([
      "T1",
      "V1",
      "V2",
      "A1",
    ]);
    expect((list.result as { tracks: Array<{ kind: string }> }).tracks[1]!.kind).toBe("video");
  });

  test("重複した名前は E_ID_EXISTS", async () => {
    await expect(call(trackAdd, { kind: "video", name: "V1" })).rejects.toMatchObject({ code: "E_ID_EXISTS" });
  });

  test("mute / lock は --off で戻せる。lock 中の編集は E_TRACK_LOCKED", async () => {
    await threeCuts();
    await call(trackMute, { name: "A1" });
    expect((await loadProject(dir)).tracks[1]!.muted).toBe(true);
    await call(trackMute, { name: "A1", off: true });
    expect((await loadProject(dir)).tracks[1]!.muted).toBe(false);
    await call(trackLock, { name: "V1" });
    await expect(call(clipTrim, { id: "c1", in: "+f:5" })).rejects.toMatchObject({ code: "E_TRACK_LOCKED" });
    await call(trackLock, { name: "V1", off: true });
    await call(clipTrim, { id: "c1", in: "+f:5" });
  });

  test("locked トラックは全トラックリップルの対象外（ADR-16）", async () => {
    await threeCuts();
    await call(trackAdd, { kind: "audio", name: "A2" });
    await call(clipAdd, { asset: "bgm", track: "A2", at: "f:0", duration: "f:90" });
    await call(trackLock, { name: "A2" });
    await call(clipDelete, { ids: ["c3"], ripple: "" });
    const project = await loadProject(dir);
    expect(project.tracks.find((t) => t.id === "A2")!.clips[0]!.out_f).toBe(90);
  });

  test("remove はクリップがあると --force が要る", async () => {
    await threeCuts();
    await expect(call(trackRemove, { name: "V1" })).rejects.toMatchObject({ code: "E_USAGE" });
    const res = await call(trackRemove, { name: "V1", force: true });
    expect((res.result as { removed_clips: string[] }).removed_clips.sort()).toEqual(["c1", "c3", "c5"]);
    const project = await loadProject(dir);
    expect(project.tracks.map((t) => t.id)).toEqual(["A1"]);
    expect(validateProject(project).ok).toBe(true);
  });

  test("move は合成順を並べ替える", async () => {
    await call(trackAdd, { kind: "video", name: "V2" });
    const res = await call(trackMove, { name: "V2", below: "V1" });
    expect((res.result as { tracks: string[] }).tracks).toEqual(["V2", "V1", "A1"]);
    await expect(call(trackMove, { name: "V2" })).rejects.toMatchObject({ code: "E_USAGE" });
  });
});

describe("timeline gaps", () => {
  test("ギャップの列挙は状態を変えない", async () => {
    await threeCuts();
    await call(clipDelete, { ids: ["c3"] });
    const res = await call(timelineGaps, {});
    expect(res.op).toBeNull();
    expect((res.result as { gaps: Array<{ from_f: number; to_f: number }> }).gaps).toMatchObject([
      { from_f: 30, to_f: 60, duration_f: 30 },
    ]);
  });

  test("--fill close は後続を詰める", async () => {
    await threeCuts();
    await call(clipDelete, { ids: ["c3"] });
    await call(timelineGaps, { fill: "close" });
    expect(await layout()).toEqual([
      { id: "V1", clips: ["c1@0", "c5@30"] },
      { id: "A1", clips: ["c2@0", "c6@30"] },
    ]);
  });

  test("--fill black は背景クリップを挿入する", async () => {
    await threeCuts();
    await call(clipDelete, { ids: ["c3"] });
    const res = await call(timelineGaps, { fill: "black" });
    expect((res.result as { gaps: unknown[] }).gaps).toEqual([]);
    const project = await loadProject(dir);
    const filler = project.tracks[0]!.clips.find((c) => "generator" in c);
    expect(filler).toMatchObject({ generator: "color", start_f: 30, duration_f: 30 });
    expect(validateProject(project).ok).toBe(true);
  });

  test("--fill hold は E_NOT_IMPLEMENTED", async () => {
    await threeCuts();
    await expect(call(timelineGaps, { fill: "hold" })).rejects.toMatchObject({ code: "E_NOT_IMPLEMENTED" });
  });
});
