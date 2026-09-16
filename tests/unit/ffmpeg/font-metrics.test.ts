/**
 * フォントメトリクスの読み取り（`src/ffmpeg/font-metrics.ts`）と、
 * 実測フレームからインク幅を拾う純関数（`src/ffmpeg/text-measure.ts` の `inkBounds`）。
 *
 * 実フォントに依存しないよう、最小の sfnt / ttc をその場で組み立てて食わせる。
 */
import { expect, test } from "bun:test";
import {
  type ByteReader,
  FALLBACK_SIZE_SCALE,
  fontSizeScale,
  parseHheaHeight,
  parseTableDirectory,
  parseUnitsPerEm,
  parseWinHeight,
  readSizeScale,
} from "../../../src/ffmpeg/font-metrics.ts";
import { inkBounds } from "../../../src/ffmpeg/text-measure.ts";

// ---------------------------------------------------------------------------
// 最小の sfnt を組み立てるヘルパ
// ---------------------------------------------------------------------------

function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

interface FakeTables {
  upem?: number;
  win?: { ascent: number; descent: number };
  hhea?: { ascender: number; descender: number };
}

/** head / OS/2 / hhea だけを持つ sfnt（`ttc` にも包める） */
function buildFont(tables: FakeTables, asTtc = false): Uint8Array {
  const entries: Array<{ tag: string; body: number[] }> = [];
  if (tables.upem !== undefined) {
    const head = new Array(54).fill(0);
    head.splice(18, 2, ...u16(tables.upem));
    entries.push({ tag: "head", body: head });
  }
  if (tables.win !== undefined) {
    const os2 = new Array(96).fill(0);
    os2.splice(74, 2, ...u16(tables.win.ascent));
    os2.splice(76, 2, ...u16(tables.win.descent));
    entries.push({ tag: "OS/2", body: os2 });
  }
  if (tables.hhea !== undefined) {
    const hhea = new Array(36).fill(0);
    const signed = (v: number): number[] => u16(v < 0 ? v + 0x10000 : v);
    hhea.splice(4, 2, ...signed(tables.hhea.ascender));
    hhea.splice(6, 2, ...signed(tables.hhea.descender));
    entries.push({ tag: "hhea", body: hhea });
  }

  const ttcHeader = asTtc ? [...ascii("ttcf"), ...u32(0x00010000), ...u32(1), ...u32(16)] : [];
  const base = ttcHeader.length;
  const directory = [...u32(0x00010000), ...u16(entries.length), ...u16(0), ...u16(0), ...u16(0)];
  let cursor = base + directory.length + entries.length * 16;
  const records: number[] = [];
  const bodies: number[] = [];
  for (const entry of entries) {
    records.push(...ascii(entry.tag), ...u32(0), ...u32(cursor), ...u32(entry.body.length));
    bodies.push(...entry.body);
    cursor += entry.body.length;
  }
  return new Uint8Array([...ttcHeader, ...directory, ...records, ...bodies]);
}

/** Uint8Array を `ByteReader` として読む */
function reader(bytes: Uint8Array): ByteReader {
  return async (offset, length) => bytes.slice(offset, offset + length);
}

// ---------------------------------------------------------------------------
// テーブルの読み取り
// ---------------------------------------------------------------------------

test("テーブル表を読む（sfnt と ttc の両方）", () => {
  const plain = parseTableDirectory(buildFont({ upem: 1000, win: { ascent: 1015, descent: 242 } }));
  expect([...(plain?.keys() ?? [])].sort()).toEqual(["OS/2", "head"]);
  const ttc = parseTableDirectory(buildFont({ upem: 1000, win: { ascent: 1015, descent: 242 } }, true));
  expect([...(ttc?.keys() ?? [])].sort()).toEqual(["OS/2", "head"]);
});

test("壊れた・短すぎるバイト列では null を返す（例外を投げない）", () => {
  expect(parseTableDirectory(new Uint8Array(4))).toBeNull();
  expect(parseUnitsPerEm(new Uint8Array(4))).toBeNull();
  expect(parseWinHeight(new Uint8Array(4))).toBeNull();
  expect(parseHheaHeight(new Uint8Array(4))).toBeNull();
});

test("unitsPerEm・winAscent+winDescent・ascender-descender をそれぞれ読む", () => {
  const bytes = buildFont({
    upem: 2048,
    win: { ascent: 1946, descent: 461 },
    hhea: { ascender: 1854, descender: -434 },
  });
  const offsets = parseTableDirectory(bytes);
  const at = (tag: string, len: number) =>
    bytes.slice(offsets?.get(tag) as number, (offsets?.get(tag) as number) + len);
  expect(parseUnitsPerEm(at("head", 54))).toBe(2048);
  expect(parseWinHeight(at("OS/2", 96))).toBe(2407);
  expect(parseHheaHeight(at("hhea", 36))).toBe(2288);
});

// ---------------------------------------------------------------------------
// 描画スケール
// ---------------------------------------------------------------------------

test("libass の縮尺は upem / (winAscent + winDescent)", async () => {
  // Hiragino Sans の実測値（1000 / 1257 = 0.7955。実測した送りは Fontsize 100 で 79.8px）
  const hiragino = await readSizeScale(reader(buildFont({ upem: 1000, win: { ascent: 1015, descent: 242 } })));
  expect(hiragino).toBeCloseTo(0.7955, 4);
  // Helvetica（2048 / 2407 = 0.8509。実測した `W` は Fontsize 100 で 80.4px = 0.944em × 0.851）
  const helvetica = await readSizeScale(reader(buildFont({ upem: 2048, win: { ascent: 1946, descent: 461 } })));
  expect(helvetica).toBeCloseTo(0.8509, 4);
});

test("OS/2 が無い（または 0）フォントは hhea の ascender - descender を使う", async () => {
  const scale = await readSizeScale(reader(buildFont({ upem: 1000, hhea: { ascender: 800, descender: -200 } })));
  expect(scale).toBe(1);
  const both = await readSizeScale(
    reader(buildFont({ upem: 1000, win: { ascent: 0, descent: 0 }, hhea: { ascender: 1000, descender: -250 } })),
  );
  expect(both).toBeCloseTo(0.8, 6);
});

test("メトリクスが読めなければ null（呼び出し側は等倍にフォールバックする）", async () => {
  expect(await readSizeScale(reader(buildFont({})))).toBeNull();
  expect(await readSizeScale(reader(new Uint8Array(8)))).toBeNull();
});

test("読めないパスは FALLBACK_SIZE_SCALE", async () => {
  expect(await fontSizeScale("/nonexistent/montash-test-font.ttf")).toBe(FALLBACK_SIZE_SCALE);
});

// ---------------------------------------------------------------------------
// 実測フレームからインク幅を拾う
// ---------------------------------------------------------------------------

test("inkBounds は黒でない画素のある列の範囲を返す", () => {
  const width = 10;
  const height = 3;
  const frame = new Uint8Array(width * height).fill(16); // リミテッドレンジの黒
  frame[1 * width + 3] = 200;
  frame[2 * width + 6] = 40;
  expect(inkBounds(frame, width, height)).toEqual({ x1: 3, x2: 6 });
});

test("inkBounds は真っ黒なら null。閾値ぎりぎりの暗い画素は拾わない", () => {
  const frame = new Uint8Array(30).fill(16);
  expect(inkBounds(frame, 10, 3)).toBeNull();
  frame[5] = 24;
  expect(inkBounds(frame, 10, 3)).toBeNull();
  frame[5] = 25;
  expect(inkBounds(frame, 10, 3)).toEqual({ x1: 5, x2: 5 });
});
