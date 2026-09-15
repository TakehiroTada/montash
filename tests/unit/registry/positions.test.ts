/**
 * 位置プリセットのレジストリ（docs/07 §5, §6.2、docs/13 D-16）。
 *
 * overlay の座標式と ASS の `\an` が **1 つのレジストリ**になり、overlay とテキストで
 * 同じ名前集合を受け付けることを固定する。旧テーブルの値からの回帰も見る。
 */
import { describe, expect, test } from "bun:test";
import { alignmentOf } from "../../../src/ffmpeg/ass.ts";
import { overlayPosition } from "../../../src/ffmpeg/graph/overlay.ts";
import { anOf, POSITION_ALIASES, POSITION_NAMES, positions } from "../../../src/registry/positions.ts";

const HD = { width: 1920, height: 1080 };
const transform = (position: string | null) => ({
  position,
  x: null,
  y: null,
  margin: 24,
  scale: 1,
  rotate: 0,
});

/** 統合前の `graph/overlay.ts` の PRESETS（9 種） */
const LEGACY_OVERLAY: Record<string, (m: string) => { x: string; y: string }> = {
  "top-left": (m) => ({ x: m, y: m }),
  "top-center": (m) => ({ x: "(W-w)/2", y: m }),
  "top-right": (m) => ({ x: `W-w-${m}`, y: m }),
  "center-left": (m) => ({ x: m, y: "(H-h)/2" }),
  center: () => ({ x: "(W-w)/2", y: "(H-h)/2" }),
  "center-right": (m) => ({ x: `W-w-${m}`, y: "(H-h)/2" }),
  "bottom-left": (m) => ({ x: m, y: `H-h-${m}` }),
  "bottom-center": (m) => ({ x: "(W-w)/2", y: `H-h-${m}` }),
  "bottom-right": (m) => ({ x: `W-w-${m}`, y: `H-h-${m}` }),
};

/** 統合前の `ffmpeg/ass.ts` の POSITION_PRESETS（10 種） */
const LEGACY_AN: Record<string, number> = {
  center: 5,
  "middle-center": 5,
  "middle-left": 4,
  "middle-right": 6,
  "top-left": 7,
  "top-center": 8,
  "top-right": 9,
  "bottom-left": 1,
  "bottom-center": 2,
  "bottom-right": 3,
};

describe("位置プリセットのレジストリ", () => {
  test("正規名 9 種 + 別名 3 種を持ち、全エントリが overlay 式と \\an の両方を持つ", () => {
    expect([...POSITION_NAMES]).toEqual([
      "top-left",
      "top-center",
      "top-right",
      "middle-left",
      "center",
      "middle-right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ]);
    expect([...POSITION_ALIASES].sort()).toEqual(["center-left", "center-right", "middle-center"]);
    expect(positions.names().length).toBe(12);
    for (const name of positions.names()) {
      const spec = positions.get(name);
      expect(typeof spec?.an).toBe("number");
      expect(typeof spec?.overlay).toBe("function");
    }
  });

  test("overlay とテキストが同じ名前集合を受け付ける", () => {
    const known = positions.names().sort();
    // overlay 側: overlayPosition が投げない名前
    const overlayNames = known.filter((name) => {
      try {
        overlayPosition(transform(name), HD);
        return true;
      } catch {
        return false;
      }
    });
    // テキスト側: alignmentOf が投げない名前
    const textNames = known.filter((name) => {
      try {
        alignmentOf(name, "center", HD);
        return true;
      } catch {
        return false;
      }
    });
    expect(overlayNames).toEqual(known);
    expect(textNames).toEqual(known);
  });

  test("別名は正規名と同じ値を指す", () => {
    for (const alias of POSITION_ALIASES) {
      const spec = positions.get(alias);
      const canonical = positions.get(spec?.aliasOf ?? "");
      expect(spec?.aliasOf).toBeString();
      expect(spec?.an).toBe(canonical?.an as number);
      expect(spec?.row).toBe(canonical?.row as "top" | "middle" | "bottom");
      expect(spec?.overlay("24")).toEqual(canonical?.overlay("24") as { x: string; y: string });
    }
  });

  test("\\an は行・列から導かれ、統合前のテーブルと一致する", () => {
    expect(anOf("top", "left")).toBe(7);
    expect(anOf("middle", "center")).toBe(5);
    expect(anOf("bottom", "right")).toBe(3);
    for (const [name, an] of Object.entries(LEGACY_AN)) expect(positions.get(name)?.an).toBe(an);
  });

  test("overlay の座標式が統合前のテーブルと一致する", () => {
    for (const [name, expr] of Object.entries(LEGACY_OVERLAY)) {
      expect(positions.get(name)?.overlay("24")).toEqual(expr("24"));
      expect(overlayPosition(transform(name), HD)).toEqual(expr("24"));
    }
    // position 未指定は center と同じ
    expect(overlayPosition(transform(null), HD)).toEqual({ x: "(W-w)/2", y: "(H-h)/2" });
  });

  test("未知名は E_USAGE（hint に正規名の一覧）", () => {
    expect(() => overlayPosition(transform("nowhere"), HD)).toThrow(/unknown position preset/);
    expect(() => alignmentOf("nowhere", "center", HD)).toThrow(/invalid position/);
    expect(positions.get("nowhere")).toBeUndefined();
  });
});
