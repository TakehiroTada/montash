import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunningServer } from "../../../src/server/index.ts";
import { chooseMode, hashProjectFile } from "../../../src/server/watcher.ts";
import { boot, makeTempProject, openWs, removeTemp, SAMPLE_PROJECT } from "./helpers.ts";

test("hashProjectFile is sha1 of the file contents", () => {
  const dir = makeTempProject();
  try {
    const p = join(dir, "project.json");
    const expected = `sha1:${new Bun.CryptoHasher("sha1").update(JSON.stringify(SAMPLE_PROJECT)).digest("hex")}`;
    expect(hashProjectFile(p)).toBe(expected);
    expect(hashProjectFile(join(dir, "missing.json"))).toBeNull();
  } finally {
    removeTemp(dir);
  }
});

test("chooseMode honours an explicit request", () => {
  expect(chooseMode("/tmp/x", "poll")).toBe("poll");
  expect(chooseMode("/tmp/x", "chokidar")).toBe("chokidar");
});

describe.each(["chokidar", "poll"] as const)("WebSocket + watcher (%s)", (mode) => {
  let dir: string;
  let srv: RunningServer;
  beforeAll(async () => {
    dir = makeTempProject();
    srv = await boot(dir, { watch: mode });
  });
  afterAll(async () => {
    await srv.stop();
    removeTemp(dir);
  });

  test("hello on connect, project.changed within 2s of a write, history.appended on ops.jsonl append", async () => {
    expect(srv.watcher?.mode).toBe(mode);
    const { ws, hello, next } = await openWs(srv.url);
    try {
      expect(hello).toMatchObject({ type: "hello", version: expect.any(String) });
      const status = (await (await fetch(`${srv.url}/api/status`)).json()) as { watching: boolean; watch_mode: string };
      expect(status.watching).toBe(true);
      expect(status.watch_mode).toBe(mode);

      // 監視開始直後の書き込みは取り逃がすことがあるので少し待つ
      await Bun.sleep(150);
      const updated = { ...SAMPLE_PROJECT, name: "renamed" };
      writeFileSync(join(dir, "project.json"), JSON.stringify(updated));
      const changed = await next("project.changed", 2000);
      expect(changed).toMatchObject({ type: "project.changed", cause: "external", head: null });
      expect(changed.hash).toBe(`sha1:${new Bun.CryptoHasher("sha1").update(JSON.stringify(updated)).digest("hex")}`);

      // tmp → rename の原子的保存も検知する
      await Bun.sleep(150);
      const updated2 = { ...SAMPLE_PROJECT, name: "atomic" };
      writeFileSync(join(dir, "project.json.tmp"), JSON.stringify(updated2));
      renameSync(join(dir, "project.json.tmp"), join(dir, "project.json"));
      const changed2 = await next("project.changed", 2000);
      expect(changed2.hash).toBe(`sha1:${new Bun.CryptoHasher("sha1").update(JSON.stringify(updated2)).digest("hex")}`);

      appendFileSync(join(dir, ".montash/history/ops.jsonl"), `${JSON.stringify({ id: "o_0001" })}\n`);
      expect(await next("history.appended", 2000)).toMatchObject({ type: "history.appended" });
    } finally {
      ws.close();
    }
  }, 10_000);
});
