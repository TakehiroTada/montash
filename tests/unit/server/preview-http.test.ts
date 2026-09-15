import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servePreview } from "../../../src/server/preview.ts";

const PROJECT_HASH = "sha1:0000000000000000000000000000000000000001";
const MANIFEST = {
  project_hash: PROJECT_HASH,
  fingerprint: "sha1:0000000000000000000000000000000000000002",
  built_at: "2026-09-15T00:00:00.000Z",
  duration_f: 90,
  fps: { num: 30, den: 1 },
  resolution: { width: 640, height: 360 },
  video_segments: [
    { from_f: 0, to_f: 90, hash: `sha1:${"a".repeat(40)}`, path: `segments/${"a".repeat(40)}.mp4`, clips: ["c1"] },
  ],
  audio: { hash: "sha1:0000000000000000000000000000000000000003", path: "audio.m4a" },
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-preview-http-"));
  await mkdir(join(dir, ".montash/preview/segments"), { recursive: true });
  await writeFile(join(dir, ".montash/preview/timeline.mp4"), "0123456789");
  await writeFile(join(dir, ".montash/preview/audio.m4a"), "audio");
  await writeFile(join(dir, ".montash/preview/timeline.json"), JSON.stringify(MANIFEST));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
const request = (headers: Record<string, string> = {}, method = "GET", name = "timeline.mp4") =>
  servePreview(dir, new Request(`http://localhost/preview/${name}`, { headers, method }));

test("timeline.mp4 supports full, bounded, suffix and open byte ranges", async () => {
  for (const [range, body, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
  ]) {
    const res = await request({ range: range! });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(contentRange!);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(await res.text()).toBe(body!);
  }
  const full = await request();
  expect(full.status).toBe(200);
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(await full.text()).toBe("0123456789");
});

test("invalid and unsatisfiable ranges are rejected with the file size", async () => {
  for (const range of [
    "bytes=10-",
    "bytes=6-2",
    "bytes=-0",
    "bytes=-",
    "bytes=0-1,3-4",
    "bytes=999999999999999999999-",
  ]) {
    const res = await request({ range });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */10");
  }
});

test("the ETag is the project hash and drives HEAD, If-None-Match and If-Range", async () => {
  const head = await request({}, "HEAD");
  expect(head.headers.get("content-length")).toBe("10");
  expect(await head.text()).toBe("");
  const etag = head.headers.get("etag")!;
  expect(etag).toBe(`"${PROJECT_HASH}"`);
  expect((await request({ "if-none-match": etag })).status).toBe(304);
  // 版が変わっていれば Range を無視して全体を返す
  const stale = await request({ range: "bytes=2-3", "if-range": '"sha1:old"' });
  expect(stale.status).toBe(200);
  expect(await stale.text()).toBe("0123456789");
});

test("timeline.json returns the manifest and audio.m4a is served for --audio-only previews", async () => {
  const res = await servePreview(dir, new Request("http://localhost/preview/timeline.json"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual(MANIFEST);
  const audio = await request({}, "GET", "audio.m4a");
  expect(audio.status).toBe(200);
  expect(audio.headers.get("content-type")).toBe("audio/mp4");
  expect(await audio.text()).toBe("audio");
});

test("rejects unknown names, symlinks, traversal and non-GET methods", async () => {
  await symlink(join(dir, ".montash/preview/timeline.mp4"), join(dir, ".montash/preview/link.mp4"));
  for (const name of ["project.json", "link.mp4", "video.mp4", "..%2fproject.json", "segments/a.mp4", ""]) {
    expect((await request({}, "GET", name)).status).toBe(404);
  }
  expect((await request({}, "POST")).status).toBe(405);
});

test("nothing is served while the manifest is missing or invalid", async () => {
  const empty = await mkdtemp(join(tmpdir(), "montash-preview-http-empty-"));
  await mkdir(join(empty, ".montash/preview"), { recursive: true });
  await writeFile(join(empty, ".montash/preview/timeline.mp4"), "0123456789");
  const bare = (name: string) => servePreview(empty, new Request(`http://localhost/preview/${name}`));
  expect((await bare("timeline.mp4")).status).toBe(404);
  expect((await bare("timeline.json")).status).toBe(404);
  // セグメントがキャッシュの外を指すマニフェストは無効
  await writeFile(
    join(empty, ".montash/preview/timeline.json"),
    JSON.stringify({ ...MANIFEST, video_segments: [{ ...MANIFEST.video_segments[0], path: "../../a.mp4" }] }),
  );
  expect((await bare("timeline.mp4")).status).toBe(404);
  await rm(empty, { recursive: true, force: true });
});
