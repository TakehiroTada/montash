/**
 * ASS 生成の純関数テスト（docs/07 §6）。ffmpeg は起動しない（実機確認は ass-burn.test.ts）。
 */
import { describe, expect, test } from "bun:test";
import type { Fps, Resolution } from "../../../src/core/schema.ts";
import {
  alignmentOf,
  assColor,
  assEscape,
  assTime,
  buildAssDocument,
  defaultAlignFor,
  fontFamiliesOf,
  resolveCoordinate,
  scaleColorAlpha,
  subtitlesFilter,
  type TextClipLike,
} from "../../../src/ffmpeg/ass.ts";

const HD: Resolution = { width: 1920, height: 1080 };
const F2997: Fps = { num: 30000, den: 1001 };
const F30: Fps = { num: 30, den: 1 };
const F60: Fps = { num: 60, den: 1 };

// ---------------------------------------------------------------------------
// 色
// ---------------------------------------------------------------------------

describe("assColor", () => {
  test("#RRGGBB は不透明（AA=00）の &HAABBGGRR になる", () => {
    expect(assColor("#FFFFFF")).toBe("&H00FFFFFF");
    expect(assColor("#000000")).toBe("&H00000000");
  });

  test("RGB の順序が BGR に入れ替わる", () => {
    expect(assColor("#123456")).toBe("&H00563412");
    expect(assColor("#FF0000")).toBe("&H000000FF");
    expect(assColor("#0000FF")).toBe("&H00FF0000");
  });

  test("アルファは反転する（ASS は 00 が不透明）", () => {
    expect(assColor("#00000080")).toBe("&H7F000000");
    expect(assColor("#FFFFFFFF")).toBe("&H00FFFFFF");
    expect(assColor("#FFFFFF00")).toBe("&HFFFFFFFF");
    expect(assColor("#00000099")).toBe("&H66000000");
  });

  test("先頭の # は省略でき、小文字も受理する", () => {
    expect(assColor("aabbcc")).toBe("&H00CCBBAA");
  });

  test("不正な色は E_USAGE", () => {
    expect(() => assColor("#12345")).toThrow(/invalid color/);
    expect(() => assColor("red")).toThrow(/invalid color/);
  });

  test("scaleColorAlpha は style.alpha を色のアルファに掛ける", () => {
    expect(scaleColorAlpha("#FFFFFF", 0.5)).toBe("#FFFFFF80");
    expect(scaleColorAlpha("#FFFFFF", 1)).toBe("#FFFFFFFF");
    expect(scaleColorAlpha("#00000080", 0.5)).toBe("#00000040");
    expect(assColor(scaleColorAlpha("#FFFFFF", 0))).toBe("&HFFFFFFFF");
  });
});

// ---------------------------------------------------------------------------
// エスケープ
// ---------------------------------------------------------------------------

describe("assEscape", () => {
  test("plain は { } \\ をエスケープする", () => {
    expect(assEscape("{\\b1}", "plain")).toBe("\\{\\\\b1\\}");
    expect(assEscape("a{b}c", "plain")).toBe("a\\{b\\}c");
  });

  test("ass は本文をそのまま通す", () => {
    expect(assEscape("{\\b1}強調{\\b0}", "ass")).toBe("{\\b1}強調{\\b0}");
  });

  test("改行は \\N になる（ass でも Dialogue は 1 行）", () => {
    expect(assEscape("a\nb", "plain")).toBe("a\\Nb");
    expect(assEscape("a\r\nb", "plain")).toBe("a\\Nb");
    expect(assEscape("a\nb", "ass")).toBe("a\\Nb");
  });

  test("行頭の空白は \\h になる", () => {
    expect(assEscape("  indented", "plain")).toBe("\\h\\hindented");
    expect(assEscape("a\n  b", "plain")).toBe("a\\N\\h\\hb");
    expect(assEscape("a b", "plain")).toBe("a b");
  });
});

// ---------------------------------------------------------------------------
// 時刻
// ---------------------------------------------------------------------------

/** "0:00:12.51" → 1251（センチ秒） */
function parseAssTime(text: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(text);
  if (!m) throw new Error(`unexpected ASS time: ${text}`);
  return Number(m[1]) * 360000 + Number(m[2]) * 6000 + Number(m[3]) * 100 + Number(m[4]);
}

