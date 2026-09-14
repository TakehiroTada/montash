import { beforeAll, describe, expect, test } from "bun:test";
import { ExitCode, MontashError } from "../../../src/cli/errors.ts";
import { ensureFixtures } from "../../../src/ffmpeg/fixtures.ts";
import { type Binaries, locateBinaries } from "../../../src/ffmpeg/locate.ts";
import {
  classifyFfmpegFailure,
  type Progress,
  parseProgressBlock,
  runFfmpeg,
  shellQuote,
} from "../../../src/ffmpeg/run.ts";

let bins: Binaries;
let fx: Record<string, string>;

beforeAll(async () => {
  bins = locateBinaries();
  fx = await ensureFixtures(bins);
}, 60_000);

async function expectMontashError(p: Promise<unknown>): Promise<MontashError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MontashError);
    return e as MontashError;
  }
  throw new Error("expected a MontashError to be thrown");
}

describe("ffmpeg/run (pure)", () => {
  test("parseProgressBlock maps key=value lines and computes percent from totalFrames", () => {
    const lines = [
      "frame=75",
      "fps=120.5",
      "stream_0_0_q=28.0",
      "bitrate=N/A",
      "total_size=N/A",
      "out_time_us=2500000",
      "out_time_ms=2500000",
      "out_time=00:00:02.500000",
      "dup_frames=0",
      "drop_frames=0",
      "speed=4.02x",
      "progress=continue",
    ];
    const p = parseProgressBlock(lines, { totalFrames: 150, elapsedMs: 1000 });
    expect(p.frame).toBe(75);
    expect(p.fps).toBe(120.5);
    expect(p.out_time_us).toBe(2_500_000);
    expect(p.out_time_s).toBe(2.5);
    expect(p.speed).toBe("4.02x");
    expect(p.total_size).toBeUndefined();
    expect(p.status).toBe("continue");
    expect(p.percent).toBe(50);
    expect(p.eta_s).toBeCloseTo(1, 5);
  });

  test("parseProgressBlock falls back to totalDurationS and clamps / finalizes on end", () => {
    const byDuration = parseProgressBlock(["out_time_us=1000000", "progress=continue"], { totalDurationS: 4 });
    expect(byDuration.percent).toBe(25);
    expect(byDuration.frame).toBeUndefined();
    const over = parseProgressBlock(["frame=200", "progress=continue"], { totalFrames: 150 });
    expect(over.percent).toBe(100);
    const end = parseProgressBlock(["frame=149", "total_size=12345", "progress=end"], {
      totalFrames: 150,
      elapsedMs: 500,
    });
    expect(end.status).toBe("end");
    expect(end.percent).toBe(100);
    expect(end.eta_s).toBe(0);
    expect(end.total_size).toBe(12345);
    const none = parseProgressBlock(["frame=10", "progress=continue"]);
    expect(none.percent).toBeNull();
    expect(none.eta_s).toBeNull();
  });

  test("shellQuote leaves safe args bare and quotes spaces, quotes, globs; round-trips through sh", async () => {
    expect(shellQuote(["ffmpeg", "-i", "a.mp4", "-vf", "scale=640:360"])).toBe("ffmpeg -i a.mp4 -vf scale=640:360");
    expect(shellQuote(["my file.mp4"])).toBe("'my file.mp4'");
    expect(shellQuote(["it's"])).toBe(`'it'\\''s'`);
    expect(shellQuote([""])).toBe("''");
    expect(shellQuote(["[0:v]scale=640:360[v]"])).toBe("'[0:v]scale=640:360[v]'");

    const args = [
      "plain",
      "with space",
      "it's quoted",
      '"double"',
      "[0:v]trim=end_frame=30;[1:a]adelay=1000S",
      "a:b:c",
      "$HOME",
      "`x`",
      "日本語 ファイル.mp4",
      "*",
      "",
    ];
    const cmd = shellQuote(["printf", "%s\\n", ...args]);
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    // 末尾の空文字も 1 行として出力されるので、最後の改行だけ落とす
    expect(out.replace(/\n$/, "").split("\n")).toEqual(args);
  });

  test("classifyFfmpegFailure maps known stderr patterns", () => {
    expect(classifyFfmpegFailure(["[in#0] Error opening input: No such file or directory"])?.code).toBe(
      "E_ASSET_MISSING",
    );
    expect(classifyFfmpegFailure(["No such filter: 'xfadez'"])?.code).toBe("E_FFMPEG_FEATURE_MISSING");
    expect(classifyFfmpegFailure(["Unknown encoder 'libx265'"])?.code).toBe("E_FFMPEG_FEATURE_MISSING");
    expect(
      classifyFfmpegFailure(["[Parsed_subtitles_0] fontselect: failed to find any fallback with glyph 0x3042"])?.code,
    ).toBe("E_FONT_NOT_FOUND");
    expect(classifyFfmpegFailure(["Fontconfig error: Cannot load default config file"])?.code).toBe("E_FONT_NOT_FOUND");
    expect(classifyFfmpegFailure(["Cannot find a valid font for the family Sans"])?.code).toBe("E_FONT_NOT_FOUND");
    expect(classifyFfmpegFailure(["Conversion failed!"])).toBeUndefined();
  });
});

