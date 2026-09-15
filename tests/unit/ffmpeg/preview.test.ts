import { afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, projectPaths } from "../../../src/core/project.ts";
import { ClipSchema, type Project, VideoAssetSchema } from "../../../src/core/schema.ts";
import { ensureFixtures } from "../../../src/ffmpeg/fixtures.ts";
import { locateBinaries } from "../../../src/ffmpeg/locate.ts";
import {
  buildPreview,
  buildPreviewPlan,
  readPreviewManifest,
  readPreviewStatus,
  segmentBoundaries,
} from "../../../src/ffmpeg/preview.ts";

const bins = locateBinaries();
let fixture: string;
let fixture2997: string;
const dirs: string[] = [];
beforeAll(async () => {
  const made = await ensureFixtures(bins);
  fixture = made.a!;
  fixture2997 = made.a2997!;
}, 60000);
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** 640x360 / 30fps のプロジェクトに、指定した区間の映像クリップを並べる */
async function setup(clips: Array<{ id: string; start_f: number; in_f: number; out_f: number }>) {
  const dir = await mkdtemp(join(tmpdir(), "montash-preview-"));
  dirs.push(dir);
  await copyFile(fixture, join(dir, "a.mp4"));
  const project = createProject({ name: "preview", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 150 });
  for (const c of clips) project.tracks[0]!.clips.push(ClipSchema.parse({ asset: "a", ...c }));
  return { project, dir };
}
const single = () => setup([{ id: "c1", start_f: 0, in_f: 3, out_f: 20 }]);
const previewDir = (dir: string) => projectPaths(dir).previewDir;

