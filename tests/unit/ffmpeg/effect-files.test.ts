/**
 * 外部ファイルを参照するエフェクトと preview のキャッシュ指紋（docs/13 D-19、docs/07 §11.1）。
 *
 * 要点:
 *   1. `lut3d` の LUT ファイルの**中身**を差し替えるとセグメント指紋が変わる（パスは同じまま）
 *   2. 中身が同じでも mtime が違えば別扱い（`preview build --force` なしで作り直される）
 *   3. **外部ファイルを申告しないエフェクトでは指紋が従来どおり**（既存キャッシュを無効化しない）
 *   4. stat は `ffmpeg/` 側だけで行う（`graph/` と `registry/` は純粋なまま）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalHash } from "../../../src/core/history/hash.ts";
import { createProject } from "../../../src/core/project.ts";
import { ClipSchema, type Project, VideoAssetSchema } from "../../../src/core/schema.ts";
import {
  audioExternalFiles,
  fingerprintExternalFiles,
  projectExternalFiles,
  segmentExternalFiles,
} from "../../../src/ffmpeg/effect-files.ts";
import { buildPreviewPlan, previewFingerprint } from "../../../src/ffmpeg/preview.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const LUT = "look.cube";

/**
 * LUT を参照するクリップ 1 本のプロジェクト。ffmpeg は起動しない（`bins` を渡さない
 * `buildPreviewPlan()` は引数を組み立てるだけ）ので、素材は中身のあるダミーで足りる。
 */
async function setup(effects: Array<{ type: string; params?: Record<string, unknown> }>) {
  const dir = await mkdtemp(join(tmpdir(), "montash-effect-files-"));
  dirs.push(dir);
  await writeFile(join(dir, "a.mp4"), "not really a video, but it exists");
  await writeFile(join(dir, LUT), "LUT_3D_SIZE 2\n0 0 0\n1 1 1\n");
  const project = createProject({ name: "lut", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 150 });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 140, effects }),
  );
  return { project, dir };
}

const hashes = async (project: Project, dir: string): Promise<string[]> =>
  (await buildPreviewPlan(project, dir, { height: 90 })).segments.map((s) => s.hash);

const lut3d = () => setup([{ type: "lut3d", params: { file: LUT } }]);
/** 外部ファイルを申告しないエフェクト（従来どおりの指紋になるべきもの） */
const blur = () => setup([{ type: "blur", params: { sigma: 6 } }]);

describe("申告の収集", () => {
  test("lut3d を載せたクリップだけが外部ファイルを申告する", async () => {
    const { project } = await lut3d();
    expect(projectExternalFiles(project)).toEqual([LUT]);
    expect(segmentExternalFiles(project, { from_f: 0, to_f: 140 })).toEqual([LUT]);
    // 映像エフェクトなので音声グラフの材料には入らない
    expect(audioExternalFiles(project)).toEqual([]);
  });

  test("クリップの範囲が重ならないセグメントには載らない", async () => {
    const { project } = await lut3d();
    // クリップは 0..140
    expect(segmentExternalFiles(project, { from_f: 0, to_f: 70 })).toEqual([LUT]);
    expect(segmentExternalFiles(project, { from_f: 140, to_f: 200 })).toEqual([]);
  });

  test("申告しないエフェクトでは 1 件も集まらない", async () => {
    const { project } = await blur();
    expect(projectExternalFiles(project)).toEqual([]);
    expect(segmentExternalFiles(project, { from_f: 0, to_f: 140 })).toEqual([]);
    expect(audioExternalFiles(project)).toEqual([]);
  });
});