describe("ffmpeg/run (real ffmpeg)", () => {
  test("5s → -f null: progress ≥1, final percent ≈100, exit 0", async () => {
    const progress: Progress[] = [];
    const stderr: string[] = [];
    const logs: string[] = [];
    const res = await runFfmpeg(bins, ["-i", fx.a!, "-f", "null", "-"], {
      totalFrames: 150,
      onProgress: (p) => progress.push(p),
      onStderrLine: (l) => stderr.push(l),
      log: (l) => logs.push(l),
    });
    expect(res.exitCode).toBe(0);
    expect(res.durationMs).toBeGreaterThan(0);
    expect(res.args.slice(0, 4)).toEqual(["-hide_banner", "-nostats", "-progress", "pipe:1"]);
    expect(progress.length).toBeGreaterThanOrEqual(1);
    const last = progress.at(-1)!;
    expect(last.status).toBe("end");
    expect(last.frame).toBe(150);
    expect(last.percent).toBeGreaterThanOrEqual(99);
    expect(last.out_time_s).toBeGreaterThan(4.9);
    // -nostats なので stderr に進捗行は出ない（stderrTail は 30 行以内）
    expect(res.stderrTail.length).toBeLessThanOrEqual(30);
    expect(logs[0]).toContain("-progress pipe:1");
    expect(logs.at(-1)).toContain("exited 0");
  });

  test("percent from totalDurationS when totalFrames is absent (audio only)", async () => {
    const progress: Progress[] = [];
    await runFfmpeg(bins, ["-i", fx.tone!, "-f", "null", "-"], {
      totalDurationS: 10,
      onProgress: (p) => progress.push(p),
    });
    expect(progress.at(-1)?.percent).toBe(100);
  });

  test("invalid args → E_FFMPEG_FAILED with non-empty stderr_tail", async () => {
    const err = await expectMontashError(runFfmpeg(bins, ["-i", fx.a!, "-vf", "scale=abc", "-f", "null", "-"]));
    expect(err.code).toBe("E_FFMPEG_FAILED");
    expect(err.exitCode).toBe(ExitCode.EXTERNAL);
    const tail = err.detail?.stderr_tail as string[];
    expect(Array.isArray(tail)).toBe(true);
    expect(tail.length).toBeGreaterThan(0);
    expect(typeof err.detail?.exit_code).toBe("number");
    expect(err.detail?.exit_code).not.toBe(0);
    expect(err.detail?.args).toContain("scale=abc");
  });

  test("missing input → E_ASSET_MISSING", async () => {
    const err = await expectMontashError(runFfmpeg(bins, ["-i", "/nonexistent/dir/nope.mp4", "-f", "null", "-"]));
    expect(err.code).toBe("E_ASSET_MISSING");
    expect(err.exitCode).toBe(ExitCode.IO);
    const tail = (err.detail?.stderr_tail as string[] | undefined) ?? [];
    expect(tail.join("\n")).toMatch(/No such file or directory/);
  });

  test("unknown filter → E_FFMPEG_FEATURE_MISSING", async () => {
    const err = await expectMontashError(
      runFfmpeg(bins, ["-i", fx.a!, "-vf", "definitely_not_a_filter", "-f", "null", "-"]),
    );
    expect(err.code).toBe("E_FFMPEG_FEATURE_MISSING");
  });

  test("cancel: abort after 300ms → E_FFMPEG_CANCELLED within 3s, process gone", async () => {
    const ac = new AbortController();
    const t0 = performance.now();
    let progressSeen = 0;
    setTimeout(() => ac.abort(), 300);
    // -stream_loop -1 で無限に走らせ、-re で実時間再生させて確実に長時間化する
    const err = await expectMontashError(
      runFfmpeg(bins, ["-re", "-stream_loop", "-1", "-i", fx.a!, "-f", "null", "-"], {
        signal: ac.signal,
        onProgress: () => progressSeen++,
      }),
    );
    const elapsed = performance.now() - t0;
    expect(err.code).toBe("E_FFMPEG_CANCELLED");
    expect(err.exitCode).toBe(ExitCode.INTERRUPTED);
    expect(elapsed).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThanOrEqual(290);
    // ffmpeg は SIGTERM を受けて自ら終了する（exit 255）か、猶予後に SIGKILL される
    const exit = err.detail?.exit_code;
    const sig = err.detail?.signal;
    expect(exit !== 0 || sig !== null).toBe(true);
    // 子プロセスが残っていないこと: 同じ入力を掴んでいる ffmpeg が無い
    const ps = Bun.spawn(["pgrep", "-f", `stream_loop -1 -i ${fx.a}`], { stdout: "pipe", stderr: "pipe" });
    const psOut = await new Response(ps.stdout).text();
    await ps.exited;
    expect(psOut.trim()).toBe("");
  }, 10_000);

  test("already-aborted signal → E_FFMPEG_CANCELLED without spawning", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await expectMontashError(runFfmpeg(bins, ["-i", fx.a!, "-f", "null", "-"], { signal: ac.signal }));
    expect(err.code).toBe("E_FFMPEG_CANCELLED");
  });

  test("timeoutMs → E_FFMPEG_TIMEOUT", async () => {
    const t0 = performance.now();
    const err = await expectMontashError(
      runFfmpeg(bins, ["-re", "-stream_loop", "-1", "-i", fx.a!, "-f", "null", "-"], { timeoutMs: 300 }),
    );
    expect(err.code).toBe("E_FFMPEG_TIMEOUT");
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(err.detail?.timeout_ms).toBe(300);
  }, 10_000);

  test("progressIntervalS controls -stats_period and progress cadence", async () => {
    // -re で実時間 1.2 秒だけ流し、0.2 秒間隔の進捗が複数回届くこと
    const times: number[] = [];
    const t0 = performance.now();
    await runFfmpeg(bins, ["-re", "-t", "1.2", "-i", fx.a!, "-f", "null", "-"], {
      totalDurationS: 1.2,
      progressIntervalS: 0.2,
      onProgress: () => times.push(performance.now() - t0),
    });
    expect(times.length).toBeGreaterThanOrEqual(3);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(avg).toBeGreaterThan(50);
    expect(avg).toBeLessThan(600);
  }, 10_000);
});
