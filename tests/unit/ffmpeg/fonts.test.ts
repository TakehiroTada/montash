/**
 * フォント列挙（docs/04 §4 `fonts list`）。純関数は単体で、列挙は実機の結果で検査する。
 */
import { describe, expect, test } from "bun:test";
import {
  type FontEntry,
  familyFromFilename,
  filterFonts,
  fontDirectories,
  isCjkFamily,
  listFonts,
  parseFcListLine,
  preferredName,
} from "../../../src/ffmpeg/fonts.ts";

describe("isCjkFamily", () => {
  test("flags families that are likely to carry Japanese glyphs", () => {
    for (const family of [
      "Noto Sans CJK JP",
      "Noto Sans JP",
      "Hiragino Kaku Gothic ProN",
      "YuGothic",
      "Yu Mincho",
      "Meiryo",
      "IPAexGothic",
      "TakaoPGothic",
      "Source Han Sans",
      "ヒラギノ角ゴ ProN",
      "游ゴシック体",
    ])
      expect(isCjkFamily(family)).toBe(true);
  });

  test("leaves plain latin families alone", () => {
    for (const family of ["Helvetica", "Arial", "DejaVu Sans", "Times New Roman", "Courier"])
      expect(isCjkFamily(family)).toBe(false);
  });
});

describe("parseFcListLine", () => {
  test('parses "<path>: <family>:style=<styles>"', () => {
    const entry = parseFcListLine("/System/Library/Fonts/Helvetica.ttc: Helvetica:style=Regular,標準");
    expect(entry).toMatchObject({ family: "Helvetica", style: "Regular", path: "/System/Library/Fonts/Helvetica.ttc" });
  });

  test('parses "<family>:style=<styles>:file=<path>"', () => {
    const entry = parseFcListLine("Noto Sans JP:style=Bold:file=/usr/share/fonts/NotoSansJP-Bold.otf");
    expect(entry).toMatchObject({
      family: "Noto Sans JP",
      style: "Bold",
      path: "/usr/share/fonts/NotoSansJP-Bold.otf",
    });
  });

  test("prefers the ASCII family name and keeps the localized ones as aliases", () => {
    const entry = parseFcListLine(
      "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc: ヒラギノ角ゴ ProN,Hiragino Kaku Gothic ProN:style=W3,Regular",
    );
    expect(entry?.family).toBe("Hiragino Kaku Gothic ProN");
    expect(entry?.style).toBe("W3");
    expect(entry?.aliases).toContain("ヒラギノ角ゴ ProN");
  });

  test("ignores blank and unparsable lines", () => {
    expect(parseFcListLine("")).toBeNull();
    expect(parseFcListLine("   ")).toBeNull();
    expect(parseFcListLine("nonsense")).toBeNull();
  });
});

describe("helpers", () => {
  test("preferredName picks the first ASCII alias", () => {
    expect(preferredName("ヒラギノ明朝 ProN,Hiragino Mincho ProN")).toEqual({
      name: "Hiragino Mincho ProN",
      aliases: ["ヒラギノ明朝 ProN", "Hiragino Mincho ProN"],
    });
    expect(preferredName("Arial").name).toBe("Arial");
  });

  test("familyFromFilename splits a trailing style", () => {
    expect(familyFromFilename("/x/NotoSansJP-Bold.otf")).toEqual({ family: "NotoSansJP", style: "Bold" });
    expect(familyFromFilename("/x/Verdana.ttf")).toEqual({ family: "Verdana", style: "Regular" });
  });

  test("fontDirectories follows the platform", () => {
    expect(fontDirectories("darwin", "/Users/me")).toEqual([
      "/System/Library/Fonts",
      "/Library/Fonts",
      "/Users/me/Library/Fonts",
    ]);
    expect(fontDirectories("linux", "/home/me")).toContain("/home/me/.local/share/fonts");
  });

  test("filterFonts matches the family case-insensitively", () => {
    const fonts: FontEntry[] = [
      { family: "Noto Sans JP", style: "Regular", path: "/a.otf", cjk: true },
      { family: "Helvetica", style: "Regular", path: "/b.ttc", cjk: false },
    ];
    expect(filterFonts(fonts, "noto").map((f) => f.family)).toEqual(["Noto Sans JP"]);
    expect(filterFonts(fonts, "SANS").map((f) => f.family)).toEqual(["Noto Sans JP"]);
    expect(filterFonts(fonts)).toHaveLength(2);
    expect(filterFonts(fonts, "nothing")).toHaveLength(0);
  });
});

describe("listFonts", () => {
  test("finds fonts on this machine and narrows them with --filter", async () => {
    const all = await listFonts();
    expect(all.fonts.length).toBeGreaterThan(0);
    for (const font of all.fonts) {
      expect(font.family).not.toBe("");
      expect(font.path).toStartWith("/");
      expect(typeof font.cjk).toBe("boolean");
    }
    const needle = all.fonts[0]!.family.slice(0, 3).toLowerCase();
    const filtered = await listFonts({ filter: needle });
    expect(filtered.fonts.length).toBeGreaterThan(0);
    expect(filtered.fonts.length).toBeLessThanOrEqual(all.fonts.length);
    expect(filtered.fonts.every((f) => f.family.toLowerCase().includes(needle))).toBe(true);
  }, 20_000);

  test("falls back to directory scanning when fc-list is not used", async () => {
    const scanned = await listFonts({ scanOnly: true });
    expect(scanned.source).toBe("scan");
    expect(scanned.fonts.length).toBeGreaterThan(0);
  }, 20_000);
});
