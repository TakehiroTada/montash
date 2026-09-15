/**
 * 派生物の配信（docs/06 §3.2）。
 * `GET /api/assets/:id/thumbs.json` / `thumbs.jpg` / `waveform.json` と、未生成のときの 404。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunningServer } from "../../../src/server/index.ts";
import { type AssetFixture, makeAssetProject, PNG_1X1, removeAssetProject } from "./assets-fixture.ts";
import { boot } from "./helpers.ts";

const THUMBS_INDEX = { interval_f: 30, width: 160, height: 90, columns: 5, count: 5, sprite: "thumbs.jpg" };
const WAVEFORM = { points_per_second: 100, channels: 1, peaks: [0, 0.5, 1] };

describe("GET /api/assets/:id/thumbs.json|thumbs.jpg|waveform.json", () => {
  let fx: AssetFixture;
  let srv: RunningServer;

  beforeAll(async () => {
    fx = await makeAssetProject();
    // clip_a のキャッシュにだけ派生物を置く（clip_gone / logo は未生成のまま）
    const cache = join(fx.dir, ".montash", "cache", "clip_a");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "thumbs.json"), JSON.stringify(THUMBS_INDEX));
    writeFileSync(join(cache, "thumbs.jpg"), PNG_1X1);
    writeFileSync(join(cache, "waveform.json"), JSON.stringify(WAVEFORM));
    srv = await boot(fx.dir);
  });
  afterAll(async () => {
    await srv.stop();
    removeAssetProject(fx);
  });

  test("serves the thumbnail index as JSON", async () => {
    const res = await fetch(`${srv.url}/api/assets/clip_a/thumbs.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(THUMBS_INDEX);
  });

  test("serves the sprite as an image with Range support", async () => {
    const res = await fetch(`${srv.url}/api/assets/clip_a/thumbs.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(PNG_1X1));

    const ranged = await fetch(`${srv.url}/api/assets/clip_a/thumbs.jpg`, { headers: { range: "bytes=0-3" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-3/${PNG_1X1.length}`);
  });

  test("serves the waveform as JSON", async () => {
    const res = await fetch(`${srv.url}/api/assets/clip_a/waveform.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(WAVEFORM);
  });

  test("404s when the derivative has not been built", async () => {
    for (const path of ["thumbs.json", "thumbs.jpg", "waveform.json"]) {
      const res = await fetch(`${srv.url}/api/assets/clip_gone/${path}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; hint?: string } };
      expect(body.error.code).toBe("E_NOT_FOUND");
      expect(body.error.hint).toContain("montash proxy build clip_gone");
    }
  });

  test("404s for an unknown asset and rejects unsafe ids", async () => {
    expect((await fetch(`${srv.url}/api/assets/nope/thumbs.json`)).status).toBe(404);
    const unsafe = await fetch(`${srv.url}/api/assets/${encodeURIComponent("../../etc")}/waveform.json`);
    expect(unsafe.status).toBe(400);
    expect(((await unsafe.json()) as { error: { code: string } }).error.code).toBe("E_USAGE");
  });

  test("the asset list reports the derived state and what can be served", async () => {
    const rows = (await (await fetch(`${srv.url}/api/assets`)).json()) as {
      assets: Array<{
        id: string;
        thumbs: string | null;
        waveform: string | null;
        has_thumbs: boolean;
        has_waveform: boolean;
        derived: Record<string, { state: string }>;
      }>;
    };
    const byId = new Map(rows.assets.map((a) => [a.id, a]));
    // ファイルはあるが指紋（thumbs.src.json）が無いので stale
    expect(byId.get("clip_a")).toMatchObject({ thumbs: "stale", waveform: "stale", has_thumbs: true });
    expect(byId.get("clip_a")!.derived.thumbs).toMatchObject({ state: "stale" });
    // 画像はサムネイルのみ対象、波形は対象外
    expect(byId.get("logo")).toMatchObject({ thumbs: "missing", waveform: null, has_thumbs: false });
    // テキスト・字幕はどちらも対象外
    expect(byId.get("title_main")).toMatchObject({ thumbs: null, waveform: null });
    expect(byId.get("ja_srt")).toMatchObject({ thumbs: null, waveform: null });
  });
});
