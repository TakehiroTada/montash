import { describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import {
  findSwallowedNegativeTime,
  type ParsedTime,
  parseTimeInput,
  resolveAbsolute,
} from "../../../src/cli/time-input.ts";
import { FPS_PRESETS } from "../../../src/core/time.ts";

const NTSC30 = FPS_PRESETS["29.97"]!;
const FPS30 = FPS_PRESETS["30"]!;
const ALL = { allowRelative: true, allowEnd: true, allowTimeline: true, allowSamples: true };

function catchError(fn: () => unknown): MontashError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MontashError);
    return e as MontashError;
  }
  throw new Error("expected an error");
}

describe("parseTimeInput — absolute", () => {
  test("seconds at 30 fps: exact, no warning", () => {
    const p = parseTimeInput("12.5", FPS30);
    expect(p.value).toEqual({ kind: "absolute", frames: 375 });
    expect(p.warning).toBeUndefined();
    expect(p.raw).toBe("12.5");
  });
  test("seconds at 29.97 fps: snapped to 375 with W_SNAPPED { input, frame, seconds }", () => {
    const p = parseTimeInput("12.5", NTSC30);
    expect(p.value).toEqual({ kind: "absolute", frames: 375 });
    expect(p.warning?.code).toBe("W_SNAPPED");
    expect(p.warning?.detail?.input).toBe("12.5");
    expect(p.warning?.detail?.frame).toBe(375);
    expect(p.warning?.detail?.seconds as number).toBeCloseTo(12.5125, 12);
    expect(p.warning?.hint).toContain("f:375");
    expect(p.warning?.message).toContain("29.97");
  });
  test("integer seconds and leading-dot seconds", () => {
    expect(parseTimeInput("12", FPS30).value).toEqual({ kind: "absolute", frames: 360 });
    expect(parseTimeInput("0", FPS30).value).toEqual({ kind: "absolute", frames: 0 });
    expect(parseTimeInput(".5", FPS30).value).toEqual({ kind: "absolute", frames: 15 });
    expect(parseTimeInput("12.", FPS30).value).toEqual({ kind: "absolute", frames: 360 });
  });
  test("f:375 is taken verbatim (no rounding, no warning) at any fps", () => {
    const p = parseTimeInput("f:375", NTSC30);
    expect(p.value).toEqual({ kind: "absolute", frames: 375 });
    expect(p.warning).toBeUndefined();
    expect(parseTimeInput("f:0", FPS30).value).toEqual({ kind: "absolute", frames: 0 });
  });
  test("timecodes", () => {
    expect(parseTimeInput("00:00:12.500", FPS30).value).toEqual({ kind: "absolute", frames: 375 });
    expect(parseTimeInput("1:02:03", FPS30).value).toEqual({ kind: "absolute", frames: 3723 * 30 });
    expect(parseTimeInput("12:30", FPS30).value).toEqual({ kind: "absolute", frames: 750 * 30 });
    expect(parseTimeInput("12:30.5", FPS30).value).toEqual({ kind: "absolute", frames: 750 * 30 + 15 });
    expect(parseTimeInput("00:00:12.5", FPS30).value).toEqual({ kind: "absolute", frames: 375 });
    expect(parseTimeInput("00:00:12.50", FPS30).value).toEqual({ kind: "absolute", frames: 375 });
    expect(parseTimeInput("0:00:00.001", FPS30).value).toEqual({ kind: "absolute", frames: 0 }); // 0.03 フレーム → 0
    expect(parseTimeInput("100:00:00", FPS30).value).toEqual({ kind: "absolute", frames: 360000 * 30 });
  });
  test("timecode at 29.97 fps snaps with a warning", () => {
    const p = parseTimeInput("00:00:12.500", NTSC30);
    expect(p.value).toEqual({ kind: "absolute", frames: 375 });
    expect(p.warning?.code).toBe("W_SNAPPED");
    expect(p.warning?.detail?.input).toBe("00:00:12.500");
  });
  test("trims whitespace", () => {
    expect(parseTimeInput("  f:10 ", FPS30)).toMatchObject({ value: { kind: "absolute", frames: 10 }, raw: "f:10" });
  });
});