test("segment boundaries land on clip edges and merge spans shorter than the minimum", () => {
  const project = createProject({ name: "b", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", asset: "a", start_f: 0, in_f: 0, out_f: 70 }),
    // 10 フレームしかない区間は境界にせず後ろへ統合する
    ClipSchema.parse({ id: "c2", asset: "a", start_f: 70, in_f: 0, out_f: 10 }),
    ClipSchema.parse({ id: "c3", asset: "a", start_f: 80, in_f: 0, out_f: 80 }),
  );
  expect(segmentBoundaries(project, 160)).toEqual([0, 70, 160]);
  // 音声トラックのクリップは映像セグメントを割らない
  project.tracks[1]!.clips.push(ClipSchema.parse({ id: "c4", asset: "a", start_f: 100, in_f: 0, out_f: 20 }));
  expect(segmentBoundaries(project, 160)).toEqual([0, 70, 160]);
});

test("splits the timeline into cached segments and re-encodes only what changed", async () => {
  const { project, dir } = await setup([
    { id: "c1", start_f: 0, in_f: 0, out_f: 70 },
    { id: "c2", start_f: 70, in_f: 70, out_f: 140 },
  ]);
  const plan = await buildPreviewPlan(project, dir, { height: 90 });
  expect(plan.segments.map((s) => [s.from_f, s.to_f])).toEqual([
    [0, 70],
    [70, 140],
  ]);

  const first = await buildPreview(project, dir, { bins, height: 90 });
  expect(first.built_segments).toBe(2);
  expect(first.cached_segments).toBe(0);
  const manifest = (await readPreviewManifest(dir))!;
  // docs/05 §12 の形
  expect(manifest.duration_f).toBe(140);
  expect(manifest.fps).toEqual({ num: 30, den: 1 });
  expect(manifest.audio).toEqual({ hash: expect.stringMatching(/^sha1:/), path: "audio.m4a" });
  expect(manifest.video_segments).toEqual([
    { from_f: 0, to_f: 70, hash: expect.stringMatching(/^sha1:/), path: expect.any(String), clips: ["c1"] },
    { from_f: 70, to_f: 140, hash: expect.stringMatching(/^sha1:/), path: expect.any(String), clips: ["c2"] },
  ]);
  for (const s of manifest.video_segments) expect(existsSync(join(previewDir(dir), s.path))).toBe(true);
  expect(existsSync(join(previewDir(dir), "audio.m4a"))).toBe(true);
  expect(existsSync(join(previewDir(dir), "video.mp4"))).toBe(true);

  // 2 番目のクリップだけを差し替える → 先頭セグメントも音声（無音のまま）もキャッシュを使う
  (project.tracks[0]!.clips[1] as { in_f: number; out_f: number }).in_f = 60;
  (project.tracks[0]!.clips[1] as { in_f: number; out_f: number }).out_f = 130;
  const second = await buildPreview(project, dir, { bins, height: 90 });
  expect(second.built_segments).toBe(1);
  expect(second.cached_segments).toBe(1);
  expect(second.audio_reused).toBe(true);
  const after = (await readPreviewManifest(dir))!;
  expect(after.video_segments[0]!.hash).toBe(manifest.video_segments[0]!.hash);
  expect(after.video_segments[1]!.hash).not.toBe(manifest.video_segments[1]!.hash);
  expect((await readPreviewStatus(project, dir, { height: 90 })).state).toBe("ready");

  // 音声クリップを足すと映像セグメントは全部キャッシュのまま、音声だけ 1 パスで作り直す
  project.tracks[1]!.clips.push(ClipSchema.parse({ id: "c3", asset: "a", start_f: 0, in_f: 0, out_f: 140 }));
  const third = await buildPreview(project, dir, { bins, height: 90 });
  expect(third.built_segments).toBe(0);
  expect(third.cached_segments).toBe(2);
  expect(third.audio_reused).toBe(false);
}, 60000);

test("custom-height preview verifies exact duration, reuses the cache and detects changed sources", async () => {
  const { project, dir } = await single();
  expect((await readPreviewStatus(project, dir)).state).toBe("missing");
  const built = await buildPreview(project, dir, { bins, height: 90 });
  expect(built.status.duration_f).toBe(17);
  expect(built.status.resolution).toEqual({ width: 160, height: 90 });
  expect(built.status.path).toBe(join(previewDir(dir), "timeline.mp4"));
  expect((await readPreviewStatus(project, dir)).state).toBe("ready");
  expect((await buildPreview(project, dir, { bins, height: 90 })).reused).toBe(true);

  await utimes(join(dir, "a.mp4"), new Date(), new Date(Date.now() + 10000));
  const stale = await readPreviewStatus(project, dir);
  expect(stale.state).toBe("stale");
  // 古いプレビューは差し替わるまで再生できる
  expect(stale.path).toBe(built.status.path);
  expect((await stat(stale.path!)).size).toBeGreaterThan(0);
  const next = await buildPreview(project, dir, { bins, height: 90 });
  expect(next.reused).toBe(false);
  expect((await readPreviewStatus(project, dir)).state).toBe("ready");
}, 60000);

test("--audio-only rebuilds audio.m4a without touching the muxed timeline", async () => {
  const { project, dir } = await single();
  await buildPreview(project, dir, { bins, height: 90 });
  const folder = previewDir(dir);
  const before = await stat(join(folder, "timeline.mp4"));
  const audioOnly = await buildPreview(project, dir, { bins, height: 90, audioOnly: true, force: true });
  expect(audioOnly.audio_only).toBe(true);
  expect(audioOnly.built_segments).toBe(0);
  expect((await stat(join(folder, "timeline.mp4"))).mtimeMs).toBe(before.mtimeMs);
  expect((await stat(join(folder, "audio.m4a"))).size).toBeGreaterThan(0);
}, 60000);

test("cancellation preserves the previous manifest and releases the cache lock", async () => {
  const { project, dir } = await single();
  await buildPreview(project, dir, { bins, height: 90 });
  const folder = previewDir(dir);
  const before = await readFile(join(folder, "timeline.json"), "utf8");
  const controller = new AbortController();
  await expect(
    buildPreview(project, dir, {
      bins,
      height: 90,
      force: true,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
  ).rejects.toMatchObject({ code: "E_FFMPEG_CANCELLED" });
  expect(await readFile(join(folder, "timeline.json"), "utf8")).toBe(before);
  expect((await readdir(folder)).filter((f) => f.startsWith(".building") || f === "build.lock")).toEqual([]);
  expect((await readPreviewStatus(project, dir)).state).toBe("ready");
}, 60000);

test("an active lock reports building, rejects concurrent writers and keeps the old video", async () => {
  const { project, dir } = await single();
  const built = await buildPreview(project, dir, { bins, height: 90 });
  const folder = previewDir(dir);
  await writeFile(join(folder, "build.lock"), JSON.stringify({ pid: process.pid }));
  const status = await readPreviewStatus(project, dir);
  expect(status.state).toBe("building");
  expect(status.path).toBe(built.status.path);
  await expect(buildPreview(project, dir, { bins, height: 90, force: true })).rejects.toMatchObject({
    code: "E_PREVIEW_BUSY",
  });
  expect(JSON.parse(await readFile(join(folder, "build.lock"), "utf8")).pid).toBe(process.pid);
}, 60000);

test("a manifest that points outside the cache directory is ignored", async () => {
  const { project, dir } = await single();
  await buildPreview(project, dir, { bins, height: 90 });
  const manifest = join(previewDir(dir), "timeline.json");
  const value = JSON.parse(await readFile(manifest, "utf8"));
  for (const path of ["../../a.mp4", "/etc/passwd", "segments/../../../a.mp4"]) {
    await writeFile(manifest, JSON.stringify({ ...value, video_segments: [{ ...value.video_segments[0], path }] }));
    expect(await readPreviewManifest(dir)).toBeNull();
    expect((await readPreviewStatus(project, dir)).state).toBe("missing");
  }
}, 60000);

test("concatenating segments at 29.97fps keeps the exact frame count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "montash-preview-2997-"));
  dirs.push(dir);
  await copyFile(fixture2997, join(dir, "a.mp4"));
  const project = createProject({
    name: "preview2997",
    fps: { num: 30000, den: 1001 },
    resolution: { width: 640, height: 360 },
  });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 149 });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", asset: "a", start_f: 0, in_f: 0, out_f: 70 }),
    ClipSchema.parse({ id: "c2", asset: "a", start_f: 70, in_f: 70, out_f: 140 }),
  );
  project.tracks[1]!.clips.push(ClipSchema.parse({ id: "c3", asset: "a", start_f: 0, in_f: 0, out_f: 140 }));
  const built = await buildPreview(project, dir, { bins, height: 90 });
  // verifyRender が nb_read_frames == 140、fps、音声尺を厳密に確認している
  expect(built.built_segments).toBe(2);
  expect(built.status.duration_f).toBe(140);
  expect((await readPreviewStatus(project, dir, { height: 90 })).state).toBe("ready");
}, 60000);

test("an empty timeline is refused", async () => {
  const { project, dir } = await setup([]);
  await expect(buildPreview(project as Project, dir, { bins, height: 90 })).rejects.toMatchObject({
    code: "E_EMPTY_TIMELINE",
  });
}, 30000);
