import { describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import {
  assertFrames,
  FPS_PRESETS,
  type Fps,
  fpsEquals,
  fpsLabel,
  frameDurationSeconds,
  framesToFrameTimecode,
  framesToMillis,
  framesToSamples,
  framesToSeconds,
  framesToSecString,
  framesToTimecode,
  makeFps,
  parseFps,
  resnapFrames,
  roundDiv,
  samplesToFrames,
  secondsToFrames,
} from "../../../src/core/time.ts";

const NTSC30 = FPS_PRESETS["29.97"]!;
const NTSC60 = FPS_PRESETS["59.94"]!;
const FPS30 = FPS_PRESETS["30"]!;

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MontashError);
  expect((caught as MontashError).code).toBe(code);
}

/** 決定的な疑似乱数（テストの再現性のため） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("parseFps / presets", () => {
  test("accepts presets as number and string", () => {
    expect(parseFps(30)).toEqual({ num: 30, den: 1 });
    expect(parseFps("30")).toEqual({ num: 30, den: 1 });
    expect(parseFps("29.97")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(parseFps("23.976")).toEqual({ num: 24000, den: 1001 });
    expect(parseFps("59.94")).toEqual({ num: 60000, den: 1001 });
    expect(parseFps("24")).toEqual({ num: 24, den: 1 });
    expect(parseFps(" 25 ")).toEqual({ num: 25, den: 1 });
  });
  test("accepts rationals and normalizes to lowest terms", () => {
    expect(parseFps("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps("60000/2002")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps("60/2")).toEqual({ num: 30, den: 1 });
    expect(parseFps("24000/1001")).toEqual({ num: 24000, den: 1001 });
  });
  test("decimal aliases with trailing zeros map to the NTSC presets", () => {
    expect(parseFps("29.970")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps("23.9760")).toEqual({ num: 24000, den: 1001 });
    expect(parseFps("30.0")).toEqual({ num: 30, den: 1 });
  });
  test("non-preset decimals become exact rationals", () => {
    expect(parseFps("12.5")).toEqual({ num: 25, den: 2 });
    expect(parseFps("48")).toEqual({ num: 48, den: 1 });
    expect(parseFps("47.952")).toEqual({ num: 5994, den: 125 });
  });
  test("rejects invalid fps with E_INVALID_FPS", () => {
    for (const bad of ["", "abc", "0", "-30", "30/0", "0/1", "1/-1", "30fps", "1e3", "29.97.1", "30/1001/2"]) {
      expectCode(() => parseFps(bad), "E_INVALID_FPS");
    }
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expectCode(() => parseFps(bad), "E_INVALID_FPS");
    }
    expectCode(() => parseFps(null as unknown as string), "E_INVALID_FPS");
    expectCode(() => makeFps(30, 0), "E_INVALID_FPS");
    expectCode(() => makeFps(1.5, 1), "E_INVALID_FPS");
    expectCode(() => makeFps(-30, 1), "E_INVALID_FPS");
  });
  test("FPS_PRESETS has the eight presets from docs/05 §4", () => {
    expect(Object.keys(FPS_PRESETS).sort()).toEqual(["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].sort());
    expect(FPS_PRESETS["50"]).toEqual({ num: 50, den: 1 });
    expect(FPS_PRESETS["60"]).toEqual({ num: 60, den: 1 });
  });
});

describe("fpsLabel / fpsEquals / frameDurationSeconds", () => {
  test("labels presets by name and others to 3 decimals", () => {
    expect(fpsLabel(NTSC30)).toBe("29.97");
    expect(fpsLabel(FPS30)).toBe("30");
    expect(fpsLabel(FPS_PRESETS["23.976"]!)).toBe("23.976");
    expect(fpsLabel({ num: 60000, den: 2002 })).toBe("29.97"); // 非正規形でもプリセット名
    expect(fpsLabel({ num: 48, den: 1 })).toBe("48");
    expect(fpsLabel({ num: 25, den: 2 })).toBe("12.500");
    expect(fpsLabel({ num: 48000, den: 1001 })).toBe("47.952");
  });
  test("fpsEquals compares as rationals", () => {
    expect(fpsEquals(NTSC30, { num: 60000, den: 2002 })).toBe(true);
    expect(fpsEquals(NTSC30, FPS30)).toBe(false);
    expect(fpsEquals(parseFps("29.97"), parseFps("30000/1001"))).toBe(true);
  });
  test("frameDurationSeconds", () => {
    expect(frameDurationSeconds(FPS30)).toBeCloseTo(1 / 30, 12);
    expect(frameDurationSeconds(NTSC30)).toBeCloseTo(1001 / 30000, 12);
  });
});

describe("roundDiv", () => {
  test("integer rounding, half away toward +infinity (Math.round rule)", () => {
    expect(roundDiv(7, 2)).toBe(4);
    expect(roundDiv(5, 2)).toBe(3);
    expect(roundDiv(-5, 2)).toBe(-2);
    expect(roundDiv(-7, 2)).toBe(-3);
    expect(roundDiv(10, 3)).toBe(3);
    expect(roundDiv(11, 3)).toBe(4);
    expect(roundDiv(0, 5)).toBe(0);
    expect(roundDiv(375375, 1001)).toBe(375);
  });
  test("matches Math.round for many random integer pairs", () => {
    const rnd = lcg(7);
    for (let i = 0; i < 2000; i++) {
      const a = Math.floor(rnd() * 2_000_000) - 1_000_000;
      const b = 1 + Math.floor(rnd() * 5000);
      expect(roundDiv(a, b)).toBe(Math.round(a / b) + 0); // -0 を 0 に正規化
    }
  });
  test("rejects non-positive denominators", () => {
    expectCode(() => roundDiv(1, 0), "E_INVALID_TIME");
    expectCode(() => roundDiv(1, -2), "E_INVALID_TIME");
  });
});

describe("frames -> seconds / strings", () => {
  test("framesToSeconds / framesToMillis", () => {
    expect(framesToSeconds(375, FPS30)).toBe(12.5);
    expect(framesToSeconds(375, NTSC30)).toBeCloseTo(12.5125, 12);
    expect(framesToMillis(375, NTSC30)).toBe(12513); // 12.5125 → 12513 ms（round）
    expect(framesToMillis(375, FPS30)).toBe(12500);
    expect(framesToMillis(1, NTSC30)).toBe(33); // 33.366… ms
    expect(framesToMillis(0, NTSC30)).toBe(0);
    expect(framesToMillis(-375, NTSC30)).toBe(-12513);
  });
  test("framesToSecString has 6 fixed decimals (for ffmpeg)", () => {
    expect(framesToSecString(375, NTSC30)).toBe("12.512500");
    expect(framesToSecString(375, FPS30)).toBe("12.500000");
    expect(framesToSecString(0, NTSC30)).toBe("0.000000");
    expect(framesToSecString(1, NTSC30)).toBe("0.033367"); // 0.0333666…
    expect(framesToSecString(30, NTSC30)).toBe("1.001000");
    expect(framesToSecString(-30, NTSC30)).toBe("-1.001000");
    expect(framesToSecString(3600 * 30 * 24, FPS30)).toBe("86400.000000");
  });
  test("framesToSecString stays exact for huge frame counts (no intermediate overflow)", () => {
    // 1e9 フレーム @29.97 = 33,366,666.666666… 秒
    expect(framesToSecString(1_000_000_000, NTSC30)).toBe("33366666.666667");
    expect(framesToMillis(1_000_000_000, NTSC30)).toBe(33_366_666_667);
  });
  test("framesToTimecode HH:MM:SS.mmm", () => {
    expect(framesToTimecode(375, NTSC30)).toBe("00:00:12.513");
    expect(framesToTimecode(375, FPS30)).toBe("00:00:12.500");
    expect(framesToTimecode(0, FPS30)).toBe("00:00:00.000");
    expect(framesToTimecode(30 * 3723 + 15, FPS30)).toBe("01:02:03.500");
    expect(framesToTimecode(30 * 3600 * 100, FPS30)).toBe("100:00:00.000");
    expect(framesToTimecode(-15, FPS30)).toBe("-00:00:00.500");
  });
  test("framesToFrameTimecode HH:MM:SS:FF (non-drop)", () => {
    expect(framesToFrameTimecode(375, FPS30)).toBe("00:00:12:15");
    expect(framesToFrameTimecode(375, NTSC30)).toBe("00:00:12:15"); // 非ドロップ: 30 フレーム/秒として数える
    expect(framesToFrameTimecode(29, NTSC30)).toBe("00:00:00:29");
    expect(framesToFrameTimecode(30, NTSC30)).toBe("00:00:01:00");
    expect(framesToFrameTimecode(24 * 3723 + 7, FPS_PRESETS["23.976"]!)).toBe("01:02:03:07");
    expect(framesToFrameTimecode(119, NTSC60)).toBe("00:00:01:59");
  });
  test("rejects non-integer / NaN frames", () => {
    expectCode(() => framesToSeconds(1.5, FPS30), "E_INVALID_TIME");
    expectCode(() => framesToMillis(NaN, FPS30), "E_INVALID_TIME");
    expectCode(() => framesToSecString(Infinity, FPS30), "E_INVALID_TIME");
    expectCode(() => framesToTimecode("12" as unknown as number, FPS30), "E_INVALID_TIME");
    expectCode(() => framesToFrameTimecode(0.1, FPS30), "E_INVALID_TIME");
  });
});

describe("secondsToFrames", () => {
  test("12.5 @29.97 snaps to 375 (12.5125 s); @30 exact", () => {
    const a = secondsToFrames(12.5, NTSC30);
    expect(a.frames).toBe(375);
    expect(a.snapped).toBe(true);
    expect(a.exactSeconds).toBeCloseTo(12.5125, 12);
    const b = secondsToFrames(12.5, FPS30);
    expect(b).toEqual({ frames: 375, snapped: false, exactSeconds: 12.5 });
  });
  test("1 second at 29.97 is 30 frames (1.001 s) — docs/04 §1.3", () => {
    const r = secondsToFrames(1, NTSC30);
    expect(r.frames).toBe(30);
    expect(r.snapped).toBe(true);
    expect(r.exactSeconds).toBeCloseTo(1.001, 12);
  });
  test("values already on a frame boundary are not snapped", () => {
    expect(secondsToFrames(12.5125, NTSC30)).toMatchObject({ frames: 375, snapped: false });
    expect(secondsToFrames(0, NTSC30)).toEqual({ frames: 0, snapped: false, exactSeconds: 0 });
    expect(secondsToFrames(0.1, FPS30)).toMatchObject({ frames: 3, snapped: false });
  });
  test("negative seconds are accepted (used for relative deltas)", () => {
    expect(secondsToFrames(-2, FPS30)).toMatchObject({ frames: -60, snapped: false });
  });
  test("round trip secondsToFrames(framesToSeconds(f)) === f for 200 random frames at 29.97 and 59.94", () => {
    const rnd = lcg(12345);
    const fpsList: Fps[] = [NTSC30, NTSC60];
    for (const fps of fpsList) {
      for (let i = 0; i < 200; i++) {
        const f = Math.floor(rnd() * 100_001);
        const r = secondsToFrames(framesToSeconds(f, fps), fps);
        expect(r.frames).toBe(f);
        expect(r.snapped).toBe(false);
      }
    }
  });
  test("rejects NaN / Infinity", () => {
    expectCode(() => secondsToFrames(NaN, FPS30), "E_INVALID_TIME");
    expectCode(() => secondsToFrames(Infinity, FPS30), "E_INVALID_TIME");
  });
});

describe("frames <-> samples", () => {
  test("framesToSamples rounds (29.97/48kHz: 1601.6 samples per frame)", () => {
    expect(framesToSamples(1, NTSC30, 48000)).toBe(1602);
    expect(framesToSamples(5, NTSC30, 48000)).toBe(8008); // 5 * 1601.6 = 8008 exactly
    expect(framesToSamples(375, NTSC30, 48000)).toBe(600600);
    expect(framesToSamples(1, FPS30, 48000)).toBe(1600);
    expect(framesToSamples(0, NTSC30, 48000)).toBe(0);
    expect(framesToSamples(-1, NTSC30, 48000)).toBe(-1602);
  });
  test("framesToSamples error is below one sample for 29.97 and 59.94", () => {
    const rnd = lcg(99);
    for (const fps of [NTSC30, NTSC60]) {
      for (let i = 0; i < 500; i++) {
        const f = Math.floor(rnd() * 1_000_000);
        const exact = (f * fps.den * 48000) / fps.num;
        expect(Math.abs(framesToSamples(f, fps, 48000) - exact)).toBeLessThan(1);
        expect(Math.abs(framesToSamples(f, fps, 48000) - exact)).toBeLessThanOrEqual(0.5 + 1e-6);
      }
    }
  });
  test("samplesToFrames", () => {
    expect(samplesToFrames(600600, NTSC30, 48000)).toBe(375);
    expect(samplesToFrames(-960, FPS30, 48000)).toBe(-1); // -0.6 フレーム → -1
    expect(samplesToFrames(800, FPS30, 48000)).toBe(1); // 0.5 → 1
    expect(samplesToFrames(48000, FPS30, 48000)).toBe(30);
    const rnd = lcg(5);
    for (let i = 0; i < 300; i++) {
      const f = Math.floor(rnd() * 200_000);
      expect(samplesToFrames(framesToSamples(f, NTSC30, 48000), NTSC30, 48000)).toBe(f);
    }
  });
  test("rejects bad sample rates / non-integers", () => {
    expectCode(() => framesToSamples(1, FPS30, 0), "E_INVALID_TIME");
    expectCode(() => framesToSamples(1, FPS30, -48000), "E_INVALID_TIME");
    expectCode(() => framesToSamples(1, FPS30, 44100.5), "E_INVALID_TIME");
    expectCode(() => framesToSamples(1.5, FPS30, 48000), "E_INVALID_TIME");
    expectCode(() => samplesToFrames(NaN, FPS30, 48000), "E_INVALID_TIME");
  });
});

describe("resnapFrames", () => {
  test("formula from docs/05 §2", () => {
    expect(resnapFrames(375, FPS30, NTSC30)).toBe(375); // 12.5 s → 374.6 → 375
    expect(resnapFrames(300, FPS30, FPS_PRESETS["60"]!)).toBe(600);
    expect(resnapFrames(300, FPS30, FPS_PRESETS["24"]!)).toBe(240);
    expect(resnapFrames(30, NTSC30, FPS30)).toBe(30); // 1.001 s → 30.03 → 30
    expect(resnapFrames(0, FPS30, NTSC30)).toBe(0);
    expect(resnapFrames(7, FPS30, FPS30)).toBe(7);
  });
  test("30 -> 29.97 -> 30 round trip error is at most 1 frame", () => {
    const rnd = lcg(2024);
    for (let i = 0; i < 500; i++) {
      const f = Math.floor(rnd() * 100_001);
      const back = resnapFrames(resnapFrames(f, FPS30, NTSC30), NTSC30, FPS30);
      expect(Math.abs(back - f)).toBeLessThanOrEqual(1);
    }
    // 30 → 60 → 30 は恒等
    for (let f = 0; f < 100; f++) {
      expect(resnapFrames(resnapFrames(f, FPS30, FPS_PRESETS["60"]!), FPS_PRESETS["60"]!, FPS30)).toBe(f);
    }
  });
  test("rejects non-integer frames", () => {
    expectCode(() => resnapFrames(1.5, FPS30, NTSC30), "E_INVALID_TIME");
  });
});

describe("assertFrames", () => {
  test("accepts non-negative safe integers", () => {
    expect(assertFrames(0, "start_f")).toBe(0);
    expect(assertFrames(375, "start_f")).toBe(375);
    expect(assertFrames(Number.MAX_SAFE_INTEGER, "start_f")).toBe(Number.MAX_SAFE_INTEGER);
  });
  test("rejects negative / non-integer / NaN / non-number with E_INVALID_TIME and the field name", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, "375", null, undefined, 2 ** 53]) {
      let caught: unknown;
      try {
        assertFrames(bad, "duration_f");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(MontashError);
      const err = caught as MontashError;
      expect(err.code).toBe("E_INVALID_TIME");
      expect(err.message).toContain("duration_f");
      expect(err.detail?.field).toBe("duration_f");
    }
  });
});
