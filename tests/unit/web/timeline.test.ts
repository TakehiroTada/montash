/**
 * 編集タイムラインの派生値（web/src/lib/timeline.ts）。
 * canvas も DOM も使わない純関数だけを検証する（docs/06 §2.4、docs/13 D-1 / D-2）。
 */
import { describe, expect, test } from "bun:test";
import {
  type ClipLike,
  type Computed,
  clipDuration,
  clipEnd,
  clipKindOf,
  clipLabel,
  clipSpan,
  computedIndex,
  EMPTY_SCALE_SECONDS,
  type ProjectLike,
  timelineDuration,
  timelineScaleFrames,
  timelineSpan,
  truncateLabel,
} from "../../../web/src/lib/timeline.ts";

const FPS = { num: 30, den: 1 };
const FPS_2997 = { num: 30000, den: 1001 };

const media: ClipLike = { id: "c1", asset: "a", start_f: 0, in_f: 0, out_f: 90, speed: 1 };
const text: ClipLike = { id: "x1", type: "text", start_f: 0, duration_f: 75, text: "夏の旅 2026" };
const subtitle: ClipLike = { id: "s1", type: "subtitle", asset: "ja", start_f: 0, offset_f: 0 };

describe("clipKindOf", () => {
  test("distinguishes media / text / subtitle / generator", () => {
    expect(clipKindOf(media)).toBe("media");
    expect(clipKindOf(text)).toBe("text");
    expect(clipKindOf(subtitle)).toBe("subtitle");
    expect(clipKindOf({ id: "g1", generator: "color", start_f: 0, duration_f: 30 })).toBe("generator");
  });
});

describe("clipDuration", () => {
  test("media clips divide the in/out range by speed", () => {
    expect(clipDuration(media)).toBe(90);
    expect(clipDuration({ ...media, speed: 2 })).toBe(45);
    // 長さ 0 のクリップでも 1 フレームは確保する
    expect(clipDuration({ ...media, out_f: 0 })).toBe(1);
  });

  test("text clips use duration_f (docs/13 D-1: これを in/out で計算すると 1 フレーム幅になる)", () => {
    expect(clipDuration(text)).toBe(75);
    expect(clipEnd({ ...text, start_f: 30 })).toBe(105);
    // 生成クリップも同じ持ち方
    expect(clipDuration({ id: "g1", generator: "color", start_f: 0, duration_f: 60 })).toBe(60);
  });

  test("subtitle clips have no local length (computed が要る)", () => {
    expect(clipDuration(subtitle)).toBe(0);
  });
});

describe("clipSpan", () => {
  const computed: Computed = {
    duration_f: 90,
    span_f: 135,
    tracks: [
      {
        id: "T1",
        kind: "text",
        clips: [{ id: "s1", kind: "subtitle", start_f: 15, end_f: 135, duration_f: 120, label: "ja" }],
      },
    ],
  };
  const index = computedIndex({ computed } as ProjectLike);

  test("prefers the server's computed span", () => {
    expect(clipSpan(subtitle, index)).toEqual({ start_f: 15, end_f: 135, duration_f: 120 });
  });

  test("falls back to the local計算 when computed is missing", () => {
    expect(clipSpan(text)).toEqual({ start_f: 0, end_f: 75, duration_f: 75 });
    expect(clipSpan(media, new Map())).toEqual({ start_f: 0, end_f: 90, duration_f: 90 });
  });
});

describe("clipLabel", () => {
  test("text clips show the beginning of their body", () => {
    expect(clipLabel(text)).toBe("x1 夏の旅 2026");
    expect(clipLabel({ ...text, text: "あ".repeat(30) })).toBe(`x1 ${"あ".repeat(20)}…`);
  });

  test("media clips keep the label / asset suffix", () => {
    expect(clipLabel(media)).toBe("c1 a");
    expect(clipLabel({ ...media, label: "オープニング" })).toBe("c1 オープニング");
    expect(clipLabel({ id: "c9", start_f: 0 })).toBe("c9");
  });

  test("subtitle clips show the subtitle asset", () => {
    expect(clipLabel(subtitle)).toBe("s1 ja");
  });
});

