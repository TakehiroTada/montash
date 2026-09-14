import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetUsage, clipCount, timelineDurationF } from "../../../src/core/assets.ts";
import { createProject } from "../../../src/core/project.ts";
import type { Asset, Clip, Project, TextClip, Track, Transition } from "../../../src/core/schema.ts";
import { findVideoGaps, handleExtension, rangesOverlap, validateProject } from "../../../src/core/validate.ts";

const fps = { num: 30, den: 1 };

function base(): Project {
  const p = createProject({ name: "v", fps, resolution: { width: 1920, height: 1080 } });
  p.assets.clip_a = asset("clip_a", "video", 1000);
  p.assets.clip_b = asset("clip_b", "video", 1000);
  p.assets.bgm = asset("bgm", "audio", 5000);
  p.assets.logo = {
    id: "logo",
    type: "image",
    path: "logo.png",
    owned: false,
    tags: [],
    duration_f: null,
    duration_s: null,
  };
  p.assets.ja = { id: "ja", type: "subtitle", path: "ja.srt", owned: false, tags: [] };
  p.assets.script = { id: "script", type: "text", path: "assets/text/script.txt", owned: true, tags: [] };
  return p;
}

function asset(id: string, type: "video" | "audio", duration_f: number): Asset {
  const a: Asset = { id, type, path: `${id}.mp4`, owned: false, tags: [], duration_f, duration_s: duration_f / 30 };
  if (type === "video")
    (a as Extract<Asset, { type: "video" }>).video = {
      codec: "h264",
      width: 1920,
      height: 1080,
      fps: { num: 30, den: 1 },
    };
  return a;
}

function clip(
  id: string,
  assetId: string,
  start_f: number,
  in_f: number,
  out_f: number,
  extra: Partial<Clip> = {},
): Clip {
  return {
    id,
    asset: assetId,
    start_f,
    in_f,
    out_f,
    speed: 1,
    pitch_keep: false,
    loop: false,
    link: null,
    effects: [],
    ...extra,
  };
}

function textClip(id: string, start_f: number, duration_f: number, extra: Partial<TextClip> = {}): TextClip {
  return {
    id,
    type: "text",
    start_f,
    duration_f,
    text: "hi",
    asset: null,
    markup: "plain",
    style: {},
    fade: { in_f: 0, out_f: 0 },
    ...extra,
  };
}

function textTrack(...clips: Track["clips"]): Track {
  return {
    id: "T1",
    kind: "text",
    name: "T1",
    muted: false,
    locked: false,
    fade: { in_f: 0, out_f: 0, color: "black" },
    clips,
  };
}

function transition(
  id: string,
  from: string,
  to: string,
  duration_f: number,
  extra: Partial<Transition> = {},
): Transition {
  return {
    id,
    track: "V1",
    from,
    to,
    type: "fade",
    duration_f,
    mode: "handle",
    audio: "crossfade",
    params: {},
    ...extra,
  };
}

const V1 = (p: Project) => p.tracks[0]!;
const A1 = (p: Project) => p.tracks[1]!;
const codes = (issues: Array<{ code: string }>) => issues.map((i) => i.code);

describe("validateProject: happy path", () => {
  test("empty project is valid", () => {
    const r = validateProject(base());
    expect(r).toEqual({ ok: true, errors: [], warnings: [] });
  });
  test("adjacent clips, linked audio, transition with handles → ok", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 100, 400, { link: "c1a" }), clip("c2", "clip_b", 300, 100, 500));
    A1(p).clips.push(clip("c1a", "clip_a", 0, 100, 400, { link: "c1" }));
    p.transitions.push(transition("t1", "c1", "c2", 15));
    const r = validateProject(p);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("§14.1 integer fields", () => {
  test("non-integer and negative _f are errors; offset_smp may be negative", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0.5 as number, 0, 100));
    V1(p).clips.push(
      clip("c2", "clip_a", 200, 0, 100, {
        audio: { gain_db: 0, fade: { in_f: 0, out_f: 0, curve: "tri" }, offset_smp: -960, muted: false },
      }),
    );
    (V1(p).clips[1] as Clip).in_f = -3;
    const r = validateProject(p);
    expect(codes(r.errors)).toContain("E_FRAME_NOT_INTEGER");
    expect(codes(r.errors)).toContain("E_FRAME_NEGATIVE");
    expect(r.errors.find((e) => e.code === "E_FRAME_NOT_INTEGER")?.path).toBe("/tracks/0/clips/0/start_f");
    expect(r.errors.some((e) => e.path?.endsWith("offset_smp"))).toBe(false);
  });
});

