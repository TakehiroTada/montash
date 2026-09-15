import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MontashError } from "../../../../src/cli/errors.ts";
import { formatId, HistoryStore } from "../../../../src/core/history/store.ts";
import { tempDir } from "./helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

const opBody = {
  parent: null,
  at: "t",
  actor: "ai" as const,
  command: [],
  summary: "",
  before: "sha1:a",
  after: "sha1:b",
  changes: [],
  affects: { clips: [], range_f: null },
  commit: null,
};

describe("HistoryStore", () => {
  test("open は .montash/history と空ファイルを作る。再 open でも壊さない", async () => {
    const store = await HistoryStore.open(dir);
    expect((await readdir(store.dir)).sort()).toEqual([
      "HEAD",
      "commits.jsonl",
      "moves.jsonl",
      "objects",
      "ops.jsonl",
      "reset.json",
      "tags.json",
    ]);
    expect(await store.getHead()).toBeNull();
    await store.setHead("o_0001");
    const again = await HistoryStore.open(dir);
    expect(await again.getHead()).toBe("o_0001");
  });

  test("object は内容アドレスで重複排除される", async () => {
    const store = await HistoryStore.open(dir);
    const h1 = await store.putObject({ b: 1, a: [1, 2] });
    const h2 = await store.putObject({ a: [1, 2], b: 1 });
    expect(h1).toBe(h2);
    expect(await readdir(join(store.dir, "objects"))).toHaveLength(1);
    expect(await store.hasObject(h1)).toBe(true);
    expect(await store.hasObject("sha1:0000")).toBe(false);
    expect(await store.getObject(h1)).toEqual({ a: [1, 2], b: 1 });
    await expect(store.getObject("sha1:deadbeef")).rejects.toMatchObject({ code: "E_HISTORY_OBJECT_NOT_FOUND" });
    expect(() => store.objectPath("sha1:../evil")).toThrow(MontashError);
  });

  test("カスタムハッシュ関数を使える", async () => {
    const store = await HistoryStore.open(dir, { hash: () => "x:const" });
    expect(await store.putObject({ a: 1 })).toBe("x:const");
    expect(await readdir(join(store.dir, "objects"))).toEqual(["const.json"]);
  });

  test("appendOp / appendCommit は行数から連番を採る", async () => {
    const store = await HistoryStore.open(dir);
    const o1 = await store.appendOp(opBody);
    const o2 = await store.appendOp({ ...opBody, parent: o1.id });
    expect([o1.id, o2.id]).toEqual(["o_0001", "o_0002"]);
    const k1 = await store.appendCommit({
      parent: null,
      at: "t",
      author: "ai",
      message: "m",
      ops: [o1.id],
      head: o1.id,
      tags: [],
      stats: { ops: 1, clips_added: 0, clips_removed: 0, clips_modified: 0 },
    });
    expect(k1.id).toBe("k_0001");
    expect(await store.readOps()).toEqual([o1, o2]);
    expect(await store.readCommits()).toEqual([k1]);
    expect(formatId("o_", 12345)).toBe("o_12345");
    // 追記専用: ファイルは 2 行
    expect((await readFile(store.path("ops.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });

  test("壊れた行は E_HISTORY_CORRUPT（ファイルと行番号）", async () => {
    const store = await HistoryStore.open(dir);
    await store.appendOp(opBody);
    await appendFile(store.path("ops.jsonl"), "{not json\n");
    const err = await store.readOps().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MontashError);
    expect((err as MontashError).code).toBe("E_HISTORY_CORRUPT");
    expect((err as MontashError).detail).toMatchObject({ line: 2 });
    await writeFile(store.path("tags.json"), "[]");
    await expect(store.readTags()).rejects.toMatchObject({ code: "E_HISTORY_CORRUPT" });
  });

  test("tags と moves の読み書き", async () => {
    const store = await HistoryStore.open(dir);
    expect(await store.readTags()).toEqual({});
    await store.writeTags({ v1: { target: "o_0001", at: "t" } });
    expect(await store.readTags()).toEqual({ v1: { target: "o_0001", at: "t" } });
    await store.appendMove({ at: "t", kind: "undo", actor: "human", from: "o_0002", to: "o_0001", last_op: "o_0002" });
    expect(await store.readMoves()).toHaveLength(1);
  });
});