describe("stat（I/O は ffmpeg/ 側だけ）", () => {
  test("mtime と size を拾う。相対パスはプロジェクトディレクトリ基準", async () => {
    const { dir } = await lut3d();
    const [entry] = (await fingerprintExternalFiles(dir, [LUT]))!;
    expect(entry?.path).toBe(LUT);
    expect(entry?.size).toBeGreaterThan(0);
    expect(typeof entry?.mtime).toBe("number");
  });

  test("存在しないファイルは size / mtime なしで通す（ffmpeg 側のエラーに任せる）", async () => {
    const { dir } = await lut3d();
    const [entry] = (await fingerprintExternalFiles(dir, ["nope.cube"]))!;
    expect(entry).toEqual({ path: "nope.cube", size: undefined, mtime: undefined });
  });

  test("1 件も無ければ undefined（＝指紋の材料に何も足さない）", async () => {
    const { dir } = await lut3d();
    expect(await fingerprintExternalFiles(dir, [])).toBeUndefined();
    // canonicalJson は undefined のキーを落とすので、従来のハッシュと厳密に一致する
    expect(canonicalHash({ version: 3, external: undefined })).toBe(canonicalHash({ version: 3 }));
  });
});

describe("セグメント指紋（docs/13 D-19）", () => {
  test("LUT の中身を差し替えるとパスが同じでも指紋が変わる", async () => {
    const { project, dir } = await lut3d();
    const before = await hashes(project, dir);
    expect(before.length).toBeGreaterThan(0);

    await writeFile(join(dir, LUT), "LUT_3D_SIZE 2\n0 0 0\n0.5 0.5 0.5\n");
    const after = await hashes(project, dir);
    expect(after).not.toEqual(before);
    // 差し替えたあとは安定する（同じ内容なら同じ指紋）
    expect(await hashes(project, dir)).toEqual(after);
  });

  test("中身が同じでも mtime が違えば別扱い", async () => {
    const { project, dir } = await lut3d();
    const before = await hashes(project, dir);
    const future = new Date(Date.now() + 10000);
    await utimes(join(dir, LUT), future, future);
    expect(await hashes(project, dir)).not.toEqual(before);
  });

  test("LUT を差し替えても、他の要素（filterComplex）は 1 文字も変わらない", async () => {
    const { project, dir } = await lut3d();
    const filter = (await buildPreviewPlan(project, dir, { height: 90 })).segments.map((s) =>
      s.args("/tmp/out.mp4").join(" "),
    );
    await writeFile(join(dir, LUT), "LUT_3D_SIZE 2\n1 1 1\n0 0 0\n");
    expect(
      (await buildPreviewPlan(project, dir, { height: 90 })).segments.map((s) => s.args("/tmp/out.mp4").join(" ")),
    ).toEqual(filter);
  });

  test("外部ファイルを申告しないエフェクトでは指紋が従来どおり（無関係なファイルの変化に反応しない）", async () => {
    const { project, dir } = await blur();
    const before = await hashes(project, dir);
    await writeFile(join(dir, LUT), "LUT_3D_SIZE 2\n1 1 1\n0 0 0\n");
    const future = new Date(Date.now() + 10000);
    await utimes(join(dir, LUT), future, future);
    expect(await hashes(project, dir)).toEqual(before);
  });
});

describe("previewFingerprint（ready / stale の判定）", () => {
  test("LUT の中身が変われば stale になる（指紋が変わる）", async () => {
    const { project, dir } = await lut3d();
    const before = await previewFingerprint(project, dir, 90);
    expect(await previewFingerprint(project, dir, 90)).toBe(before);
    await writeFile(join(dir, LUT), "LUT_3D_SIZE 2\n0 0 0\n0.25 0.25 0.25\n");
    expect(await previewFingerprint(project, dir, 90)).not.toBe(before);
  });

  test("申告しないエフェクトでは指紋が従来どおり", async () => {
    const { project, dir } = await blur();
    const before = await previewFingerprint(project, dir, 90);
    await writeFile(join(dir, LUT), "LUT_3D_SIZE 2\n1 1 1\n0 0 0\n");
    expect(await previewFingerprint(project, dir, 90)).toBe(before);
  });
});
