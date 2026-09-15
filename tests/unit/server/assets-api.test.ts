/**
 * 素材 API（docs/06 §3.2, §3.3, W-17）。
 * `/api/assets`（usage / missing / derived）、`/api/assets/:id`、`/file` の Range、`/proxy.mp4`、
 * `POST /api/cli` の素材系許可リストと confirm、`--read-only` の 405。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  diffAssets,
  isSafeAssetId,
  resolveServablePath,
  sanitizeUploadName,
  uploadDayDir,
} from "../../../src/server/assets.ts";
import type { RunningServer } from "../../../src/server/index.ts";
import { contentTypeOf } from "../../../src/server/range.ts";
import { type AssetFixture, makeAssetProject, PNG_1X1, removeAssetProject, TITLE_TEXT } from "./assets-fixture.ts";
import { boot } from "./helpers.ts";

interface AssetRow {
  id: string;
  type: string;
  missing: boolean;
  proxy: string | null;
  has_proxy: boolean;
  usage: { clips: Array<{ clip_id: string; track: string; start_f: number; end_f: number }> };
  derived: Record<string, { state: string }>;
  tags: string[];
  label?: string;
}

describe("GET /api/assets", () => {
  let fx: AssetFixture;
  let srv: RunningServer;
  const rows = async (): Promise<AssetRow[]> =>
    ((await (await fetch(`${srv.url}/api/assets`)).json()) as { assets: AssetRow[] }).assets;

  beforeAll(async () => {
    fx = await makeAssetProject();
    srv = await boot(fx.dir);
  });
  afterAll(async () => {
    await srv.stop();
    removeAssetProject(fx);
  });

  test("lists every asset with usage, missing and derived state", async () => {
    const assets = await rows();
    expect(assets.map((a) => a.id).sort()).toEqual(["clip_a", "clip_gone", "escaped", "ja_srt", "logo", "title_main"]);

    const clipA = assets.find((a) => a.id === "clip_a")!;
    expect(clipA.missing).toBe(false);
    expect(clipA.usage.clips).toEqual([{ clip_id: "c1", track: "V1", start_f: 0, end_f: 90 }]);
    // 映像素材は proxy 状態を持ち、まだ生成していないので missing
    expect(clipA.proxy).toBe("missing");
    expect(clipA.has_proxy).toBe(false);
    expect(clipA.derived.proxy).toMatchObject({ state: "missing" });

    // ファイルが無い素材は missing: true（UI の ⚠）
    expect(assets.find((a) => a.id === "clip_gone")?.missing).toBe(true);
    // 未使用素材は usage が空
    expect(assets.find((a) => a.id === "logo")?.usage.clips).toEqual([]);
    // 画像・テキスト・字幕はプロキシ対象外
    expect(assets.find((a) => a.id === "title_main")?.proxy).toBeNull();
  });

  test("proxy state becomes stale/ready once .montash/cache/<id>/proxy.mp4 exists", async () => {
    mkdirSync(join(fx.dir, ".montash", "cache", "clip_a"), { recursive: true });
    writeFileSync(join(fx.dir, ".montash", "cache", "clip_a", "proxy.mp4"), Buffer.alloc(2048, 3));
    const clipA = (await rows()).find((a) => a.id === "clip_a")!;
    // proxy.json（フィンガープリント）が無いので stale
    expect(clipA.proxy).toBe("stale");
    expect(clipA.has_proxy).toBe(true);
  });

  test("/api/assets/:id returns detail, and text assets include their body", async () => {
    const res = await fetch(`${srv.url}/api/assets/title_main`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asset: AssetRow; text?: string };
    expect(body.asset.id).toBe("title_main");
    expect(body.asset.type).toBe("text");
    expect(body.text).toBe(TITLE_TEXT);
  });

  test("/api/assets/:id returns the first part of a subtitle file", async () => {
    const body = (await (await fetch(`${srv.url}/api/assets/ja_srt`)).json()) as { text?: string };
    expect(body.text).toContain("こんにちは");
  });

  test("/api/assets/:id is 404 for unknown IDs and 400 for unsafe ones", async () => {
    const unknown = await fetch(`${srv.url}/api/assets/nope`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ ok: false, error: { code: "E_ASSET_NOT_FOUND" } });
    const unsafe = await fetch(`${srv.url}/api/assets/${encodeURIComponent("../../etc/passwd")}`);
    expect([400, 404]).toContain(unsafe.status);
  });
});

describe("GET /api/assets/:id/file and /proxy.mp4", () => {
  let fx: AssetFixture;
  let srv: RunningServer;
  beforeAll(async () => {
    fx = await makeAssetProject();
    srv = await boot(fx.dir);
  });
  afterAll(async () => {
    await srv.stop();
    removeAssetProject(fx);
  });

  test("serves an in-project image with the right content-type", async () => {
    const res = await fetch(`${srv.url}/api/assets/logo/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG_1X1));
  });

  test("serves text assets as UTF-8 text", async () => {
    const res = await fetch(`${srv.url}/api/assets/title_main/file`);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(TITLE_TEXT);
  });

  test("serves an asset stored outside the project (absolute path in project.json)", async () => {
    const res = await fetch(`${srv.url}/api/assets/clip_a/file`);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBe(4096);
    await res.body?.cancel();
  });

  test("supports Range requests and 416 for unsatisfiable ones", async () => {
    const ranged = await fetch(`${srv.url}/api/assets/clip_a/file`, { headers: { range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 0-99/4096");
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);

    const suffix = await fetch(`${srv.url}/api/assets/clip_a/file`, { headers: { range: "bytes=-10" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 4086-4095/4096");
    await suffix.body?.cancel();

    const bad = await fetch(`${srv.url}/api/assets/clip_a/file`, { headers: { range: "bytes=99999-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */4096");
  });

  test("404 E_ASSET_MISSING when the source file is gone", async () => {
    const res = await fetch(`${srv.url}/api/assets/clip_gone/file`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_ASSET_MISSING" } });
  });

  test("403 E_PATH_OUTSIDE_PROJECT for a relative path that escapes the project", async () => {
    const res = await fetch(`${srv.url}/api/assets/escaped/file`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_PATH_OUTSIDE_PROJECT" } });
  });

  test("/proxy.mp4 is 404 until the cache file exists, then serves Range", async () => {
    const before = await fetch(`${srv.url}/api/assets/clip_a/proxy.mp4`);
    expect(before.status).toBe(404);
    expect(await before.json()).toMatchObject({ ok: false, error: { code: "E_NOT_FOUND" } });

    mkdirSync(join(fx.dir, ".montash", "cache", "clip_a"), { recursive: true });
    writeFileSync(join(fx.dir, ".montash", "cache", "clip_a", "proxy.mp4"), Buffer.alloc(512, 1));
    const res = await fetch(`${srv.url}/api/assets/clip_a/proxy.mp4`, { headers: { range: "bytes=0-31" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-range")).toBe("bytes 0-31/512");
  });
});

describe("POST /api/cli — asset commands", () => {
  let fx: AssetFixture;
  let srv: RunningServer;
  beforeAll(async () => {
    fx = await makeAssetProject();
    srv = await boot(fx.dir);
  });
  afterAll(async () => {
    await srv.stop();
    removeAssetProject(fx);
  });

  const post = (body: unknown) =>
    fetch(`${srv.url}/api/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("`assets set` runs and the change shows up in GET /api/assets", async () => {
    const res = await post({ args: ["assets", "set", "logo", "--label", "ロゴ画像", "--tags", "素材,ロゴ"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; exec: { actor: string } };
    expect(body.ok).toBe(true);
    expect(body.exec.actor).toBe("web");

    const assets = ((await (await fetch(`${srv.url}/api/assets`)).json()) as { assets: AssetRow[] }).assets;
    const logo = assets.find((a) => a.id === "logo")!;
    expect(logo.label).toBe("ロゴ画像");
    expect(logo.tags).toEqual(["素材", "ロゴ"]);
  }, 20_000);

  test("removing an asset that is in use fails with E_ASSET_IN_USE", async () => {
    const res = await post({ args: ["assets", "remove", "clip_a"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_ASSET_IN_USE" } });
  }, 20_000);

  test("`assets remove --force` needs confirm (409), then succeeds with confirm: true", async () => {
    const denied = await post({ args: ["assets", "remove", "clip_a", "--force"] });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ ok: false, error: { code: "E_CONFIRM_REQUIRED" } });

    const ok = await post({ args: ["assets", "remove", "clip_a", "--force"], confirm: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, result: { removed: "clip_a" } });
    const assets = ((await (await fetch(`${srv.url}/api/assets`)).json()) as { assets: AssetRow[] }).assets;
    expect(assets.map((a) => a.id)).not.toContain("clip_a");
  }, 25_000);

  test("`assets new-text` creates a text asset visible through the API", async () => {
    const res = await post({ args: ["assets", "new-text", "sub_title", "--text", "ようこそ"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const detail = (await (await fetch(`${srv.url}/api/assets/sub_title`)).json()) as { text?: string };
    expect(detail.text).toBe("ようこそ");
  }, 20_000);

  test("import / proxy build / assets relink are in the allowlist; clip add is not", async () => {
    const list = (await (await fetch(`${srv.url}/api/cli/allowlist`)).json()) as { allowlist: string[] };
    for (const cmd of [
      "import",
      "assets set",
      "assets new-text",
      "assets set-text",
      "assets remove",
      "assets relink",
      "proxy build",
    ])
      expect(list.allowlist).toContain(cmd);
    expect(list.allowlist).not.toContain("clip add");

    // 許可リストにあるので CLI まで到達する（存在しないパスなので CLI 側が失敗するのは想定どおり）
    const res = await post({ args: ["import", join(fx.dir, "nope.mp4"), "--proxy"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error?: { code: string } };
    expect(body.error?.code).not.toBe("E_WEB_COMMAND_NOT_ALLOWED");

    const rejected = await post({ args: ["clip", "add", "--asset", "logo"] });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ ok: false, error: { code: "E_WEB_COMMAND_NOT_ALLOWED" } });
  }, 20_000);
});

describe("--read-only", () => {
  let fx: AssetFixture;
  let srv: RunningServer;
  beforeAll(async () => {
    fx = await makeAssetProject();
    srv = await boot(fx.dir, { readOnly: true });
  });
  afterAll(async () => {
    await srv.stop();
    removeAssetProject(fx);
  });

  test("reads still work but POST /api/cli and /api/upload return 405 E_READ_ONLY", async () => {
    expect((await fetch(`${srv.url}/api/assets`)).status).toBe(200);
    for (const path of ["/api/cli", "/api/upload"]) {
      const res = await fetch(`${srv.url}${path}`, { method: "POST", body: "{}" });
      expect(res.status).toBe(405);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_READ_ONLY" } });
    }
  });
});

describe("pure helpers", () => {
  test("isSafeAssetId rejects path-ish and prototype IDs", () => {
    expect(isSafeAssetId("clip_a")).toBe(true);
    expect(isSafeAssetId("a-1")).toBe(true);
    expect(isSafeAssetId("../etc")).toBe(false);
    expect(isSafeAssetId("a/b")).toBe(false);
    expect(isSafeAssetId("")).toBe(false);
    expect(isSafeAssetId("constructor")).toBe(false);
  });

  test("resolveServablePath allows absolute and in-project paths only", () => {
    expect(resolveServablePath("/p", "/outside/a.mp4")).toBe("/outside/a.mp4");
    expect(resolveServablePath("/p", "assets/a.png")).toBe("/p/assets/a.png");
    expect(resolveServablePath("/p", "../escape.txt")).toBeNull();
    expect(resolveServablePath("/p", "assets/../../escape.txt")).toBeNull();
  });

  test("contentTypeOf falls back to octet-stream, never text/html", () => {
    expect(contentTypeOf("a.mp4")).toBe("video/mp4");
    expect(contentTypeOf("a.PNG")).toBe("image/png");
    expect(contentTypeOf("a.srt")).toBe("text/plain; charset=utf-8");
    expect(contentTypeOf("a.html")).toBe("application/octet-stream");
    expect(contentTypeOf("noext")).toBe("application/octet-stream");
  });

  test("diffAssets reports added / removed / updated", () => {
    expect(diffAssets({ a: "1", b: "2" }, { b: "9", c: "3" })).toEqual({
      added: ["c"],
      removed: ["a"],
      updated: ["b"],
    });
    expect(diffAssets({ a: "1" }, { a: "1" })).toEqual({ added: [], removed: [], updated: [] });
  });

  test("sanitizeUploadName strips directories, traversal and control characters", () => {
    expect(sanitizeUploadName("clip.mp4")).toBe("clip.mp4");
    expect(sanitizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeUploadName("..\\..\\windows\\evil.exe")).toBe("evil.exe");
    expect(sanitizeUploadName("..")).toBe("upload");
    expect(sanitizeUploadName("")).toBe("upload");
    expect(sanitizeUploadName(".hidden")).toBe("hidden");
    expect(sanitizeUploadName("a:b?c.mp4")).toBe("a_b_c.mp4");
  });

  test("uploadDayDir formats YYYYMMDD", () => {
    expect(uploadDayDir(new Date(2026, 8, 5))).toBe("20260905");
  });
});
