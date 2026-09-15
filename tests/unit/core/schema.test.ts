import { describe, expect, test } from "bun:test";
import { createProject } from "../../../src/core/project.ts";
import {
  AssetSchema,
  ClipSchema,
  clipDurationF,
  clipEndF,
  clipKind,
  FpsSchema,
  ProjectSchema,
  SCHEMA_VERSION,
  SettingsSchema,
  TextClipSchema,
  TrackClipSchema,
  TrackSchema,
  TransitionSchema,
} from "../../../src/core/schema.ts";

const fps = { num: 30000, den: 1001 };

describe("FpsSchema / SettingsSchema", () => {
  test("accepts positive integer rationals", () => {
    expect(FpsSchema.parse(fps)).toEqual(fps);
  });
  test("rejects zero, negative, fractional and float fps", () => {
    expect(FpsSchema.safeParse({ num: 0, den: 1 }).success).toBe(false);
    expect(FpsSchema.safeParse({ num: 30, den: -1 }).success).toBe(false);
    expect(FpsSchema.safeParse({ num: 29.97, den: 1 }).success).toBe(false);
    expect(FpsSchema.safeParse(29.97).success).toBe(false);
  });
  test("settings fill defaults and keep unknown fields", () => {
    const s = SettingsSchema.parse({
      fps,
      resolution: { width: 1920, height: 1080 },
      default_image_duration_f: 150,
      future_field: "kept",
    });
    expect(s.sample_rate).toBe(48000);
    expect(s.channels).toBe(2);
    expect(s.text_engine).toBe("libass");
    expect(s.proxy).toEqual({ height: 360, crf: 28 });
    expect((s as Record<string, unknown>).future_field).toBe("kept");
  });
  test("rejects unknown text_engine", () => {
    expect(
      SettingsSchema.safeParse({
        fps,
        resolution: { width: 1920, height: 1080 },
        default_image_duration_f: 150,
        text_engine: "gdi",
      }).success,
    ).toBe(false);
  });
});

describe("AssetSchema", () => {
  test("accepts each asset type", () => {
    const base = { id: "a", path: "./assets/a" };
    for (const type of ["video", "audio", "image", "subtitle", "text"] as const) {
      expect(AssetSchema.safeParse({ ...base, type }).success).toBe(true);
    }
  });
  test("video asset carries summary only (probe raw JSON is not a schema field but is kept as unknown)", () => {
    const a = AssetSchema.parse({
      id: "clip_a",
      type: "video",
      path: "/raw/clip_a.mp4",
      duration_s: 14.214,
      duration_f: 426,
      video: { codec: "h264", width: 3840, height: 2160, fps, pix_fmt: "yuv420p", has_alpha: false, rotation: 0 },
      audio: { codec: "aac", sample_rate: 48000, channels: 2 },
      derived: { proxy: { state: "ready", path: ".montash/cache/clip_a/proxy.mp4" }, waveform: { state: "missing" } },
    });
    expect(a.type).toBe("video");
    expect(a.duration_f).toBe(426);
    expect(a.owned).toBe(false);
    expect(a.tags).toEqual([]);
  });
  test("image asset allows null duration", () => {
    const a = AssetSchema.parse({ id: "logo", type: "image", path: "logo.png", duration_s: null, duration_f: null });
    expect(a.duration_f).toBeNull();
  });
  test("rejects unknown type, fractional duration_f and bad derived state", () => {
    expect(AssetSchema.safeParse({ id: "a", type: "midi", path: "x" }).success).toBe(false);
    expect(AssetSchema.safeParse({ id: "a", type: "video", path: "x", duration_f: 12.5 }).success).toBe(false);
    expect(
      AssetSchema.safeParse({ id: "a", type: "video", path: "x", derived: { proxy: { state: "done" } } }).success,
    ).toBe(false);
  });
});

describe("ClipSchema", () => {
  test("accepts a media clip and fills defaults", () => {
    const c = ClipSchema.parse({ id: "c1", type: "media", asset: "clip_a", start_f: 0, in_f: 60, out_f: 435 });
    expect(c.speed).toBe(1);
    expect(c.link).toBeNull();
    expect(c.loop).toBe(false);
    expect(c.effects).toEqual([]);
  });
  test("rejects non-integer or negative _f", () => {
    expect(
      ClipSchema.safeParse({ id: "c1", type: "media", asset: "a", start_f: 0.5, in_f: 0, out_f: 10 }).success,
    ).toBe(false);
    expect(ClipSchema.safeParse({ id: "c1", type: "media", asset: "a", start_f: -1, in_f: 0, out_f: 10 }).success).toBe(
      false,
    );
    expect(
      ClipSchema.safeParse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: "10" }).success,
    ).toBe(false);
  });
  test("rejects non-positive speed", () => {
    expect(
      ClipSchema.safeParse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 10, speed: 0 }).success,
    ).toBe(false);
  });
  test("audio offset_smp may be negative", () => {
    const c = ClipSchema.parse({
      id: "c1a",
      type: "media",
      asset: "a",
      start_f: 0,
      in_f: 0,
      out_f: 10,
      audio: { offset_smp: -960 },
    });
    expect(c.audio?.offset_smp).toBe(-960);
  });
  test("video transform accepts px and percent", () => {
    const c = ClipSchema.parse({
      id: "c2",
      type: "media",
      asset: "logo",
      start_f: 0,
      in_f: 0,
      out_f: 30,
      video: { transform: { position: "top-right", margin: "5%", scale: 0.12 } },
    });
    expect(c.video?.transform?.position).toBe("top-right");
    expect(
      ClipSchema.safeParse({
        id: "c2",
        type: "media",
        asset: "logo",
        start_f: 0,
        in_f: 0,
        out_f: 30,
        video: { transform: { x: "5px" } },
      }).success,
    ).toBe(false);
  });
});

