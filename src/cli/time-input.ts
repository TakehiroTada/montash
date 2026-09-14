/**
 * 時間の入力表記（docs/04 §1.3）→ フレーム／サンプルへの解釈。
 *
 * | 形式 | 例 | 結果 |
 * |------|----|------|
 * | 秒 | `12.5` | absolute（`round(12.5 * num/den)` フレーム。丸めたら W_SNAPPED） |
 * | タイムコード | `00:00:12.500`, `1:02:03`, `12:30`, `12:30.5` | absolute（同様に丸め） |
 * | フレーム | `f:375` | absolute（丸めなし） |
 * | 相対 | `+0.5`, `-2`, `+f:15`, `-f:2` | relative（現在値からの増減） |
 * | 末尾基準 | `end`, `end-3`, `end-f:10` | end（末尾からのオフセット。0 以下） |
 * | キーワード | `timeline` | timeline（タイムライン全長） |
 * | サンプル | `s:-960` | samples（`audio offset --by` 専用） |
 *
 * 値はすべて yargs から文字列で受け取る（docs/12 ADR-04）。`--in -10` は "-10" として relative になる
 * （負の絶対値は存在しないので仕様どおり。`--in=-10` の `=` 形式は yargs 側の話でここでは区別しない）。
 */
import { type Fps, fpsLabel, secondsToFrames } from "../core/time.ts";
import { MontashError, type Warning, warning } from "./errors.ts";

export type TimeInput =
  | { kind: "absolute"; frames: number }
  | { kind: "relative"; deltaFrames: number }
  | { kind: "end"; offsetFrames: number }
  | { kind: "timeline" }
  | { kind: "samples"; samples: number };

export interface ParsedTime {
  value: TimeInput;
  /** 秒／タイムコードをフレームに丸めた場合の W_SNAPPED */
  warning?: Warning;
  /** 入力文字列（trim 済み） */
  raw: string;
}

export interface ParseTimeOptions {
  /** `+0.5` / `-2` / `+f:15` を受理する（既定 true） */
  allowRelative?: boolean;
  /** `end` / `end-3` / `end-f:10` を受理する（既定 true） */
  allowEnd?: boolean;
  /** `timeline` を受理する（既定 false。`--duration` 用） */
  allowTimeline?: boolean;
  /** `s:-960` を受理する（既定 false。`audio offset --by` 用） */
  allowSamples?: boolean;
}

export interface ResolveContext {
  fps: Fps;
  /** relative の基準となる現在値（フレーム） */
  current?: number;
  /** end の基準となる末尾（フレーム） */
  end?: number;
  /** timeline の値（フレーム） */
  timelineLength?: number;
}

// ---------------------------------------------------------------------------
// 字句
// ---------------------------------------------------------------------------

/** 秒: "12" / "12.5" / ".5" */
const RE_SECONDS = /^(\d+(?:\.\d*)?|\.\d+)$/;
/** フレーム: "f:375" */
const RE_FRAMES = /^f:(\d+)$/;
/** サンプル: "s:-960" */
const RE_SAMPLES = /^s:([+-]?\d+)$/;
/** タイムコード: [[H:]MM:]SS[.mmm]。時は任意桁、分・秒は 1〜2 桁（< 60）、ミリ秒は 1〜3 桁 */
const RE_TIMECODE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/;

function acceptedForms(opts: Required<ParseTimeOptions>): string {
  const forms = ["seconds (12.5)", "timecode (00:00:12.500, 1:02:03, 12:30)", "frames (f:375)"];
  if (opts.allowRelative) forms.push("relative (+0.5, -2, +f:15, -f:2)");
  if (opts.allowEnd) forms.push("end-relative (end, end-3, end-f:10)");
  if (opts.allowTimeline) forms.push("timeline");
  if (opts.allowSamples) forms.push("samples (s:-960)");
  return `Accepted time formats: ${forms.join(", ")}.`;
}