describe("truncateLabel", () => {
  test("folds whitespace and truncates at 20 characters", () => {
    expect(truncateLabel("  二行に\nわたる字幕  ")).toBe("二行に わたる字幕");
    expect(truncateLabel("abcdefghij".repeat(3))).toBe("abcdefghijabcdefghij…");
  });

  test("does not split surrogate pairs", () => {
    expect(truncateLabel("🎬".repeat(25))).toBe(`${"🎬".repeat(20)}…`);
  });
});

describe("timelineDuration / timelineSpan", () => {
  const project: ProjectLike = {
    settings: { fps: FPS },
    tracks: [
      { id: "V1", kind: "video", clips: [media] },
      { id: "T1", kind: "text", clips: [text, subtitle] },
    ],
  };

  test("without computed, the duration ignores subtitles", () => {
    expect(timelineDuration(project)).toBe(90);
    expect(timelineSpan(project)).toBe(90);
  });

  test("with computed, the subtitle extends the drawn span but not the duration", () => {
    const withComputed: ProjectLike = {
      ...project,
      computed: { duration_f: 90, span_f: 135, tracks: [] },
    };
    expect(timelineDuration(withComputed)).toBe(90);
    expect(timelineSpan(withComputed)).toBe(135);
  });

  test("an empty project is zero-length", () => {
    expect(timelineDuration(null)).toBe(0);
    expect(timelineSpan({ tracks: [] })).toBe(0);
  });
});

describe("timelineScaleFrames (docs/13 D-2)", () => {
  test("follows the project length with about one second of tail margin", () => {
    // 6 秒（180f）のプロジェクトは 7 秒ぶんの目盛りになる（従来は 10 秒固定で右 4 割が空白だった）
    expect(timelineScaleFrames(180, FPS)).toBe(210);
    expect(timelineScaleFrames(900, FPS)).toBe(930);
    // 29.97fps でも 1 秒ぶんの余白
    expect(timelineScaleFrames(180, FPS_2997)).toBe(180 + 30);
  });

  test("falls back to 10 seconds when there are no clips", () => {
    expect(timelineScaleFrames(0, FPS)).toBe(EMPTY_SCALE_SECONDS * 30);
    expect(timelineScaleFrames(-5, FPS)).toBe(EMPTY_SCALE_SECONDS * 30);
    expect(timelineScaleFrames(Number.NaN, FPS)).toBe(EMPTY_SCALE_SECONDS * 30);
  });

  test("keeps a zoomed-out view instead of snapping back to the project length", () => {
    // zoom < 1 は時間軸を広げる操作。既定（尺 + 余白）より広い状態が維持される
    expect(timelineScaleFrames(180, FPS, { zoom: 0.5 })).toBe(420);
    expect(timelineScaleFrames(180, FPS, { zoom: 0.25 })).toBe(840);
    // zoom > 1 は拡大。尺より短い範囲になる
    expect(timelineScaleFrames(180, FPS, { zoom: 2 })).toBe(105);
    // 不正な zoom は既定（1 倍）に落とす
    expect(timelineScaleFrames(180, FPS, { zoom: 0 })).toBe(210);
  });

  test("always keeps the playhead on screen", () => {
    expect(timelineScaleFrames(180, FPS, { playhead_f: 500 })).toBe(501);
    expect(timelineScaleFrames(180, FPS, { playhead_f: 100 })).toBe(210);
    // 拡大中でも再生ヘッドは収まる
    expect(timelineScaleFrames(180, FPS, { zoom: 4, playhead_f: 300 })).toBe(301);
  });

  test("never returns a non-positive number of frames", () => {
    expect(timelineScaleFrames(0, { num: 0, den: 0 } as never)).toBeGreaterThan(0);
    expect(timelineScaleFrames(1, FPS, { zoom: 1e9 })).toBe(1);
  });
});
