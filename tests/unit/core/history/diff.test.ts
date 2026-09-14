import { describe, expect, test } from "bun:test";
import { applyChanges, diffJson, extractAffects, findConflicts, invertChanges, summarizeChanges } from "../../../../src/core/history/diff.ts";
import { MontashError } from "../../../../src/cli/errors.ts";
import type { Change } from "../../../../src/core/history/types.ts";

describe("diffJson", () => {
  test("等しければ空", () => {
    expect(diffJson({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });
  test("オブジェクトの add / remove / replace", () => {
    expect(diffJson({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { op: "remove", path: "/b", from: 2 },
      { op: "add", path: "/c", value: 3 },
    ]);
    expect(diffJson({ a: { x: 1 } }, { a: { x: 2 } })).toEqual([{ op: "replace", path: "/a/x", from: 1, value: 2 }]);
  });
  test("配列は index ベース。削除は降順、追加は昇順", () => {
    expect(diffJson({ l: [1, 2, 3] }, { l: [1] })).toEqual([
      { op: "remove", path: "/l/2", from: 3 },
      { op: "remove", path: "/l/1", from: 2 },
    ]);
    expect(diffJson({ l: [1] }, { l: [1, 2, 3] })).toEqual([
      { op: "add", path: "/l/1", value: 2 },
      { op: "add", path: "/l/2", value: 3 },
    ]);
  });
  test("型が変われば replace", () => {
    expect(diffJson({ a: [1] }, { a: { x: 1 } })).toEqual([{ op: "replace", path: "/a", from: [1], value: { x: 1 } }]);
    expect(diffJson(1, "x")).toEqual([{ op: "replace", path: "", from: 1, value: "x" }]);
  });
  test("キーに / や ~ が含まれてもポインタでエスケープされる", () => {
    const before = { "a/b": 1, "c~d": 2 };
    const after = { "a/b": 9, "c~d": 2 };
    const changes = diffJson(before, after);
    expect(changes).toEqual([{ op: "replace", path: "/a~1b", from: 1, value: 9 }]);
    expect(applyChanges(before, changes)).toEqual(after);
  });
});

describe("applyChanges / invertChanges", () => {
  const cases: [unknown, unknown][] = [
    [{ a: 1 }, { a: 2 }],
    [{ a: [1, 2, 3], b: { c: "x" } }, { a: [1, 9], b: { c: "x", d: [true] }, e: null }],
    [{ tracks: [{ clips: [{ id: "c1" }, { id: "c2" }] }] }, { tracks: [{ clips: [{ id: "c2" }] }, { clips: [] }] }],
    [[], [1, 2, 3]],
    [{ x: { y: { z: 1 } } }, { x: 5 }],
    [null, { a: 1 }],
  ];
  test.each(cases)("往復: apply(diff(a,b), a) == b かつ apply(invert(diff(a,b)), b) == a", (a, b) => {
    const d = diffJson(a, b);
    expect(applyChanges(a, d)).toEqual(b);
    expect(applyChanges(b, invertChanges(d))).toEqual(a);
    expect(invertChanges(invertChanges(d))).toEqual(d);
  });
  test("入力を変更しない", () => {
    const a = { l: [1, 2] };
    applyChanges(a, diffJson(a, { l: [1] }));
    expect(a).toEqual({ l: [1, 2] });
  });
  test("対象が無ければ E_PATCH_FAILED", () => {
    expect(() => applyChanges({ a: 1 }, [{ op: "replace", path: "/b", value: 1 }])).toThrow(MontashError);
    expect(() => applyChanges({ a: [] }, [{ op: "remove", path: "/a/0" }])).toThrow(/E_PATCH_FAILED|cannot remove/);
    expect(() => applyChanges({ a: 1 }, [{ op: "add", path: "/x/y", value: 1 }])).toThrow(/parent does not exist/);
  });
});

describe("findConflicts", () => {
  test("適用できないパスを列挙する", () => {
    const changes: Change[] = [
      { op: "replace", path: "/a", value: 2 },
      { op: "remove", path: "/missing" },
      { op: "add", path: "/nope/x", value: 1 },
    ];
    expect(findConflicts({ a: 1 }, changes)).toEqual(["/missing", "/nope/x"]);
    expect(findConflicts({ a: 1 }, [{ op: "replace", path: "/a", value: 3 }])).toEqual([]);
  });
});

describe("summarizeChanges", () => {
  test("件数と先頭数件を並べる", () => {
    expect(summarizeChanges([])).toBe("no changes");
    const s = summarizeChanges([
      { op: "add", path: "/a", value: 1 },
      { op: "remove", path: "/b", from: "x" },
      { op: "replace", path: "/c", from: 1, value: 2 },
    ]);
    expect(s).toContain("3 changes");
    expect(s).toContain("+ /a = 1");
    expect(s).toContain("- /b");
    expect(s).toContain("~ /c: 1 -> 2");
    const many = summarizeChanges(Array.from({ length: 8 }, (_, i) => ({ op: "add" as const, path: `/k${i}`, value: i })));
    expect(many).toContain("(+3 more)");
  });
});

describe("extractAffects", () => {
  const before = { tracks: [{ id: "V1", clips: [{ id: "c1", start_f: 0, duration_f: 100 }, { id: "c2", start_f: 100, duration_f: 50 }] }] };
  test("after の該当クリップの id と範囲を拾う", () => {
    const after = structuredClone(before);
    after.tracks[0]!.clips[1]!.start_f = 120;
    const a = extractAffects(diffJson(before, after), after, before);
    expect(a.clips).toEqual(["c2"]);
    expect(a.range_f).toEqual([100, 170]);
  });
  test("削除されたクリップは before から拾う", () => {
    const after = { tracks: [{ id: "V1", clips: [{ id: "c1", start_f: 0, duration_f: 100 }] }] };
    const a = extractAffects(diffJson(before, after), after, before);
    expect(a.clips).toEqual(["c2"]);
    expect(a.range_f).toEqual([100, 150]);
  });
  test("クリップ以外の変更は clips: [] / range_f: null", () => {
    expect(extractAffects([{ op: "replace", path: "/settings/fps", value: 1 }], {}, {})).toEqual({ clips: [], range_f: null });
    expect(extractAffects([{ op: "replace", path: "/tracks/0/clips/5/x", value: 1 }], before, before)).toEqual({ clips: [], range_f: null });
  });
});