function invalidTime(raw: string, why: string, opts: Required<ParseTimeOptions>, extraHint?: string): MontashError {
  return new MontashError("E_INVALID_TIME", `invalid time ${JSON.stringify(raw)}: ${why}`, {
    hint: extraHint ? `${extraHint} ${acceptedForms(opts)}` : acceptedForms(opts),
    detail: { input: raw },
  });
}

/** 秒／タイムコード／`f:N` の「符号なしの量」をフレームに変換する。秒系は丸め情報を返す */
interface Magnitude {
  frames: number;
  /** 秒／タイムコード由来で丸めが生じた場合の情報 */
  snapped?: { seconds: number; exactSeconds: number };
}

function parseMagnitude(text: string, fps: Fps): Magnitude | null {
  const fm = RE_FRAMES.exec(text);
  if (fm) {
    const frames = Number(fm[1]);
    if (!Number.isSafeInteger(frames)) return null;
    return { frames };
  }
  const seconds = parseSecondsOrTimecode(text);
  if (seconds === null) return null;
  const r = secondsToFrames(seconds, fps);
  return r.snapped ? { frames: r.frames, snapped: { seconds, exactSeconds: r.exactSeconds } } : { frames: r.frames };
}

/** 秒表記またはタイムコード表記を秒（浮動小数）に変換する。形式外なら null */
function parseSecondsOrTimecode(text: string): number | null {
  if (RE_SECONDS.test(text)) {
    const v = Number(text);
    return Number.isFinite(v) ? v : null;
  }
  const tc = RE_TIMECODE.exec(text);
  if (tc) {
    const h = tc[1] !== undefined ? Number(tc[1]) : 0;
    const m = Number(tc[2]);
    const s = Number(tc[3]);
    if (m >= 60 || s >= 60) return null;
    // ".5" → 500ms、".50" → 500ms、".500" → 500ms
    const ms = tc[4] !== undefined ? Number(tc[4].padEnd(3, "0")) : 0;
    const totalMs = ((h * 60 + m) * 60 + s) * 1000 + ms;
    return Number.isSafeInteger(totalMs) ? totalMs / 1000 : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// パース
// ---------------------------------------------------------------------------

export function parseTimeInput(raw: string, fps: Fps, options: ParseTimeOptions = {}): ParsedTime {
  const opts: Required<ParseTimeOptions> = {
    allowRelative: options.allowRelative ?? true,
    allowEnd: options.allowEnd ?? true,
    allowTimeline: options.allowTimeline ?? false,
    allowSamples: options.allowSamples ?? false,
  };
  if (typeof raw !== "string") throw invalidTime(String(raw), "expected a string", opts);
  const text = raw.trim();
  if (text === "") throw invalidTime(raw, "empty value", opts);

  // キーワード
  if (text === "timeline") {
    if (!opts.allowTimeline) throw invalidTime(text, '"timeline" is not accepted here', opts);
    return { value: { kind: "timeline" }, raw: text };
  }

  // サンプル s:-960
  const sm = RE_SAMPLES.exec(text);
  if (sm) {
    if (!opts.allowSamples) throw invalidTime(text, "sample notation is only accepted for audio offsets", opts);
    const samples = Number(sm[1]);
    if (!Number.isSafeInteger(samples)) throw invalidTime(text, "sample count is out of range", opts);
    return { value: { kind: "samples", samples }, raw: text };
  }

  // 末尾基準 end / end-3 / end-f:10
  if (text === "end" || text.startsWith("end-")) {
    if (!opts.allowEnd) throw invalidTime(text, '"end" is not accepted here', opts);
    if (text === "end") return { value: { kind: "end", offsetFrames: 0 }, raw: text };
    const mag = parseMagnitude(text.slice("end-".length), fps);
    if (!mag) throw invalidTime(text, 'expected "end", "end-<seconds>" or "end-f:<frames>"', opts);
    return {
      value: { kind: "end", offsetFrames: -mag.frames },
      raw: text,
      ...snappedWarning(text, mag, fps, `end-f:${mag.frames}`),
    };
  }

  // 相対 +0.5 / -2 / +f:15 / -f:2
  const sign = text[0];
  if (sign === "+" || sign === "-") {
    if (!opts.allowRelative) {
      throw invalidTime(
        text,
        "relative (signed) values are not accepted here",
        opts,
        "Absolute times cannot be negative.",
      );
    }
    const mag = parseMagnitude(text.slice(1), fps);
    if (!mag) throw invalidTime(text, `expected "${sign}<seconds>" or "${sign}f:<frames>"`, opts);
    const delta = sign === "-" ? -mag.frames : mag.frames;
    return {
      value: { kind: "relative", deltaFrames: delta },
      raw: text,
      ...snappedWarning(text, mag, fps, `${sign}f:${mag.frames}`),
    };
  }

  // 絶対 f:375 / 12.5 / 00:00:12.500
  const mag = parseMagnitude(text, fps);
  if (!mag) throw invalidTime(text, "unrecognized time format", opts);
  return {
    value: { kind: "absolute", frames: mag.frames },
    raw: text,
    ...snappedWarning(text, mag, fps, `f:${mag.frames}`),
  };
}

/** 丸めが生じていれば W_SNAPPED を組み立てる（docs/04 §1.3: `{ input, frame, seconds }`） */
function snappedWarning(
  input: string,
  mag: Magnitude,
  fps: Fps,
  suggest: string,
): { warning: Warning } | Record<never, never> {
  if (!mag.snapped) return {};
  return {
    warning: warning(
      "W_SNAPPED",
      `${JSON.stringify(input)} is not on a frame boundary at ${fpsLabel(fps)} fps; snapped to frame ${mag.frames} (${formatSeconds(mag.snapped.exactSeconds)} s)`,
      {
        hint: `Use ${suggest} to refer to this exact frame and avoid re-rounding.`,
        detail: {
          input,
          frame: mag.frames,
          seconds: mag.snapped.exactSeconds,
          requested_seconds: mag.snapped.seconds,
          suggest,
        },
      },
    ),
  };
}

function formatSeconds(s: number): string {
  // 表示用: 末尾の 0 を落としつつマイクロ秒精度まで
  return s.toFixed(6).replace(/\.?0+$/, "");
}

// ---------------------------------------------------------------------------
// 解決
// ---------------------------------------------------------------------------

/**
 * relative / end / timeline を絶対フレーム（非負整数）へ解決する。
 * 基準値が無い・負になる・samples は E_INVALID_TIME。
 */
export function resolveAbsolute(parsed: ParsedTime, ctx: ResolveContext): number {
  const v = parsed.value;
  const fail = (why: string, hint?: string): MontashError =>
    new MontashError("E_INVALID_TIME", `cannot resolve time ${JSON.stringify(parsed.raw)}: ${why}`, {
      ...(hint !== undefined ? { hint } : {}),
      detail: { input: parsed.raw, kind: v.kind },
    });

  let frames: number;
  switch (v.kind) {
    case "absolute":
      frames = v.frames;
      break;
    case "relative":
      if (ctx.current === undefined)
        throw fail(
          "a relative value needs a current value to apply to",
          "Use an absolute time (12.5, 00:00:12.500 or f:375).",
        );
      frames = ctx.current + v.deltaFrames;
      break;
    case "end":
      if (ctx.end === undefined)
        throw fail('"end" is not available in this context', "Use an absolute time (12.5, 00:00:12.500 or f:375).");
      frames = ctx.end + v.offsetFrames;
      break;
    case "timeline":
      if (ctx.timelineLength === undefined) throw fail('"timeline" is not available in this context');
      frames = ctx.timelineLength;
      break;
    case "samples":
      throw fail(
        "a sample count is not a frame position",
        "Sample notation (s:-960) is only valid for `audio offset --by`.",
      );
  }
  if (!Number.isSafeInteger(frames)) throw fail("result is out of range");
  if (frames < 0) {
    throw fail(
      `result is negative (${frames} frames at ${fpsLabel(ctx.fps)} fps)`,
      "The resolved time must be at or after frame 0.",
    );
  }
  return frames;
}
