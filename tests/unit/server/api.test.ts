import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLoopback, type RunningServer } from "../../../src/server/index.ts";
import { boot, makeTempProject, removeTemp, SAMPLE_PROJECT } from "./helpers.ts";

describe("GET /api/*", () => {
  let dir: string;
  let srv: RunningServer;
  beforeAll(async () => {
    dir = makeTempProject();
    srv = await boot(dir);
  });
  afterAll(async () => {
    await srv.stop();
    removeTemp(dir);
  });

  test("/api/project returns project.json verbatim with an ETag", async () => {
    const res = await fetch(`${srv.url}/api/project`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("etag")).toMatch(/^sha1:[0-9a-f]{40}$/);
    expect(await res.json()).toEqual(SAMPLE_PROJECT);
  });

  test("/api/status has the docs/06 §3.2 shape (stubbed head / preview)", async () => {
    const res = await fetch(`${srv.url}/api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.watching).toBe(false);
    expect(body.head).toBeNull();
    expect(body.preview).toEqual({ state: "missing" });
    expect(body.server).toMatchObject({ version: expect.any(String), read_only: false });
  });

  test("/api/history returns a stub and parses ops.jsonl when present", async () => {
    let body = (await (await fetch(`${srv.url}/api/history`)).json()) as { ops: unknown[]; commits: unknown[]; tags: unknown; moves: unknown[]; head: unknown };
    expect(body).toEqual({ head: null, ops: [], commits: [], tags: {}, moves: [] });
    writeFileSync(join(dir, ".montash/history/ops.jsonl"), JSON.stringify({ id: "o_0001", actor: "ai" }) + "\n{broken\n" + JSON.stringify({ id: "o_0002" }) + "\n");
    body = (await (await fetch(`${srv.url}/api/history`)).json()) as typeof body;
    expect(body.ops).toEqual([{ id: "o_0001", actor: "ai" }, { id: "o_0002" }]);
  });

  test("/api/cli/allowlist returns the default allowlist", async () => {
    const body = (await (await fetch(`${srv.url}/api/cli/allowlist`)).json()) as { allowlist: string[]; read_only: boolean };
    expect(body.allowlist).toContain("checkout");
    expect(body.allowlist).toContain("assets remove");
    expect(body.allowlist).not.toContain("doctor");
    expect(body.read_only).toBe(false);
  });

  test("unknown paths return 404 JSON", async () => {
    for (const p of ["/nope", "/api/nope", "/../package.json"]) {
      const res = await fetch(`${srv.url}${p}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_NOT_FOUND" } });
    }
  });

  test("/ without web/dist explains how to build (or serves dist when built)", async () => {
    const res = await fetch(`${srv.url}/`);
    expect([200, 503]).toContain(res.status);
    const text = await res.text();
    if (res.status === 503) expect(text).toContain("bun run build:web");
    else expect(text).toContain('<div id="root">');
  });
});

describe("GET /api/project without project.json", () => {
  test("returns 404 JSON", async () => {
    const dir = makeTempProject(false);
    const srv = await boot(dir);
    try {
      const res = await fetch(`${srv.url}/api/project`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_NOT_FOUND" } });
    } finally {
      await srv.stop();
      removeTemp(dir);
    }
  });
});

describe("dev mode (Bun HTML import)", () => {
  test("/ serves web/index.html bundled on the fly", async () => {
    const dir = makeTempProject();
    const srv = await boot(dir, { dev: true });
    try {
      const res = await fetch(`${srv.url}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<div id="root">');
      const m = html.match(/src="([^"]+\.js)"/);
      expect(m).not.toBeNull();
      const js = await fetch(`${srv.url}${m![1]}`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("javascript");
    } finally {
      await srv.stop();
      removeTemp(dir);
    }
  }, 20_000);
});

describe("isLoopback", () => {
  test("loopback hosts", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.2")).toBe(false);
  });
});