describe("§14.10 settings", () => {
  test("fps must be in lowest terms; resolution must be even", () => {
    const p = base();
    p.settings.fps = { num: 60000, den: 2002 };
    p.settings.resolution = { width: 1921, height: 1080 };
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(expect.arrayContaining(["E_FPS_INVALID", "E_RESOLUTION_ODD"]));
  });
});

describe("§14.2 / §14.3 asset references and ranges", () => {
  test("unknown asset", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "nope", 0, 0, 100));
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(["E_ASSET_NOT_FOUND"]);
    expect(r.errors[0]?.detail).toEqual({ clip: "c1", asset: "nope" });
  });
  test("out_f beyond asset duration, in >= out", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 1200), clip("c2", "clip_a", 2000, 50, 50));
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(["E_RANGE_OUT_OF_ASSET", "E_RANGE_OUT_OF_ASSET"]);
    expect(r.errors[0]?.detail).toMatchObject({ asset: "clip_a", asset_duration_f: 1000, requested_out_f: 1200 });
    expect(r.errors[0]?.hint).toContain("f:1000");
  });
  test("loop: true allows out_f beyond duration; image ignores duration", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 3000, { loop: true }), clip("c2", "logo", 3000, 0, 150));
    expect(validateProject(p).errors).toEqual([]);
  });
});

describe("§14.4 overlaps", () => {
  test("overlapping clips on the same track are errors (integer compare)", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 100), clip("c2", "clip_b", 99, 0, 100));
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(["E_CLIP_OVERLAP"]);
    expect(r.errors[0]?.detail).toMatchObject({ a: "c1", b: "c2", overlap_f: 1 });
    expect(r.errors[0]?.hint).toContain("f:100");
  });
  test("touching clips do not overlap; different tracks never overlap", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 100), clip("c2", "clip_b", 100, 0, 100));
    A1(p).clips.push(clip("c3", "bgm", 50, 0, 100));
    expect(validateProject(p).errors).toEqual([]);
    expect(rangesOverlap(0, 100, 100, 200)).toBe(false);
    expect(rangesOverlap(0, 100, 99, 200)).toBe(true);
  });
  test("speed shortens the clip and unsorted arrays are handled", () => {
    const p = base();
    V1(p).clips.push(clip("c2", "clip_b", 50, 0, 100), clip("c1", "clip_a", 0, 0, 100, { speed: 2 }));
    expect(validateProject(p).errors).toEqual([]);
  });
  test("overlap-mode transition exempts exactly duration_f of overlap", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 100), clip("c2", "clip_b", 85, 0, 100));
    p.transitions.push(transition("t1", "c1", "c2", 15, { mode: "overlap" }));
    expect(validateProject(p).errors).toEqual([]);
    p.transitions[0]!.duration_f = 10;
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(expect.arrayContaining(["E_TRANSITION_NOT_ADJACENT", "E_CLIP_OVERLAP"]));
  });
});

