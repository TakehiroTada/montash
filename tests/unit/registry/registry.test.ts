/**
 * 拡張点レジストリの共通基盤（docs/13 D-16、計画 P0-4）。
 * 「組み込み + 外部由来のマージ + 出自ラベル」の意味論を固定する。
 */
import { describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import { createRegistry } from "../../../src/registry/index.ts";

interface Spec {
  size?: number;
  color?: string;
  base?: string;
}

const builtin = {
  b1: { size: 10, color: "red" },
  b2: { size: 20 },
} satisfies Record<string, Spec>;

const make = () => createRegistry<Spec>({ label: "demo preset", builtin });

describe("createRegistry", () => {
  test("組み込みだけなら登録順・source は builtin", () => {
    const r = make();
    expect(r.names()).toEqual(["b1", "b2"]);
    expect(r.get("b1")).toEqual({ size: 10, color: "red" });
    expect(r.entries().map((e) => [e.name, e.source, e.overridden])).toEqual([
      ["b1", "builtin", false],
      ["b2", "builtin", false],
    ]);
  });

  test("外部由来は後勝ちで浅くマージされ、組み込みを置き換えたら overridden", () => {
    const resolved = make().resolve({ b1: { size: 99 }, extra: { size: 1 } });
    // 組み込みの color は残り、size だけ後勝ち
    expect(resolved.get("b1")).toEqual({ size: 99, color: "red" });
    expect(resolved.entry("b1")).toMatchObject({ source: "project", overridden: true });
    // 追加は project かつ overridden ではない
    expect(resolved.entry("extra")).toMatchObject({ source: "project", overridden: false });
    // 触っていない組み込みは builtin のまま
    expect(resolved.entry("b2")).toMatchObject({ source: "builtin", overridden: false });
  });

  test("並びは組み込み順 → 外部由来の追加順（sorted なら名前順）", () => {
    expect(make().resolve({ aaa: {}, b1: {} }).names()).toEqual(["b1", "b2", "aaa"]);
    const sorted = createRegistry<Spec>({ label: "demo preset", builtin, sorted: true });
    expect(sorted.resolve({ aaa: {}, b1: {} }).names()).toEqual(["aaa", "b1", "b2"]);
    expect(Object.keys(sorted.resolve({ aaa: {} }).record())).toEqual(["aaa", "b1", "b2"]);
  });

  test("レジストリ自体は resolve で変化しない", () => {
    const r = make();
    r.resolve({ b1: { size: 99 }, extra: {} });
    expect(r.names()).toEqual(["b1", "b2"]);
    expect(r.get("b1")).toEqual({ size: 10, color: "red" });
  });

  test("register で足せる（plugin 由来の出自ラベルは Phase 2 用に型だけ用意してある）", () => {
    const r = make();
    r.register("p1", { size: 5 }, "plugin");
    expect(r.entry("p1")).toMatchObject({ source: "plugin", overridden: false });
    expect(r.resolve().names()).toEqual(["b1", "b2", "p1"]);
  });

  test("未知名は notFound（既定は E_PRESET_NOT_FOUND、一覧つき）", () => {
    const r = make();
    expect(() => r.require("nope")).toThrow(MontashError);
    try {
      r.require("nope");
    } catch (e) {
      const err = e as MontashError;
      expect(err.code).toBe("E_PRESET_NOT_FOUND");
      expect(err.message).toContain("demo preset");
      expect(err.hint).toContain("b1, b2");
    }
    // 差し替えた notFound が使われる
    const custom = createRegistry<Spec>({
      label: "demo preset",
      builtin,
      notFound: (name, known) => new MontashError("E_USAGE", `missing ${name} of ${known.join("/")}`),
    });
    expect(() => custom.require("nope")).toThrow(/missing nope of b1\/b2/);
  });

  test("merge の ctx.resolve で相互参照でき、循環は loop のエラー", () => {
    const r = createRegistry<Spec>({
      label: "demo preset",
      builtin,
      merge: (_base, raw, ctx) => {
        const spec = raw as Spec;
        const from = typeof spec.base === "string" ? ctx.resolve(spec.base) : {};
        return { ...from, ...spec };
      },
    });
    expect(r.resolve({ child: { base: "b1", size: 30 } }).get("child")).toEqual({
      size: 30,
      color: "red",
      base: "b1",
    });
    // 未知の base は notFound
    expect(() => r.resolve({ child: { base: "nope" } })).toThrow(/E_PRESET_NOT_FOUND|unknown demo preset/);
    // 循環
    expect(() => r.resolve({ a: { base: "b" }, b: { base: "a" } })).toThrow(/base loop/);
    // 自分自身を base にした組み込みの上書きも循環
    expect(() => r.resolve({ b1: { base: "b1" } })).toThrow(/base loop/);
  });

  test("allowedKeys で許可キーを制限できる", () => {
    const r = createRegistry<Spec>({ label: "demo preset", builtin, allowedKeys: ["size", "base"] });
    expect(() => r.resolve({ x: { size: 1 } })).not.toThrow();
    try {
      r.resolve({ x: { size: 1, nope: 2, bad: 3 } });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as MontashError;
      expect(err.code).toBe("E_USAGE");
      expect(err.message).toContain("nope, bad");
      expect(err.hint).toContain("size, base");
    }
  });
});