describe("parseTimeInput — relative", () => {
  test("+f:15 / -f:2", () => {
    expect(parseTimeInput("+f:15", NTSC30)).toMatchObject({ value: { kind: "relative", deltaFrames: 15 } });
    expect(parseTimeInput("-f:2", NTSC30)).toMatchObject({ value: { kind: "relative", deltaFrames: -2 } });
    expect(parseTimeInput("+f:15", NTSC30).warning).toBeUndefined();
  });
  test("+0.5 / -2 in seconds", () => {
    expect(parseTimeInput("+0.5", FPS30).value).toEqual({ kind: "relative", deltaFrames: 15 });
    expect(parseTimeInput("-2", FPS30).value).toEqual({ kind: "relative", deltaFrames: -60 });
    // 29.97 では +1 秒 = 30 フレーム（1.001 秒）で W_SNAPPED（docs/04 §1.3）
    const p = parseTimeInput("+1", NTSC30);
    expect(p.value).toEqual({ kind: "relative", deltaFrames: 30 });
    expect(p.warning?.code).toBe("W_SNAPPED");
    expect(p.warning?.hint).toContain("+f:30");
    const m = parseTimeInput("-2", NTSC30);
    expect(m.value).toEqual({ kind: "relative", deltaFrames: -60 });
    expect(m.warning?.hint).toContain("-f:60");
  });
  test("relative timecode", () => {
    expect(parseTimeInput("-1:00", FPS30).value).toEqual({ kind: "relative", deltaFrames: -1800 });
  });
  test("a negative absolute like --in -10 is treated as relative (spec)", () => {
    expect(parseTimeInput("-10", FPS30).value).toEqual({ kind: "relative", deltaFrames: -300 });
  });
  test("rejected when allowRelative=false", () => {
    const e = catchError(() => parseTimeInput("-10", FPS30, { allowRelative: false }));
    expect(e.code).toBe("E_INVALID_TIME");
    expect(e.hint).toContain("Accepted time formats");
    expect(e.hint).not.toContain("+f:15");
    expect(e.hint).toContain("Absolute times cannot be negative");
  });
});

describe("parseTimeInput — end / timeline / samples", () => {
  test("end / end-3 / end-f:10", () => {
    expect(parseTimeInput("end", FPS30).value).toEqual({ kind: "end", offsetFrames: 0 });
    expect(parseTimeInput("end-3", FPS30).value).toEqual({ kind: "end", offsetFrames: -90 });
    expect(parseTimeInput("end-f:10", NTSC30).value).toEqual({ kind: "end", offsetFrames: -10 });
    expect(parseTimeInput("end-0:05", FPS30).value).toEqual({ kind: "end", offsetFrames: -150 });
    const p = parseTimeInput("end-3", NTSC30);
    expect(p.value).toEqual({ kind: "end", offsetFrames: -90 });
    expect(p.warning?.code).toBe("W_SNAPPED");
    expect(p.warning?.hint).toContain("end-f:90");
  });
  test("end+3 / end- are invalid", () => {
    expect(catchError(() => parseTimeInput("end+3", FPS30)).code).toBe("E_INVALID_TIME");
    expect(catchError(() => parseTimeInput("end-", FPS30)).code).toBe("E_INVALID_TIME");
    expect(catchError(() => parseTimeInput("end-abc", FPS30)).code).toBe("E_INVALID_TIME");
  });
  test("end rejected when allowEnd=false", () => {
    expect(catchError(() => parseTimeInput("end", FPS30, { allowEnd: false })).code).toBe("E_INVALID_TIME");
  });
  test("timeline only with allowTimeline", () => {
    expect(parseTimeInput("timeline", FPS30, { allowTimeline: true }).value).toEqual({ kind: "timeline" });
    expect(catchError(() => parseTimeInput("timeline", FPS30)).code).toBe("E_INVALID_TIME");
  });
  test("s:-960 only with allowSamples", () => {
    expect(parseTimeInput("s:-960", FPS30, { allowSamples: true }).value).toEqual({ kind: "samples", samples: -960 });
    expect(parseTimeInput("s:480", FPS30, { allowSamples: true }).value).toEqual({ kind: "samples", samples: 480 });
    expect(parseTimeInput("s:+480", FPS30, { allowSamples: true }).value).toEqual({ kind: "samples", samples: 480 });
    const e = catchError(() => parseTimeInput("s:-960", FPS30));
    expect(e.code).toBe("E_INVALID_TIME");
    expect(catchError(() => parseTimeInput("s:1.5", FPS30, { allowSamples: true })).code).toBe("E_INVALID_TIME");
  });
});

describe("parseTimeInput — invalid input", () => {
  test.each([
    "abc",
    "f:1.5",
    "12:99",
    "",
    "   ",
    "f:",
    "f:-3",
    "12.5s",
    "1:2:3:4",
    "99:00",
    "00:60:00",
    "12,5",
    "1e3",
    "+",
    "-",
    "+-1",
    "--1",
    "f:+3",
    "12:30:",
    ":30",
  ])("%j → E_INVALID_TIME with accepted-format hint", (bad) => {
    const e = catchError(() => parseTimeInput(bad, FPS30, ALL));
    expect(e.code).toBe("E_INVALID_TIME");
    expect(e.hint).toContain("Accepted time formats");
    expect(e.hint).toContain("f:375");
    expect(e.detail?.input).toBe(bad);
  });
  test("hint lists only the forms allowed in this context", () => {
    const e = catchError(() => parseTimeInput("abc", FPS30, { allowSamples: true, allowTimeline: true }));
    expect(e.hint).toContain("s:-960");
    expect(e.hint).toContain("timeline");
    const e2 = catchError(() => parseTimeInput("abc", FPS30, { allowRelative: false, allowEnd: false }));
    expect(e2.hint).not.toContain("end");
    expect(e2.hint).not.toContain("+f:15");
  });
});