describe("§14.5 transitions", () => {
  test("not adjacent / gap between clips in handle mode", () => {
    const p = base();
    V1(p).clips.push(
      clip("c1", "clip_a", 0, 0, 100),
      clip("c2", "clip_b", 110, 0, 100),
      clip("c3", "clip_a", 300, 0, 100),
    );
    p.transitions.push(transition("t1", "c1", "c2", 10), transition("t2", "c1", "c3", 10));
    const r = validateProject(p);
    const adj = r.errors.filter((e) => e.code === "E_TRANSITION_NOT_ADJACENT");
    expect(adj).toHaveLength(2);
  });
  test("unknown clip / track / track mismatch", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 100));
    A1(p).clips.push(clip("c2", "bgm", 100, 0, 100));
    p.transitions.push(
      transition("t1", "c1", "zz", 10),
      transition("t2", "c1", "c2", 10, { track: "V9" }),
      transition("t3", "c1", "c2", 10),
    );
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(
      expect.arrayContaining(["E_CLIP_NOT_FOUND", "E_TRACK_NOT_FOUND", "E_TRANSITION_TRACK_MISMATCH"]),
    );
  });
  test("insufficient handle: from side and to side, with max duration hint", () => {
    const p = base();
    // c1 uses the asset up to its end (no tail handle); c2 starts at in_f=3 (3 frames of head handle)
    V1(p).clips.push(clip("c1", "clip_a", 0, 900, 1000), clip("c2", "clip_b", 100, 3, 200));
    p.transitions.push(transition("t1", "c1", "c2", 10));
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(["E_INSUFFICIENT_HANDLE"]);
    expect(r.errors[0]?.detail).toMatchObject({
      ext_from: 5,
      ext_to: 5,
      available_from: 0,
      available_to: 3,
      max_duration_f: 0,
    });
    // enough tail on c1 → limited by c2's head (3) → max d = 2*3+1 = 7
    V1(p).clips[0] = clip("c1", "clip_a", 0, 0, 100);
    const r2 = validateProject(p);
    expect(r2.errors[0]?.detail).toMatchObject({ available_from: 900, available_to: 3, max_duration_f: 7 });
    expect(r2.errors[0]?.hint).toContain("duration_f <= 7");
    p.transitions[0]!.duration_f = 7;
    expect(validateProject(p).errors).toEqual([]);
  });
  test("handleExtension splits ceil/floor", () => {
    expect(handleExtension(15)).toEqual({ ext_from: 8, ext_to: 7 });
    expect(handleExtension(10)).toEqual({ ext_from: 5, ext_to: 5 });
    expect(handleExtension(1)).toEqual({ ext_from: 1, ext_to: 0 });
  });
});

describe("§14.6 links", () => {
  test("missing target, non-reciprocal, mismatched start/duration", () => {
    const p = base();
    V1(p).clips.push(
      clip("c1", "clip_a", 0, 0, 100, { link: "ghost" }),
      clip("c2", "clip_b", 100, 0, 100, { link: "c2a" }),
      clip("c3", "clip_a", 200, 0, 100, { link: "c3a" }),
    );
    A1(p).clips.push(clip("c2a", "bgm", 100, 0, 100, { link: null }), clip("c3a", "bgm", 205, 0, 100, { link: "c3" }));
    const r = validateProject(p);
    expect(codes(r.errors).sort()).toEqual(["E_LINK_MISMATCH", "E_LINK_MISMATCH", "E_LINK_NOT_FOUND"]);
  });
});

describe("§14.7 / §14.8 track kinds and asset types", () => {
  test("text clip on video track, media clip on text track, audio asset on video track", () => {
    const p = base();
    V1(p).clips.push(textClip("x1", 0, 30) as unknown as Clip, clip("c1", "bgm", 100, 0, 100));
    p.tracks.push(textTrack(clip("c2", "clip_a", 0, 0, 100)));
    const r = validateProject(p);
    expect(codes(r.errors).filter((c) => c === "E_CLIP_KIND_MISMATCH")).toHaveLength(3);
  });
  test("text clip asset must be a text asset; subtitle clip asset must be subtitle", () => {
    const p = base();
    p.tracks.push(
      textTrack(
        textClip("x1", 0, 30, { asset: "clip_a" }),
        textClip("x2", 30, 30, { asset: "script" }),
        textClip("x3", 60, 30, { asset: "missing" }),
        { id: "s1", type: "subtitle", asset: "script", mode: "burn", start_f: 0, offset_f: 0, style: {} },
        { id: "s2", type: "subtitle", asset: "ja", mode: "burn", start_f: 0, offset_f: 0, style: {} },
      ),
    );
    const r = validateProject(p);
    expect(codes(r.errors).sort()).toEqual(["E_ASSET_NOT_FOUND", "E_ASSET_TYPE_MISMATCH", "E_ASSET_TYPE_MISMATCH"]);
  });
  test("duplicate track / clip ids", () => {
    const p = base();
    p.tracks.push({ ...V1(p), clips: [] });
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 100), clip("c1", "clip_b", 200, 0, 100));
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(expect.arrayContaining(["E_TRACK_ID_DUPLICATE", "E_CLIP_ID_DUPLICATE"]));
  });
});