describe("assTime", () => {
  test("29.97fps の f:375 は 12.5125 秒 → start は floor", () => {
    expect(assTime(375, F2997, "start")).toBe("0:00:12.51");
  });

  test("end は ceil", () => {
    expect(assTime(375, F2997, "end")).toBe("0:00:12.52");
    // 割り切れる時刻は floor と ceil が一致する
    expect(assTime(0, F2997, "start")).toBe("0:00:00.00");
    expect(assTime(0, F2997, "end")).toBe("0:00:00.00");
    expect(assTime(30, F30, "end")).toBe("0:00:01.00");
  });

  test("時・分・秒の桁が繰り上がる", () => {
    expect(assTime(30 * 60 * 61 + 30 * 2, F30, "start")).toBe("1:01:02.00");
  });

  test("丸めが隣接フレームに漏れない（1 フレーム > 1 センチ秒）", () => {
    for (const fps of [F2997, F30, F60]) {
      for (let f = 0; f < 400; f++) {
        const end = parseAssTime(assTime(f, fps, "end"));
        const nextStart = parseAssTime(assTime(f + 1, fps, "start"));
        // f で終わるクリップの End は、次のフレーム f+1 の表示開始に届かない
        expect(end).toBeLessThanOrEqual(nextStart);
        expect(parseAssTime(assTime(f, fps, "start"))).toBeLessThanOrEqual(end);
      }
    }
  });

  test("負のフレームは E_INVALID_TIME", () => {
    expect(() => assTime(-1, F30, "start")).toThrow(/non-negative/);
  });
});

// ---------------------------------------------------------------------------
// 位置・配置
// ---------------------------------------------------------------------------

describe("alignmentOf", () => {
  test("プリセットはテンキー配置に対応する", () => {
    expect(alignmentOf("center", "center", HD).an).toBe(5);
    expect(alignmentOf("top-left", "left", HD).an).toBe(7);
    expect(alignmentOf("top-center", "center", HD).an).toBe(8);
    expect(alignmentOf("top-right", "right", HD).an).toBe(9);
    expect(alignmentOf("middle-left", "left", HD).an).toBe(4);
    expect(alignmentOf("middle-right", "right", HD).an).toBe(6);
    expect(alignmentOf("bottom-left", "left", HD).an).toBe(1);
    expect(alignmentOf("bottom-center", "center", HD).an).toBe(2);
    expect(alignmentOf("bottom-right", "right", HD).an).toBe(3);
  });

  test("center は \\pos(W/2, H/2) を伴う", () => {
    expect(alignmentOf("center", "center", HD).pos).toEqual({ x: 960, y: 540 });
    expect(alignmentOf("bottom-center", "center", HD).pos).toBeUndefined();
  });

  test("行はプリセット、列は align が決める", () => {
    expect(alignmentOf("bottom-center", "left", HD).an).toBe(1);
    expect(alignmentOf("top-center", "right", HD).an).toBe(9);
  });

  test("端に寄るプリセットは Margin を持つ", () => {
    expect(alignmentOf("bottom-center", "center", HD).margins).toEqual({ l: 96, r: 96, v: 54 });
    expect(alignmentOf("middle-left", "left", HD).margins.v).toBe(0);
  });

  test("{x,y} は左上基準（align で \\an7/8/9）+ \\pos", () => {
    expect(alignmentOf({ x: 100, y: 50 }, "left", HD)).toEqual({
      an: 7,
      pos: { x: 100, y: 50 },
      margins: { l: 0, r: 0, v: 0 },
    });
    expect(alignmentOf({ x: 100, y: 50 }, "center", HD).an).toBe(8);
    expect(alignmentOf({ x: 100, y: 50 }, "right", HD).an).toBe(9);
  });

  test("% は W/H から px に解決する", () => {
    expect(alignmentOf({ x: "5%", y: "85%" }, "left", HD).pos).toEqual({ x: 96, y: 918 });
    expect(alignmentOf({ x: "50%", y: "50%" }, "left", { width: 640, height: 360 }).pos).toEqual({ x: 320, y: 180 });
    expect(resolveCoordinate("12.5%", 1920)).toBe(240);
    expect(resolveCoordinate(37, 1920)).toBe(37);
  });

  test("未知のプリセットは E_USAGE", () => {
    expect(() => alignmentOf("nowhere", "center", HD)).toThrow(/invalid position/);
  });

  test("既定の揃えは位置から決まる", () => {
    expect(defaultAlignFor("top-left")).toBe("left");
    expect(defaultAlignFor("bottom-right")).toBe("right");
    expect(defaultAlignFor("center")).toBe("center");
    expect(defaultAlignFor({ x: 10, y: 10 })).toBe("left");
    expect(defaultAlignFor(undefined)).toBe("center");
  });
});