describe("resolveAbsolute", () => {
  const abs = (frames: number): ParsedTime => ({ value: { kind: "absolute", frames }, raw: `f:${frames}` });
  test("absolute passes through", () => {
    expect(resolveAbsolute(abs(375), { fps: FPS30 })).toBe(375);
  });
  test("relative needs current", () => {
    const p = parseTimeInput("-2", FPS30);
    expect(resolveAbsolute(p, { fps: FPS30, current: 100 })).toBe(40);
    expect(resolveAbsolute(parseTimeInput("+f:15", FPS30), { fps: FPS30, current: 100 })).toBe(115);
    expect(catchError(() => resolveAbsolute(p, { fps: FPS30 })).code).toBe("E_INVALID_TIME");
    // 負になる
    expect(catchError(() => resolveAbsolute(p, { fps: FPS30, current: 30 })).code).toBe("E_INVALID_TIME");
    expect(resolveAbsolute(p, { fps: FPS30, current: 60 })).toBe(0);
  });
  test("end needs end", () => {
    expect(resolveAbsolute(parseTimeInput("end", FPS30), { fps: FPS30, end: 900 })).toBe(900);
    expect(resolveAbsolute(parseTimeInput("end-3", FPS30), { fps: FPS30, end: 900 })).toBe(810);
    expect(resolveAbsolute(parseTimeInput("end-f:10", FPS30), { fps: FPS30, end: 900 })).toBe(890);
    expect(catchError(() => resolveAbsolute(parseTimeInput("end-3", FPS30), { fps: FPS30 })).code).toBe(
      "E_INVALID_TIME",
    );
    expect(catchError(() => resolveAbsolute(parseTimeInput("end-3", FPS30), { fps: FPS30, end: 10 })).code).toBe(
      "E_INVALID_TIME",
    );
  });
  test("timeline needs timelineLength", () => {
    const p = parseTimeInput("timeline", FPS30, { allowTimeline: true });
    expect(resolveAbsolute(p, { fps: FPS30, timelineLength: 4500 })).toBe(4500);
    expect(catchError(() => resolveAbsolute(p, { fps: FPS30 })).code).toBe("E_INVALID_TIME");
  });
  test("samples cannot resolve to a frame", () => {
    const p = parseTimeInput("s:-960", FPS30, { allowSamples: true });
    const e = catchError(() => resolveAbsolute(p, { fps: FPS30, current: 0, end: 0, timelineLength: 0 }));
    expect(e.code).toBe("E_INVALID_TIME");
    expect(e.hint).toContain("audio offset");
  });
});

/**
 * docs/13 B-11: yargs（17）の負数引数。実機で確かめた挙動を固定する。
 * - `--in -10` / `--in -0.5` … 数値に見えるので値として渡り、`--in=-10` と同じ結果になる
 * - `--in -f:300` / `--out -12:30` … 短縮フラグとして読まれ `E_USAGE: Unknown argument: f`
 *   → どちらも `=` 形式なら確実に値として渡るので、エラーの hint でその書き方を案内する
 */
describe("負の時間表記（B-11）", () => {
  test("= は yargs 側の話で、値として届けば解釈は同じ relative", () => {
    // `--in -10` / `--in=-10` / `--in=-f:300` はいずれもここには同じ文字列で届く
    expect(parseTimeInput("-10", FPS30).value).toEqual({ kind: "relative", deltaFrames: -300 });
    expect(parseTimeInput("-f:300", FPS30).value).toEqual({ kind: "relative", deltaFrames: -300 });
  });

  test("`-` で始まる入力のエラーは = 形式を案内する", () => {
    const e = catchError(() => parseTimeInput("-abc", FPS30, ALL));
    expect(e.code).toBe("E_INVALID_TIME");
    expect(e.hint).toContain("--in=-10");
    expect(e.hint).toContain("--in=-f:300");
    // `-` で始まらない入力には足さない
    expect(catchError(() => parseTimeInput("abc", FPS30, ALL)).hint).not.toContain("--in=-10");
  });

  test("findSwallowedNegativeTime は短縮フラグとして食われる並びだけを拾う", () => {
    // yargs が短縮フラグとして読んでしまう形（数値に見えない負値）
    expect(findSwallowedNegativeTime(["clip", "add", "--in", "-f:300"])).toEqual({
      option: "--in",
      value: "-f:300",
    });
    expect(findSwallowedNegativeTime(["clip", "trim", "c1", "--out", "-12:30"])).toEqual({
      option: "--out",
      value: "-12:30",
    });
    expect(findSwallowedNegativeTime(["audio", "offset", "a", "--by", "-s:960"])).toEqual({
      option: "--by",
      value: "-s:960",
    });
    // yargs が値として渡してくれる形・すでに = 形式・無関係な並びは拾わない
    expect(findSwallowedNegativeTime(["clip", "add", "--in", "-10"])).toBeNull();
    expect(findSwallowedNegativeTime(["clip", "add", "--in", "-0.5"])).toBeNull();
    expect(findSwallowedNegativeTime(["clip", "add", "--in=-f:300"])).toBeNull();
    expect(findSwallowedNegativeTime(["clip", "add", "--asset", "a"])).toBeNull();
    expect(findSwallowedNegativeTime(["-f:300"])).toBeNull();
  });
});
