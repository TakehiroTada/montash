import { describe, expect, test } from "bun:test";
import { ancestors, buildIndex, childrenOf, isAncestor, isValidTagName, pathToRoot, preferredChild, resolveRef, suggest, tipOf } from "../../../../src/core/history/dag.ts";
import { MontashError } from "../../../../src/cli/errors.ts";
import type { Commit, Move, Op } from "../../../../src/core/history/types.ts";

function op(id: string, parent: string | null): Op {
  return { id, parent, at: "t", actor: "ai", command: [], summary: id, before: `sha1:${parent ?? "root"}`, after: `sha1:${id}`, changes: [], affects: { clips: [], range_f: null }, commit: null };
}
function move(to: string, last_op: string): Move {
  return { at: "t", kind: "checkout", actor: "human", from: null, to, last_op };
}

//  o1 - o2 - o3 - o4
//        \- o5 - o6
const ops = [op("o_0001", null), op("o_0002", "o_0001"), op("o_0003", "o_0002"), op("o_0004", "o_0003"), op("o_0005", "o_0002"), op("o_0006", "o_0005")];
const index = buildIndex(ops);
const commits: Commit[] = [
  { id: "k_0001", parent: null, at: "t", author: "ai", message: "first", ops: ["o_0001", "o_0002"], head: "o_0002", tags: [], stats: { ops: 2, clips_added: 0, clips_removed: 0, clips_modified: 0 } },
  { id: "k_0002", parent: "k_0001", at: "t", author: "ai", message: "second", ops: ["o_0003", "o_0004"], head: "o_0004", tags: [], stats: { ops: 2, clips_added: 0, clips_removed: 0, clips_modified: 0 } },
];
const tags = { "before-bgm": { target: "o_0003", at: "t" }, release: { target: "k_0001", at: "t" } };
const ctx = { ops, commits, tags, head: "o_0004" };

describe("buildIndex / 走査", () => {
  test("children / roots / pathToRoot / ancestors / isAncestor", () => {
    expect(index.roots).toEqual(["o_0001"]);
    expect(childrenOf(index, "o_0002")).toEqual(["o_0003", "o_0005"]);
    expect(pathToRoot(index, "o_0006")).toEqual(["o_0006", "o_0005", "o_0002", "o_0001"]);
    expect(ancestors(index, "o_0004")).toEqual(["o_0003", "o_0002", "o_0001"]);
    expect(isAncestor(index, "o_0002", "o_0006")).toBe(true);
    expect(isAncestor(index, "o_0003", "o_0006")).toBe(false);
    expect(isAncestor(index, "o_0003", "o_0003")).toBe(false);
  });
});

describe("tipOf / preferredChild", () => {
  test("moves が無ければ最後に作られた子（o5 系列）", () => {
    expect(tipOf(index, "o_0001", [])).toBe("o_0006");
    expect(preferredChild(index, "o_0002", []).candidates).toEqual(["o_0003", "o_0005"]);
  });
  test("最後に HEAD だった系列を優先する", () => {
    // o6 作成後に o4 へ checkout → o3 系列が最後の HEAD
    expect(tipOf(index, "o_0002", [move("o_0004", "o_0006")])).toBe("o_0004");
    // その後 o5 へ checkout → o5 系列
    expect(tipOf(index, "o_0002", [move("o_0004", "o_0006"), move("o_0005", "o_0006")])).toBe("o_0006");
    // move が o6 作成より前（last_op = o5）なら op 作成の方が新しい
    expect(tipOf(index, "o_0002", [move("o_0003", "o_0005")])).toBe("o_0006");
  });
  test("葉ならそのまま", () => {
    expect(tipOf(index, "o_0004", [])).toBe("o_0004");
  });
});

describe("resolveRef", () => {
  test("op / commit / tag / HEAD / tip", () => {
    expect(resolveRef("o_0003", ctx).op).toBe("o_0003");
    expect(resolveRef("k_0001", ctx)).toMatchObject({ op: "o_0002", via: "commit", commit: "k_0001" });
    expect(resolveRef("before-bgm", ctx)).toMatchObject({ op: "o_0003", via: "tag", tag: "before-bgm" });
    expect(resolveRef("release", ctx)).toMatchObject({ op: "o_0002", via: "tag", tag: "release", commit: "k_0001" });
    expect(resolveRef("HEAD", ctx)).toMatchObject({ op: "o_0004", via: "HEAD" });
    expect(resolveRef("tip", { ...ctx, head: "o_0002", moves: [move("o_0004", "o_0006")] }).op).toBe("o_0004");
  });
  test("~n", () => {
    expect(resolveRef("HEAD~2", ctx)).toMatchObject({ op: "o_0002", back: 2 });
    expect(resolveRef("HEAD~", ctx).op).toBe("o_0003");
    expect(resolveRef("~1", ctx).op).toBe("o_0003");
    expect(resolveRef("k_0001~1", ctx)).toMatchObject({ op: "o_0001", via: "commit", back: 1 });
    expect(resolveRef("before-bgm~1", ctx).op).toBe("o_0002");
    expect(resolveRef("o_0006~2", ctx).op).toBe("o_0002");
  });
  test("根を越える ~n はエラー", () => {
    const err = catchErr(() => resolveRef("HEAD~4", ctx));
    expect(err.code).toBe("E_HISTORY_REF_NOT_FOUND");
    expect(err.detail).toMatchObject({ available: 3 });
  });
  test("不明な参照は候補付きの E_HISTORY_REF_NOT_FOUND", () => {
    const err = catchErr(() => resolveRef("before-bg", ctx));
    expect(err.code).toBe("E_HISTORY_REF_NOT_FOUND");
    expect(err.detail?.candidates).toEqual(["before-bgm"]);
    expect(err.hint).toContain("before-bgm");
    const err2 = catchErr(() => resolveRef("o_0099", ctx));
    expect(err2.code).toBe("E_HISTORY_REF_NOT_FOUND");
    expect((err2.detail?.candidates as string[]).length).toBeGreaterThan(0);
    const err3 = catchErr(() => resolveRef("k_0009", ctx));
    expect(err3.detail?.candidates).toContain("k_0001");
  });
  test("HEAD が無ければエラー", () => {
    expect(catchErr(() => resolveRef("HEAD", { ...ctx, head: null })).code).toBe("E_HISTORY_REF_NOT_FOUND");
    expect(catchErr(() => resolveRef("tip", { ...ctx, head: null })).code).toBe("E_HISTORY_REF_NOT_FOUND");
  });
});

describe("suggest / isValidTagName", () => {
  test("前方一致・部分一致・編集距離", () => {
    expect(suggest("o_00", ["o_0001", "o_0002", "k_0001"])).toEqual(["o_0001", "o_0002"]);
    expect(suggest("relaese", ["release", "draft"])).toEqual(["release"]);
    expect(suggest("zzz", ["release"])).toEqual([]);
  });
  test("予約語や ID 形式はタグ名にできない", () => {
    expect(isValidTagName("v1")).toBe(true);
    expect(isValidTagName("HEAD")).toBe(false);
    expect(isValidTagName("tip")).toBe(false);
    expect(isValidTagName("o_0001")).toBe(false);
    expect(isValidTagName("k_0001")).toBe(false);
    expect(isValidTagName("a~1")).toBe(false);
    expect(isValidTagName("")).toBe(false);
  });
});

function catchErr(fn: () => unknown): MontashError {
  try {
    fn();
  } catch (e) {
    if (e instanceof MontashError) return e;
    throw e;
  }
  throw new Error("expected an error");
}