describe("TrackClipSchema union + clipKind", () => {
  test("distinguishes media / text / subtitle / generator", () => {
    const media = TrackClipSchema.parse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 10 });
    const text = TrackClipSchema.parse({ id: "x1", type: "text", start_f: 0, duration_f: 90, text: "hi" });
    const sub = TrackClipSchema.parse({ id: "s1", type: "subtitle", asset: "ja", start_f: 0 });
    const gen = TrackClipSchema.parse({
      id: "c9",
      type: "generator",
      generator: "color",
      params: { color: "#000" },
      start_f: 0,
      duration_f: 30,
    });
    expect([media, text, sub, gen].map(clipKind)).toEqual(["media", "text", "subtitle", "generator"]);
  });
  test("text clip defaults", () => {
    const x = TextClipSchema.parse({ id: "x1", type: "text", start_f: 0, duration_f: 90 });
    expect(x.markup).toBe("plain");
    expect(x.asset).toBeNull();
    expect(x.fade).toEqual({ in_f: 0, out_f: 0 });
    expect(TextClipSchema.safeParse({ id: "x1", type: "text", start_f: 0, duration_f: 0 }).success).toBe(false);
  });
  test("clipDurationF / clipEndF", () => {
    const c = ClipSchema.parse({ id: "c1", type: "media", asset: "a", start_f: 100, in_f: 60, out_f: 435 });
    expect(clipDurationF(c)).toBe(375);
    expect(clipEndF(c)).toBe(475);
    const fast = ClipSchema.parse({ id: "c2", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 10, speed: 4 });
    expect(clipDurationF(fast)).toBe(3); // round(10/4)=3 (2.5 → 3)
    const tiny = ClipSchema.parse({ id: "c3", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 1, speed: 100 });
    expect(clipDurationF(tiny)).toBe(1); // max(1, ...)
    const text = TextClipSchema.parse({ id: "x1", type: "text", start_f: 10, duration_f: 90 });
    expect(clipEndF(text)).toBe(100);
  });
});

describe("TrackSchema / TransitionSchema", () => {
  test("track defaults", () => {
    const t = TrackSchema.parse({ id: "V1", kind: "video" });
    expect(t.clips).toEqual([]);
    expect(t.locked).toBe(false);
    expect(t.fade).toEqual({ in_f: 0, out_f: 0, color: "black" });
    expect(TrackSchema.safeParse({ id: "V1", kind: "overlay" }).success).toBe(false);
  });
  test("transition defaults and rejections", () => {
    const tr = TransitionSchema.parse({ id: "t1", track: "V1", from: "c1", to: "c2", duration_f: 15 });
    expect(tr.mode).toBe("handle");
    expect(tr.audio).toBe("crossfade");
    expect(tr.type).toBe("fade");
    expect(TransitionSchema.safeParse({ id: "t1", track: "V1", from: "c1", to: "c2", duration_f: 0 }).success).toBe(
      false,
    );
    expect(
      TransitionSchema.safeParse({ id: "t1", track: "V1", from: "c1", to: "c2", duration_f: 15, mode: "blend" })
        .success,
    ).toBe(false);
  });
});

describe("ProjectSchema", () => {
  test("createProject output round-trips through the schema unchanged", () => {
    const p = createProject({ name: "t", fps, resolution: { width: 1920, height: 1080 } });
    expect(ProjectSchema.parse(p)).toEqual(p);
    expect(p.schema_version).toBe(SCHEMA_VERSION);
  });
  test("rejects wrong schema_version and missing settings", () => {
    const p = createProject({ name: "t", fps, resolution: { width: 1920, height: 1080 } });
    expect(ProjectSchema.safeParse({ ...p, schema_version: 1 }).success).toBe(false);
    const { settings: _s, ...noSettings } = p;
    expect(ProjectSchema.safeParse(noSettings).success).toBe(false);
  });
  test("keeps unknown top-level and nested fields", () => {
    const p = createProject({ name: "t", fps, resolution: { width: 1920, height: 1080 } });
    const parsed = ProjectSchema.parse({
      ...p,
      experimental: { a: 1 },
      tracks: [{ ...p.tracks[0], custom_color: "#fff" }],
    });
    expect((parsed as Record<string, unknown>).experimental).toEqual({ a: 1 });
    expect((parsed.tracks[0] as Record<string, unknown>).custom_color).toBe("#fff");
  });
  test("minimal project gets audio / presets / meta defaults", () => {
    const parsed = ProjectSchema.parse({
      schema_version: 3,
      name: "m",
      created_at: "2026-09-14T00:00:00Z",
      updated_at: "2026-09-14T00:00:00Z",
      settings: { fps: { num: 30, den: 1 }, resolution: { width: 1280, height: 720 }, default_image_duration_f: 150 },
    });
    expect(parsed.tracks).toEqual([]);
    expect(parsed.audio.normalize.i).toBe(-14);
    expect(parsed.text_presets).toEqual({});
    expect(parsed.meta.tags).toEqual([]);
  });
});
