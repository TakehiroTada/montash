/**
 * 履歴の読み取り API（docs/06 §3.2、docs/13 D-10）。
 *
 * `GET /api/history/:id` / `GET /api/history/diff` / `GET /api/blame/:elementId` が
 * CLI の `show` / `diff` / `blame --json` と同じ `result` を返すことを確かめる。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunningServer } from "../../../src/server/index.ts";
import { boot } from "./helpers.ts";

let dir: string;
let server: RunningServer | undefined;

async function cli(...args: string[]): Promise<Record<string, unknown>> {
  const p = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../../../src/cli/index.ts"), "-C", dir, "--json", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const body = JSON.parse(text) as Record<string, unknown>;
  if (code !== 0) throw new Error(text);
  return body;
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${server!.url}${path}`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-history-api-"));
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** init → project set → commit → track add → project set（pending 1 件）の履歴を作る */
async function seed(): Promise<void> {
  await cli("init", dir);
  await cli("project", "set", "name", "version-two");
  await cli("commit", "-m", "first edit");
  await cli("track", "add", "--kind", "video");
  await cli("project", "set", "name", "version-three");
}

test("GET /api/history/:id returns the same result as `montash show`", async () => {
  await seed();
  server = await boot(dir);

  const op = await get("/api/history/o_0002");
  expect(op.status).toBe(200);
  expect(op.body).toEqual((await cli("show", "o_0002")).result as Record<string, unknown>);
  expect(op.body).toMatchObject({ kind: "op", ref: { op: "o_0002", via: "op", back: 0 } });
  // 既定は changes 本体を含まない（CLI の `show` と同じ）
  expect(op.body.changes).toBeUndefined();
  expect(Array.isArray(op.body.changed_paths)).toBe(true);

  // `?patch=1` で changes 全件（`show --patch` 相当）
  const patched = await get("/api/history/o_0002?patch=1");
  expect(patched.body).toEqual((await cli("show", "o_0002", "--patch")).result as Record<string, unknown>);
  expect(patched.body.changes).toHaveLength((op.body.changed_paths as unknown[]).length);

  // コミット ID とタグ、HEAD~n も CLI と同じに解決する
  const commit = await get("/api/history/k_0001");
  expect(commit.body).toEqual((await cli("show", "k_0001")).result as Record<string, unknown>);
  expect(commit.body.kind).toBe("commit");
  expect(await get("/api/history/HEAD~1").then((r) => r.body)).toEqual(
    (await cli("show", "HEAD~1")).result as Record<string, unknown>,
  );
}, 30_000);

test("GET /api/history/diff matches `montash diff` for the pending range and for a,b", async () => {
  await seed();
  server = await boot(dir);

  // 引数なし = 最終コミット → HEAD（pending 全体）
  const pending = await get("/api/history/diff");
  expect(pending.status).toBe(200);
  expect(pending.body).toEqual((await cli("diff")).result as Record<string, unknown>);
  expect(pending.body).toMatchObject({ to: { ref: "HEAD", op: "o_0004" } });
  expect(pending.body.change_count).toBeGreaterThan(0);

  // a / b を明示（docs/06 §3.2 の `?a=<id>&b=<id>`）
  const explicit = await get("/api/history/diff?a=o_0001&b=o_0003");
  expect(explicit.body).toEqual((await cli("diff", "o_0001", "o_0003")).result as Record<string, unknown>);
  expect(explicit.body).toMatchObject({ from: { ref: "o_0001" }, to: { ref: "o_0003" } });

  // 同じ地点なら差分なし。b を省くと HEAD
  expect((await get("/api/history/diff?a=HEAD&b=HEAD")).body).toMatchObject({
    change_count: 0,
    summary: "no changes",
    changes: [],
  });
  expect((await get("/api/history/diff?a=HEAD")).body).toEqual(
    (await cli("diff", "HEAD", "HEAD")).result as Record<string, unknown>,
  );
}, 30_000);

test("GET /api/blame/:elementId matches `montash blame`", async () => {
  await seed();
  server = await boot(dir);

  const blame = await get("/api/blame/V2");
  expect(blame.status).toBe(200);
  // CLI の blame と 1 バイトも変えない（docs/13 D-10: ロジックは core/history のまま）
  expect(blame.body).toEqual((await cli("blame", "V2")).result as Record<string, unknown>);
  expect(blame.body).toMatchObject({ element: "V2", actor: "ai", command: expect.any(Array) });
  expect((blame.body.op as { id: string }).id).toBe("o_0003");

  // `?all=1` は `--all` 相当
  expect((await get("/api/blame/V2?all=1")).body).toEqual(
    (await cli("blame", "V2", "--all")).result as Record<string, unknown>,
  );
}, 30_000);

test("unknown refs and elements are 404 with the CLI's hint", async () => {
  await seed();
  server = await boot(dir);

  const missingRef = await get("/api/history/o_9999");
  expect(missingRef.status).toBe(404);
  expect(missingRef.body).toMatchObject({ ok: false, error: { code: "E_HISTORY_REF_NOT_FOUND" } });

  const missingElement = await get("/api/blame/nope");
  expect(missingElement.status).toBe(404);
  expect(missingElement.body).toMatchObject({
    ok: false,
    error: { code: "E_HISTORY_REF_NOT_FOUND", hint: expect.stringContaining("Known element ids") },
  });

  expect((await get("/api/history/diff?a=o_9999")).status).toBe(404);
  // 制御文字や長すぎる ref は 400
  expect((await get("/api/blame/" + "x".repeat(400))).status).toBe(400);
}, 30_000);

test("reading the new endpoints never creates or touches .montash/history", async () => {
  server = await boot(dir);
  // 履歴がまったく無いディレクトリ: show / blame は 404、diff は空、ファイルは 1 つも作らない
  expect(await get("/api/history/HEAD")).toMatchObject({
    status: 404,
    body: { error: { code: "E_HISTORY_REF_NOT_FOUND" } },
  });
  expect(await get("/api/blame/c1")).toMatchObject({ status: 404 });
  expect((await get("/api/history/diff")).body).toEqual({
    from: { ref: null, op: null },
    to: { ref: null, op: null },
    change_count: 0,
    summary: "no changes",
    changes: [],
  });
  expect(await readdir(dir)).toEqual([]);
});