// ---------------------------------------------------------------------------
// 文書
// ---------------------------------------------------------------------------

const title: TextClipLike = {
  id: "x1",
  start_f: 0,
  duration_f: 90,
  text: "Summer Trip 2026",
  style: {
    preset: "title-center",
    font: "Noto Sans CJK JP",
    size: 96,
    color: "#FFFFFF",
    position: "center",
    align: "center",
    outline: { width: 2, color: "#000000" },
    bg: null,
  },
  fade: { in_f: 15, out_f: 15 },
};

const build = (clips: TextClipLike[], over: Partial<Parameters<typeof buildAssDocument>[1]> = {}) =>
  buildAssDocument(clips, { resolution: HD, fps: F2997, defaultFont: "Noto Sans CJK JP", ...over });

describe("buildAssDocument", () => {
  test("1 クリップ（タイトル + フェード）", () => {
    const doc = build([title]);
    expect(doc).toMatchSnapshot();
    expect(doc).toContain("PlayResX: 1920");
    expect(doc).toContain("PlayResY: 1080");
    expect(doc).toContain("WrapStyle: 0");
    expect(doc).toContain("ScaledBorderAndShadow: yes");
    // Style 名 = クリップ ID、BorderStyle=1（背景なし）、Outline=2、Alignment=5
    expect(doc).toContain(
      "Style: x1,Noto Sans CJK JP,96,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,",
    );
    // 29.97fps: 15 フレーム = 500.5ms → 501ms、90 フレーム = 3.003s → End は ceil で 3.01
    expect(doc).toContain("{\\pos(960,540)\\fad(501,501)}Summer Trip 2026");
    expect(doc).toContain("Dialogue: 0,0:00:00.00,0:00:03.01,x1,,0,0,0,,");
  });

  test("複数クリップは Style も Dialogue も 1 つずつ増える", () => {
    const second: TextClipLike = {
      id: "x2",
      start_f: 360,
      duration_f: 90,
      text: "福岡到着",
      style: { size: 48, position: { x: "5%", y: "85%" }, align: "left", bg: "#00000099", bg_padding: 12 },
    };
    const doc = build([title, second]);
    expect(doc).toMatchSnapshot();
    expect(doc.split("\n").filter((l) => l.startsWith("Style: "))).toHaveLength(2);
    expect(doc.split("\n").filter((l) => l.startsWith("Dialogue: "))).toHaveLength(2);
    expect(doc).toContain("Dialogue: 0,0:00:12.01,0:00:15.02,x2,");
  });

  test("背景ボックスは BorderStyle=4、padding は Outline、色は反転アルファ", () => {
    const doc = build([
      { id: "x1", start_f: 0, duration_f: 30, text: "caption", style: { bg: "#00000080", bg_padding: 16 } },
    ]);
    const style = doc.split("\n").find((l) => l.startsWith("Style: x1"));
    expect(style).toContain("&H7F000000,&H7F000000"); // OutlineColour / BackColour = 背景色
    expect(style?.split(",")[15]).toBe("4"); // BorderStyle
    expect(style?.split(",")[16]).toBe("16"); // Outline = padding
  });

  test("borderStyle=3 にフォールバックできる", () => {
    const doc = build([{ id: "x1", start_f: 0, duration_f: 30, text: "x", style: { bg: "#000000" } }], {
      borderStyle: 3,
    });
    expect(
      doc
        .split("\n")
        .find((l) => l.startsWith("Style: x1"))
        ?.split(",")[15],
    ).toBe("3");
  });

  test("縁取り・影・太字・斜体", () => {
    const doc = build([
      {
        id: "x1",
        start_f: 0,
        duration_f: 30,
        text: "x",
        style: {
          outline: { width: 3, color: "#FF0000" },
          shadow: { x: 2, y: 2, color: "#000000AA" },
          bold: true,
          italic: true,
        },
      },
    ]);
    const f =
      doc
        .split("\n")
        .find((l) => l.startsWith("Style: x1"))
        ?.split(",") ?? [];
    expect(f[5]).toBe("&H000000FF"); // OutlineColour = #FF0000
    expect(f[6]).toBe("&H55000000"); // BackColour = 影の色（AA=0xAA → 0x55）
    expect(f[7]).toBe("-1"); // Bold
    expect(f[8]).toBe("-1"); // Italic
    expect(f[16]).toBe("3"); // Outline
    expect(f[17]).toBe("2"); // Shadow
  });

  test("影の x/y が異なる場合は \\xshad/\\yshad で表す", () => {
    const doc = build([
      { id: "x1", start_f: 0, duration_f: 30, text: "x", style: { shadow: { x: 4, y: 1, color: "#000000" } } },
    ]);
    expect(doc).toContain("\\xshad(4)\\yshad(1)");
    expect(
      doc
        .split("\n")
        .find((l) => l.startsWith("Style: x1"))
        ?.split(",")[17],
    ).toBe("0");
  });

  test("複数行と日本語（改行 → \\N、行頭空白 → \\h）", () => {
    const doc = build([
      {
        id: "x1",
        start_f: 0,
        duration_f: 60,
        text: "福岡到着\n  博多駅より",
        style: { font: "Hiragino Sans", size: 48, position: "bottom-center" },
      },
    ]);
    expect(doc).toMatchSnapshot();
    expect(doc).toContain("福岡到着\\N\\h\\h博多駅より");
  });

  test("wrap:false は \\q2、全クリップが wrap:false なら WrapStyle: 2", () => {
    const off: TextClipLike = { id: "x1", start_f: 0, duration_f: 30, text: "x", style: { wrap: false } };
    const on: TextClipLike = { id: "x2", start_f: 30, duration_f: 30, text: "y", style: { wrap: true } };
    expect(build([off])).toContain("WrapStyle: 2");
    const mixed = build([off, on]);
    expect(mixed).toContain("WrapStyle: 0");
    expect(mixed).toContain("\\q2}x");
  });

  test("markup: ass はオーバーライドタグを通す", () => {
    const doc = build([{ id: "x1", start_f: 0, duration_f: 30, text: "{\\b1}強調{\\b0}", markup: "ass" }]);
    expect(doc.trimEnd().endsWith("{\\b1}強調{\\b0}")).toBe(true);
  });

  test("alpha は本文色にも背景色にも掛かる", () => {
    const doc = build([
      { id: "x1", start_f: 0, duration_f: 30, text: "x", style: { color: "#FFFFFF", alpha: 0.5, bg: "#000000" } },
    ]);
    const f =
      doc
        .split("\n")
        .find((l) => l.startsWith("Style: x1"))
        ?.split(",") ?? [];
    expect(f[3]).toBe("&H7FFFFFFF");
    expect(f[5]).toBe("&H7F000000");
  });

  test("layer は Dialogue の Layer になる", () => {
    const doc = build([{ id: "x1", start_f: 0, duration_f: 30, text: "x", layer: 2 }]);
    expect(doc).toContain("Dialogue: 2,");
  });

  test("クリップが無くても有効な ASS を返す", () => {
    const doc = build([]);
    expect(doc).toContain("[V4+ Styles]");
    expect(doc).toContain("[Events]");
    expect(doc.split("\n").filter((l) => l.startsWith("Dialogue: "))).toHaveLength(0);
  });
});

describe("ヘルパ", () => {
  test("fontFamiliesOf は既定フォントを必ず含める", () => {
    const clips: TextClipLike[] = [
      { id: "x1", start_f: 0, duration_f: 1, text: "a", style: { font: "Helvetica" } },
      { id: "x2", start_f: 1, duration_f: 1, text: "b" },
    ];
    expect(fontFamiliesOf(clips, "Noto Sans CJK JP")).toEqual(["Helvetica", "Noto Sans CJK JP"]);
  });

  test("subtitlesFilter は : と ' をエスケープして original_size を渡す", () => {
    expect(subtitlesFilter({ assPath: "/a b/x.ass", fontsDir: "/f", originalSize: HD })).toBe(
      "subtitles=filename='/a b/x.ass':fontsdir='/f':original_size=1920x1080",
    );
    expect(subtitlesFilter({ assPath: "C:/x:y.ass" })).toBe("subtitles=filename='C\\:/x\\:y.ass'");
  });
});