describe("gaps and warnings", () => {
  test("gap between video clips is a warning, error under strict", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 100), clip("c2", "clip_b", 130, 0, 100));
    const r = validateProject(p);
    expect(r.ok).toBe(true);
    expect(codes(r.warnings)).toEqual(["W_GAP"]);
    expect(r.warnings[0]?.detail).toEqual({ from_f: 100, to_f: 130 });
    const strict = validateProject(p, { strict: true });
    expect(strict.ok).toBe(false);
    expect(codes(strict.errors)).toEqual(["W_GAP"]);
    expect(strict.errors[0]?.detail).toMatchObject({ promoted_by: "strict" });
  });
  test("leading gap and gaps covered by another video track", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 30, 0, 100));
    expect(findVideoGaps(p)).toEqual([{ from_f: 0, to_f: 30 }]);
    p.tracks.push({
      id: "V2",
      kind: "video",
      name: "V2",
      muted: false,
      locked: false,
      fade: { in_f: 0, out_f: 0, color: "black" },
      clips: [clip("c2", "logo", 0, 0, 30)],
    });
    expect(findVideoGaps(p)).toEqual([]);
    expect(validateProject(p).warnings).toEqual([]);
  });
  test("fps / resolution mismatch warns (strict → error)", () => {
    const p = base();
    (p.assets.clip_a as Extract<Asset, { type: "video" }>).video = {
      fps: { num: 30000, den: 1001 },
      width: 3840,
      height: 2160,
    };
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 100));
    const r = validateProject(p);
    expect(codes(r.warnings)).toEqual(["W_ASSET_MISMATCH", "W_ASSET_MISMATCH"]);
    expect(validateProject(p, { strict: true }).ok).toBe(false);
  });
  test("text beyond the last media clip warns (not promoted by strict)", () => {
    const p = base();
    V1(p).clips.push(clip("c1", "clip_a", 0, 0, 100));
    p.tracks.push(textTrack(textClip("x1", 50, 100)));
    const r = validateProject(p, { strict: true });
    expect(r.ok).toBe(true);
    expect(codes(r.warnings)).toEqual(["W_BEYOND_TIMELINE"]);
  });
  test("ducking references unknown tracks", () => {
    const p = base();
    p.audio.ducking.push({
      id: "d1",
      target: "A2",
      sidechain: "A1",
      threshold_db: -30,
      ratio: 8,
      attack_ms: 20,
      release_ms: 500,
      makeup_db: 0,
    });
    p.audio.track_gain_db = { A1: 0, A9: -12 };
    const r = validateProject(p);
    expect(codes(r.errors)).toEqual(["E_TRACK_NOT_FOUND"]);
    expect(codes(r.warnings)).toEqual(["W_UNKNOWN_TRACK"]);
  });
});

describe("checkFiles", () => {
  test("missing asset files are errors only when checkFiles is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "montash-validate-"));
    writeFileSync(join(dir, "clip_a.mp4"), "");
    const p = base();
    p.assets = { clip_a: p.assets.clip_a!, clip_b: p.assets.clip_b! };
    expect(validateProject(p, { dir }).errors).toEqual([]);
    const r = validateProject(p, { checkFiles: true, dir });
    expect(codes(r.errors)).toEqual(["E_ASSET_MISSING"]);
    expect(r.errors[0]?.detail).toMatchObject({ asset: "clip_b", path: join(dir, "clip_b.mp4") });
  });
});

describe("assets.ts derived info", () => {
  test("assetUsage and timelineDurationF", () => {
    const p = base();
    V1(p).clips.push(clip("c2", "clip_a", 300, 0, 50), clip("c1", "clip_a", 0, 0, 100));
    A1(p).clips.push(clip("c3", "bgm", 0, 0, 600));
    p.tracks.push(textTrack(textClip("x1", 0, 30, { asset: "script" })));
    expect(assetUsage(p, "clip_a").clips).toEqual([
      { id: "c1", track: "V1", start_f: 0, end_f: 100 },
      { id: "c2", track: "V1", start_f: 300, end_f: 350 },
    ]);
    expect(assetUsage(p, "script").clips).toEqual([{ id: "x1", track: "T1", start_f: 0, end_f: 30 }]);
    expect(assetUsage(p, "logo").clips).toEqual([]);
    expect(timelineDurationF(p)).toBe(600);
    expect(clipCount(p)).toBe(4);
    expect(timelineDurationF(base())).toBe(0);
  });
});
