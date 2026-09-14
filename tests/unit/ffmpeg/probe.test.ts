import { beforeAll, describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import { ensureFixtures } from "../../../src/ffmpeg/fixtures.ts";
import { type Binaries, locateBinaries } from "../../../src/ffmpeg/locate.ts";
import {
  durationFrames,
  parseRationalFps,
  pixFmtHasAlpha,
  probeFile,
  summarizeProbe,
} from "../../../src/ffmpeg/probe.ts";

let bins: Binaries;
let fx: Record<string, string>;

beforeAll(async () => {
  bins = locateBinaries();
  fx = await ensureFixtures(bins);
}, 60_000);

describe("ffmpeg/probe (pure)", () => {
  test("parseRationalFps", () => {
    expect(parseRationalFps("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseRationalFps("30/1")).toEqual({ num: 30, den: 1 });
    expect(parseRationalFps("30")).toEqual({ num: 30, den: 1 });
    expect(parseRationalFps("60000/2000")).toEqual({ num: 30, den: 1 });
    expect(parseRationalFps("0/0")).toBeNull();
    expect(parseRationalFps("0/1")).toBeNull();
    expect(parseRationalFps("abc")).toBeNull();
    expect(parseRationalFps("")).toBeNull();
  });

  test("durationFrames is floor(duration_s * num/den)", () => {
    expect(durationFrames(5.0, { num: 30000, den: 1001 })).toBe(149);
    expect(durationFrames(5.0, { num: 30, den: 1 })).toBe(150);
    // 14.214 * 30000 / 1001 = 425.99… → 425（docs/05 の例示値 426 は round 相当。ADR-09 は floor）
    expect(durationFrames(14.214, { num: 30000, den: 1001 })).toBe(425);
    expect(durationFrames(10.01, { num: 30000, den: 1001 })).toBe(300);
    expect(durationFrames(0, { num: 30, den: 1 })).toBe(0);
    // float 誤差で 1 フレーム落ちない（0.1 * 30 = 3.0000000000000004, 0.7 * 10 = 7.000000000000001 など）
    expect(durationFrames(0.7, { num: 10, den: 1 })).toBe(7);
    expect(durationFrames(2.9, { num: 10, den: 1 })).toBe(29);
  });

  test("pixFmtHasAlpha", () => {
    expect(pixFmtHasAlpha("rgba")).toBe(true);
    expect(pixFmtHasAlpha("yuva420p")).toBe(true);
    expect(pixFmtHasAlpha("argb")).toBe(true);
    expect(pixFmtHasAlpha("gbrap10le")).toBe(true);
    expect(pixFmtHasAlpha("yuv420p")).toBe(false);
    expect(pixFmtHasAlpha("gray")).toBe(false);
    expect(pixFmtHasAlpha("rgb24")).toBe(false);
    expect(pixFmtHasAlpha(undefined)).toBe(false);
  });

  test("summarizeProbe: rotation from side_data_list / tags, VFR falls back to avg_frame_rate", () => {
    const raw = {
      streams: [
        {
          codec_type: "video",
          codec_name: "hevc",
          width: 1920,
          height: 1080,
          pix_fmt: "yuv420p",
          r_frame_rate: "90000/1",
          avg_frame_rate: "30000/1001",
          nb_frames: "300",
          side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
        },
        { codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 },
      ],
      format: {
        format_name: "mov,mp4,m4a,3gp,3g2,mj2",
        duration: "10.010000",
        start_time: "0.000000",
        bit_rate: "8000000",
      },
    };
    const s = summarizeProbe(raw);
    expect(s.type).toBe("video");
    expect(s.video?.rotation).toBe(270);
    expect(s.video?.fps).toEqual({ num: 30000, den: 1001 });
    expect(s.audio).toEqual({ codec: "aac", sample_rate: 44100, channels: 2 });
    expect(s.container).toEqual({ format: "mov,mp4,m4a,3gp,3g2,mj2", bit_rate: 8000000 });
    expect(s.duration_s).toBe(10.01);

    const tagged = summarizeProbe({
      streams: [
        {
          codec_type: "video",
          codec_name: "h264",
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          tags: { rotate: "90" },
        },
      ],
      format: {},
    });
    expect(tagged.video?.rotation).toBe(90);
  });

  test("summarizeProbe: mp3 with cover art is audio", () => {
    const s = summarizeProbe({
      streams: [
        { codec_type: "audio", codec_name: "mp3", sample_rate: "44100", channels: 2 },
        { codec_type: "video", codec_name: "mjpeg", width: 500, height: 500, disposition: { attached_pic: 1 } },
      ],
      format: { format_name: "mp3", duration: "180.5" },
    });
    expect(s.type).toBe("audio");
    expect(s.video).toBeUndefined();
    expect(s.duration_s).toBe(180.5);
  });

  test("summarizeProbe: no streams throws E_ASSET_UNREADABLE", () => {
    expect(() => summarizeProbe({ streams: [], format: {} })).toThrow(MontashError);
    try {
      summarizeProbe({});
    } catch (e) {
      expect((e as MontashError).code).toBe("E_ASSET_UNREADABLE");
    }
  });
});

describe("ffmpeg/probe (real ffprobe)", () => {
  test("a.mp4: video 640x360 30/1 ≈5s, aac 48000/2", async () => {
    const { summary, raw } = await probeFile(bins, fx.a!);
    expect(summary.type).toBe("video");
    expect(summary.video?.codec).toBe("h264");
    expect(summary.video?.width).toBe(640);
    expect(summary.video?.height).toBe(360);
    expect(summary.video?.fps).toEqual({ num: 30, den: 1 });
    expect(summary.video?.pix_fmt).toBe("yuv420p");
    expect(summary.video?.has_alpha).toBe(false);
    expect(summary.video?.rotation).toBe(0);
    expect(summary.duration_s).not.toBeNull();
    expect(Math.abs((summary.duration_s ?? 0) - 5)).toBeLessThan(0.15);
    expect(summary.start_time_s).toBe(0);
    expect(summary.audio).toEqual({ codec: "aac", sample_rate: 48000, channels: 2 });
    expect(summary.container.format).toContain("mp4");
    expect(summary.container.bit_rate).toBeGreaterThan(0);
    expect(durationFrames(summary.duration_s ?? 0, summary.video!.fps)).toBeGreaterThanOrEqual(150);
    // 生 JSON は ffprobe の形（streams / format）をそのまま持つ
    expect(Array.isArray((raw as { streams: unknown }).streams)).toBe(true);
  });

  test("a2997.mp4: fps 30000/1001", async () => {
    const { summary } = await probeFile(bins, fx.a2997!);
    expect(summary.video?.fps).toEqual({ num: 30000, den: 1001 });
    expect(durationFrames(summary.duration_s ?? 0, summary.video!.fps)).toBeGreaterThanOrEqual(149);
  });

  test("tone.wav: audio only", async () => {
    const { summary } = await probeFile(bins, fx.tone!);
    expect(summary.type).toBe("audio");
    expect(summary.video).toBeUndefined();
    expect(summary.audio).toEqual({ codec: "pcm_s16le", sample_rate: 48000, channels: 2 });
    expect(Math.abs((summary.duration_s ?? 0) - 10)).toBeLessThan(0.01);
    expect(summary.container.format).toBe("wav");
  });

  test("logo.png: image with alpha, duration null", async () => {
    const { summary } = await probeFile(bins, fx.logo!);
    expect(summary.type).toBe("image");
    expect(summary.duration_s).toBeNull();
    expect(summary.video?.codec).toBe("png");
    expect(summary.video?.width).toBe(256);
    expect(summary.video?.height).toBe(128);
    expect(summary.video?.pix_fmt).toBe("rgba");
    expect(summary.video?.has_alpha).toBe(true);
    expect(summary.audio).toBeUndefined();
  });

  test("b60.mp4: 1280x720 60/1", async () => {
    const { summary } = await probeFile(bins, fx.b60!);
    expect(summary.video?.width).toBe(1280);
    expect(summary.video?.fps).toEqual({ num: 60, den: 1 });
    expect(durationFrames(summary.duration_s ?? 0, summary.video!.fps)).toBeGreaterThanOrEqual(180);
  });

  test("missing file → E_ASSET_UNREADABLE with path and stderr_tail", async () => {
    const missing = "/nonexistent/dir/nope.mp4";
    let err: unknown;
    try {
      await probeFile(bins, missing);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MontashError);
    const me = err as MontashError;
    expect(me.code).toBe("E_ASSET_UNREADABLE");
    expect(me.detail?.path).toBe(missing);
    expect(Array.isArray(me.detail?.stderr_tail)).toBe(true);
    const tail = me.detail?.stderr_tail as string[] | undefined;
    expect(tail?.length ?? 0).toBeGreaterThan(0);
  });
});
