import { describe, expect, test } from "bun:test";
import { canonicalHash, canonicalJson } from "../../../../src/core/history/hash.ts";

describe("canonicalJson", () => {
  test("キー順に依存しない", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  test("配列の順序は保つ・undefined は省く", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
  });
});

describe("canonicalHash", () => {
  test("sha1: プレフィックス付き 40 桁 hex", () => {
    const h = canonicalHash({ a: 1 });
    expect(h).toMatch(/^sha1:[0-9a-f]{40}$/);
    expect(canonicalHash({ a: 1 })).toBe(h);
    expect(canonicalHash({ a: 2 })).not.toBe(h);
  });
  test("既知の値: sha1('{}')", () => {
    expect(canonicalHash({})).toBe("sha1:bf21a9e8fbc5a3846fb05b4fa0859e0917b2202f");
  });
});
