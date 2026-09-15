/**
 * `POST /api/upload`（docs/06 §3.3, docs/13 A-5, W-17）。
 * multipart で受けたファイルを `assets/incoming/<YYYYMMDD>/` に保存し、続けて `import <path> --proxy` を発行する。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INCOMING_DIR, MAX_UPLOAD_BYTES, uploadDayDir } from "../../../src/server/assets.ts";
import type { RunningServer } from "../../../src/server/index.ts";
import { type AssetFixture, makeAssetProject, removeAssetProject } from "./assets-fixture.ts";
import { boot, openWs } from "./helpers.ts";

let fx: AssetFixture;
let srv: RunningServer;

beforeEach(async () => {
  fx = await makeAssetProject();
  srv = await boot(fx.dir);
});
afterEach(async () => {
  await srv.stop();
  removeAssetProject(fx);
});

function upload(name: string, body: string, field = "file"): Promise<Response> {
  const form = new FormData();
  form.append(field, new File([body], name, { type: "text/plain" }));
  return fetch(`${srv.url}/api/upload`, { method: "POST", body: form });
}

const incoming = (): string => join(fx.dir, INCOMING_DIR, uploadDayDir());

test("saves the file under assets/incoming/<YYYYMMDD>/ and imports it", async () => {
  const res = await upload("memo.txt", "ナレーション原稿\n");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    result?: { imported?: Array<{ id: string; path: string }> };
    upload: { path: string; relative: string; size: number; original_name: string };
  };

  expect(body.upload.original_name).toBe("memo.txt");
  expect(body.upload.relative.replace(/\\/g, "/")).toBe(`assets/incoming/${uploadDayDir()}/memo.txt`);
  expect(readFileSync(body.upload.path, "utf8")).toBe("ナレーション原稿\n");

  // 保存の次は CLI 発行（docs/06 §1.1）。テキストは ffprobe 無しで import できる
  expect(body.ok).toBe(true);
  expect(body.result?.imported?.[0]?.id).toBe("memo");

  // 取り込んだ素材は /api/assets に現れる
  const assets = ((await (await fetch(`${srv.url}/api/assets`)).json()) as { assets: Array<{ id: string }> }).assets;
  expect(assets.map((a) => a.id)).toContain("memo");
}, 20_000);

test("names that contain ../ are sanitized to a single segment", async () => {
  const res = await upload("../../../etc/evil.txt", "x");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { upload: { path: string } };
  expect(body.upload.path).toBe(join(incoming(), "evil.txt"));
  expect(readdirSync(incoming())).toEqual(["evil.txt"]);
  expect(existsSync(join(fx.dir, "..", "..", "..", "etc", "evil.txt"))).toBe(false);
}, 20_000);

test("same name twice keeps both files with a numeric suffix", async () => {
  await upload("take.txt", "one");
  await upload("take.txt", "two");
  expect(readdirSync(incoming()).sort()).toEqual(["take-1.txt", "take.txt"]);
}, 25_000);

test("over the limit returns 413 E_UPLOAD_TOO_LARGE and points at path import", async () => {
  await srv.stop();
  srv = await boot(fx.dir, { maxUploadBytes: 64 });
  const res = await upload("big.txt", "x".repeat(500));
  expect(res.status).toBe(413);
  const body = (await res.json()) as { error: { code: string; hint?: string } };
  expect(body.error.code).toBe("E_UPLOAD_TOO_LARGE");
  expect(body.error.hint).toContain("montash import");
  expect(existsSync(incoming())).toBe(false);
});

test("the default limit is 2GB (docs/13 A-5)", () => {
  expect(MAX_UPLOAD_BYTES).toBe(2 * 1024 * 1024 * 1024);
});

test("a request without a file field is 400 E_USAGE", async () => {
  const form = new FormData();
  form.append("note", "no file here");
  const res = await fetch(`${srv.url}/api/upload`, { method: "POST", body: form });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_USAGE" } });
});

test("pushes job.progress / job.done and assets.changed over the WebSocket", async () => {
  const { ws, next } = await openWs(srv.url);
  try {
    const started = next("job.progress", 20_000);
    const done = next("job.done", 20_000);
    const changed = next("assets.changed", 20_000);
    const res = await upload("jobs.txt", "hello");
    expect(res.status).toBe(200);
    expect(await started).toMatchObject({ kind: "upload", percent: 0 });
    expect(await done).toMatchObject({ kind: "upload", ok: true });
    expect(await changed).toMatchObject({ added: ["jobs"], removed: [], updated: [] });
  } finally {
    ws.close();
  }
}, 25_000);
