/**
 * サムネイル・波形の描画用整形（web/src/lib/derived.ts）。
 * canvas も DOM も使わない純関数だけを検証する（docs/06 §2.3, §2.4, §2.6）。
 */
import { describe, expect, test } from "bun:test";
import {
  spriteSize,
  type ThumbsIndex,
  thumbSourceAt,
  thumbStrip,
  thumbTile,
  tileStyle,
  type WaveformIndex,
  waveformColumns,
} from "../../../web/src/lib/derived.ts";
import type { TrackLike } from "../../../web/src/store.ts";

const FPS = { num: 30, den: 1 };
const index: ThumbsIndex = { interval_f: 30, width: 160, height: 90, columns: 5, count: 12, sprite: "thumbs.jpg" };

describe("thumbTile", () => {
  test("maps a source frame to its tile in the sprite", () => {
    expect(thumbTile(index, 0)).toEqual({ index: 0, x: 0, y: 0, width: 160, height: 90 });
    // 2 秒目 = 3 枚目（0 起点で 2）
    expect(thumbTile(index, 75)).toEqual({ index: 2, x: 320, y: 0, width: 160, height: 90 });
    // 6 枚目で 2 行目に折り返す
    expect(thumbTile(index, 30 * 5)).toEqual({ index: 5, x: 0, y: 90, width: 160, height: 90 });
  });

  test("clamps out-of-range frames to the ends", () => {
    expect(thumbTile(index, -100)?.index).toBe(0);
    expect(thumbTile(index, 30 * 999)?.index).toBe(index.count - 1);
  });

  test("returns null for missing or broken indexes", () => {
    expect(thumbTile(null, 0)).toBeNull();
    expect(thumbTile(undefined, 0)).toBeNull();
    expect(thumbTile({ ...index, count: 0 }, 0)).toBeNull();
    expect(thumbTile({ ...index, interval_f: 0 }, 0)).toBeNull();
  });
});

test("spriteSize covers every row", () => {
  expect(spriteSize(index)).toEqual({ width: 800, height: 270 });
  expect(spriteSize({ ...index, count: 5 })).toEqual({ width: 800, height: 90 });
});

describe("thumbStrip", () => {
  test("picks evenly spaced tiles including the first and last", () => {
    const strip = thumbStrip(index, 4);
    expect(strip.map((t) => t.index)).toEqual([0, 4, 7, 11]);
  });

  test("never returns more tiles than the sprite has", () => {
    expect(thumbStrip({ ...index, count: 3 }, 8).map((t) => t.index)).toEqual([0, 1, 2]);
    expect(thumbStrip({ ...index, count: 1 }, 8).map((t) => t.index)).toEqual([0]);
    expect(thumbStrip(null, 8)).toEqual([]);
  });
});

test("tileStyle scales the sprite and its offset by the same factor", () => {
  const tile = thumbTile(index, 30 * 6)!;
  expect(tileStyle(index, tile, "clip_a", 0.5)).toEqual({
    width: "80px",
    height: "45px",
    backgroundImage: 'url("/api/assets/clip_a/thumbs.jpg")',
    backgroundPosition: "-80px -45px",
    backgroundSize: "400px 135px",
  });
  // ID は URL エンコードする
  expect(tileStyle(index, tile, "a b").backgroundImage).toBe('url("/api/assets/a%20b/thumbs.jpg")');
});

describe("waveformColumns", () => {
  /** 1 秒ぶん（100 点）。前半 50 点が 0.8、後半 50 点が 0 */
  const wave: WaveformIndex = {
    points_per_second: 100,
    channels: 1,
    peaks: [...Array.from({ length: 50 }, () => 0.8), ...Array.from({ length: 50 }, () => 0)],
  };

  test("folds the clip range into the requested number of columns", () => {
    const cols = waveformColumns(wave, FPS, 0, 30, 10);
    expect(cols).toHaveLength(10);
    expect(cols.slice(0, 5)).toEqual([0.8, 0.8, 0.8, 0.8, 0.8]);
    expect(cols.slice(5)).toEqual([0, 0, 0, 0, 0]);
  });

  test("uses only the in_f..out_f slice of the asset", () => {
    // 後半 15 フレーム（0.5 秒〜1 秒）は無音側だけ
    expect(waveformColumns(wave, FPS, 15, 30, 4)).toEqual([0, 0, 0, 0]);
    expect(waveformColumns(wave, FPS, 0, 15, 4)).toEqual([0.8, 0.8, 0.8, 0.8]);
  });

  test("takes the peak of each column, not the average", () => {
    const spiky: WaveformIndex = { points_per_second: 100, channels: 1, peaks: [0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0] };
    // 10 点を 2 列に畳む → 前半にスパイクが残る
    expect(waveformColumns(spiky, FPS, 0, 3, 2)).toEqual([0.9, 0]);
  });

  test("keeps reading at least one point when zoomed past 1:1", () => {
    const cols = waveformColumns(wave, FPS, 0, 3, 40);
    expect(cols).toHaveLength(40);
    expect(cols.every((v) => v === 0.8)).toBe(true);
  });

  test("returns an empty array for missing or degenerate input", () => {
    expect(waveformColumns(null, FPS, 0, 30, 10)).toEqual([]);
    expect(waveformColumns(wave, FPS, 0, 30, 0)).toEqual([]);
    expect(waveformColumns(wave, FPS, 30, 30, 10)).toEqual([]);
    expect(waveformColumns({ ...wave, peaks: [] }, FPS, 0, 30, 10)).toEqual([]);
    expect(waveformColumns({ ...wave, points_per_second: 0 }, FPS, 0, 30, 10)).toEqual([]);
  });
});

describe("thumbSourceAt", () => {
  const tracks: TrackLike[] = [
    { id: "V1", kind: "video", clips: [{ id: "c1", asset: "a", start_f: 0, in_f: 60, out_f: 120 }] },
    { id: "V2", kind: "video", clips: [{ id: "c2", asset: "logo", start_f: 10, in_f: 0, out_f: 20 }] },
    { id: "A1", kind: "audio", clips: [{ id: "c3", asset: "bgm", start_f: 0, in_f: 0, out_f: 300 }] },
  ];

  test("prefers the topmost video track and maps to the source frame", () => {
    // V2 が覆う 10..29 は V2、それ以外は V1
    expect(thumbSourceAt(tracks, 15)).toEqual({ assetId: "logo", sourceF: 5, clipId: "c2" });
    expect(thumbSourceAt(tracks, 0)).toEqual({ assetId: "a", sourceF: 60, clipId: "c1" });
    expect(thumbSourceAt(tracks, 40)).toEqual({ assetId: "a", sourceF: 100, clipId: "c1" });
  });

  test("accounts for speed and skips muted tracks, audio tracks and gaps", () => {
    const fast: TrackLike[] = [
      { id: "V1", kind: "video", clips: [{ id: "c1", asset: "a", start_f: 0, in_f: 0, out_f: 120, speed: 2 }] },
    ];
    expect(thumbSourceAt(fast, 10)?.sourceF).toBe(20);
    expect(thumbSourceAt([{ ...tracks[1]!, muted: true }], 15)).toBeNull();
    expect(thumbSourceAt([tracks[2]!], 15)).toBeNull();
    expect(thumbSourceAt(tracks, 500)).toBeNull();
    expect(thumbSourceAt([], 0)).toBeNull();
  });
});
