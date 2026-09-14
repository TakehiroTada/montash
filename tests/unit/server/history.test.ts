import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readHistoryView } from "../../../src/server/history.ts";
import type { RunningServer } from "../../../src/server/index.ts";
import { boot, openWs } from "./helpers.ts";

let dir: string;
let server: RunningServer | undefined;
async function cli(...args: string[]) {
  const p = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "../../../src/cli/index.ts"), "-C", dir, "--json", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const result = JSON.parse(text);
  if (code !== 0) throw new Error(JSON.stringify(result));
  return result;
}
async function get(path: string) {
  return (await fetch(`${server!.url}${path}`)).json();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-history-web-"));
});
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("reading history without files does not initialize or mutate the directory", async () => {
  expect(readHistoryView(dir)).toEqual({
    history: { head: null, ops: [], commits: [], tags: {}, moves: [] },
    state: null,
  });
  expect(await readdir(dir)).toEqual([]);
});

test("status/history reflect commits, pending, tags, branching and Web checkout", async () => {
  await cli("init", dir);
  await cli("project", "set", "name", "version-two");
  await cli("commit", "-m", "first edit");
  await cli("tag", "saved");
  await cli("project", "set", "name", "version-three");
  server = await boot(dir);
  expect((await get("/api/status")).head).toMatchObject({ op: "o_0003", pending: 1, detached: false, dirty: false });
  const history = await get("/api/history");
  expect(history.ops[1].commit).toBe("k_0001");
  expect(history.ops[2].commit).toBeNull();
  expect(history.tags.saved.target).toBe("o_0002");
  const response = await fetch(`${server.url}/api/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args: ["checkout", "saved"] }),
  });
  expect((await response.json()).ok).toBe(true);
  expect((await get("/api/status")).head).toMatchObject({
    op: "o_0002",
    pending: 0,
    commit: "k_0001",
    detached: true,
    dirty: false,
  });
  expect((await get("/api/project")).name).toBe("version-two");
  expect((await get("/api/history")).moves.at(-1)).toMatchObject({ actor: "web", to: "o_0002" });
  await cli("project", "set", "name", "branch-four");
  expect((await get("/api/status")).head).toMatchObject({ op: "o_0004", pending: 1, detached: false });
  expect((await get("/api/history")).ops.map((op: { id: string }) => op.id)).toEqual([
    "o_0001",
    "o_0002",
    "o_0003",
    "o_0004",
  ]);
}, 15_000);

describe.each(["chokidar", "poll"] as const)("history metadata notifications (%s)", (mode) => {
  test("commit and tag changes notify clients even though project.json and ops do not change", async () => {
    await cli("init", dir);
    server = await boot(dir, { watch: mode });
    const { ws, next } = await openWs(server.url);
    try {
      const committed = next("history.appended", 3000);
      await cli("commit", "-m", "initial project");
      expect((await committed).type).toBe("history.appended");
      expect((await get("/api/status")).head.pending).toBe(0);
      const tagged = next("history.appended", 3000);
      await cli("tag", "reviewed");
      await tagged;
      expect((await get("/api/history")).tags.reviewed).toBeDefined();
      const deleted = next("history.appended", 3000);
      await cli("tag", "delete", "reviewed");
      await deleted;
      expect((await get("/api/history")).tags.reviewed).toBeUndefined();
    } finally {
      ws.close();
    }
  }, 15_000);
});
