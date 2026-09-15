import { describe, expect, test } from "bun:test";
import {
  assertUnlocked,
  canSetClipDuration,
  clampFades,
  findClip,
  linkedGroup,
  removeClips,
  setClipDuration,
  sortClips,
  sourceLimitF,
  splitClipAt,
  trimClipHead,
} from "../../../src/core/clip-editing.ts";
import { clipDurationF, clipEndF, isMediaClip } from "../../../src/core/schema.ts";
import { validateProject } from "../../../src/core/validate.ts";
import { addPair, makeProject, track } from "./editing-helpers.ts";

describe("clip-editing: 参照とロック", () => {
  test("findClip は全トラックを探し、無ければ E_CLIP_NOT_FOUND", () => {
    const p = makeProject();
    addPair(p, 1, 0, 30);
    expect(findClip(p, "c2").track.id).toBe("A1");
    expect(() => findClip(p, "nope")).toThrow(/E_CLIP_NOT_FOUND|not found/);
  });

  test("assertUnlocked / linkedGroup はロックされたトラックを拒否する", () => {
    const p = makeProject();
    addPair(p, 1, 0, 30);
    track(p, "A1").locked = true;
    expect(() => assertUnlocked(track(p, "A1"))).toThrow(/locked/);
    expect(() => linkedGroup(p, "c1")).toThrow(/locked/);
  });

  test("linkedGroup はリンク相手を含み、--unlink で相互参照を外す", () => {
    const p = makeProject();
    addPair(p, 1, 0, 30);
    expect(linkedGroup(p, "c1").map((g) => g.clip.id)).toEqual(["c1", "c2"]);
    const alone = linkedGroup(p, "c1", true);
    expect(alone).toHaveLength(1);
    const c1 = findClip(p, "c1").clip;
    const c2 = findClip(p, "c2").clip;
    expect(isMediaClip(c1) && c1.link).toBeNull();
    expect(isMediaClip(c2) && c2.link).toBeNull();
    expect(validateProject(p).ok).toBe(true);
  });
});

describe("clip-editing: 尺の変更", () => {
  test("setClipDuration は out_f を動かし、アセット尺を超えると false", () => {
    const p = makeProject();
    const { video } = addPair(p, 1, 0, 30);
    expect(setClipDuration(p, video, 60)).toBe(true);
    expect(video.out_f).toBe(60);
    expect(canSetClipDuration(p, video, 151)).toBe(false);
    expect(setClipDuration(p, video, 151)).toBe(false);
    expect(video.out_f).toBe(60);
  });

  test("loop クリップはアセット尺を超えて伸ばせる", () => {
    const p = makeProject();
    const { video } = addPair(p, 1, 0, 30);
    expect(sourceLimitF(p, video)).toBe(150);
    video.loop = true;
    expect(sourceLimitF(p, video)).toBeNull();
    expect(setClipDuration(p, video, 400)).toBe(true);
    expect(clipDurationF(video)).toBe(400);
  });

  test("speed を考慮して out_f を決める", () => {
    const p = makeProject();
    const { video } = addPair(p, 1, 0, 30);
    video.speed = 2;
    expect(clipDurationF(video)).toBe(15);
    setClipDuration(p, video, 30);
    expect(video.out_f).toBe(60);
    expect(clipDurationF(video)).toBe(30);
  });

  test("trimClipHead は in_f を進め、フェードを尺に丸める", () => {
    const p = makeProject();
    const { video } = addPair(p, 1, 0, 30);
    video.video!.fade.in_f = 20;
    trimClipHead(video, 20);
    expect(video.in_f).toBe(20);
    expect(clipDurationF(video)).toBe(10);
    expect(video.video!.fade.in_f).toBe(10);
  });

  test("clampFades はテキストクリップにも効く", () => {
    const p = makeProject();
    const t1 = track(p, "T1");
    t1.clips.push({
      id: "x1",
      type: "text",
      start_f: 0,
      duration_f: 30,
      text: "hi",
      asset: null,
      markup: "plain",
      style: {},
      fade: { in_f: 30, out_f: 30 },
    } as never);
    const text = t1.clips[0]!;
    clampFades(text, 10);
    expect((text as { fade: { in_f: number } }).fade.in_f).toBe(10);
  });
});

describe("clip-editing: split（ADR-12）", () => {
  test("前半は元 ID を維持し、後半だけ新規採番される", () => {
    const p = makeProject();
    addPair(p, 1, 0, 60);
    const left = findClip(p, "c1");
    const right = splitClipAt(p, left, 30, "c9");
    expect(left.clip.id).toBe("c1");
    expect(right.id).toBe("c9");
    expect(clipEndF(left.clip)).toBe(30);
    expect(right.start_f).toBe(30);
    expect(isMediaClip(left.clip) && left.clip.out_f).toBe(30);
    expect(isMediaClip(right) && right.in_f).toBe(30);
    expect(isMediaClip(right) && right.out_f).toBe(60);
  });

  test("末尾フェードは後半へ、先頭フェードは前半へ振り分ける", () => {
    const p = makeProject();
    const { video } = addPair(p, 1, 0, 60);
    video.video!.fade.in_f = 5;
    video.video!.fade.out_f = 5;
    const right = splitClipAt(p, findClip(p, "c1"), 30, "c9");
    expect(video.video!.fade).toEqual(expect.objectContaining({ in_f: 5, out_f: 0 }));
    expect((right as typeof video).video!.fade).toEqual(expect.objectContaining({ in_f: 0, out_f: 5 }));
  });

  test("端での分割は E_SPLIT_AT_EDGE", () => {
    const p = makeProject();
    addPair(p, 1, 0, 60);
    expect(() => splitClipAt(p, findClip(p, "c1"), 0, "c9")).toThrow(/E_SPLIT_AT_EDGE|edge/);
    expect(() => splitClipAt(p, findClip(p, "c1"), 60, "c9")).toThrow(/E_SPLIT_AT_EDGE|edge/);
  });

  test("速度付きクリップでもソース境界が連続する", () => {
    const p = makeProject();
    const { video } = addPair(p, 1, 0, 60);
    video.speed = 2; // 尺 30f
    const right = splitClipAt(p, findClip(p, "c1"), 15, "c9") as typeof video;
    expect(video.out_f).toBe(30);
    expect(right.in_f).toBe(30);
    expect(clipDurationF(video) + clipDurationF(right)).toBe(30);
  });
});

describe("clip-editing: removeClips", () => {
  test("リンクを null にし、参照するトランジションを W_TRANSITION_REMOVED で落とす", () => {
    const p = makeProject();
    addPair(p, 1, 0, 30);
    addPair(p, 2, 30, 60);
    p.transitions.push({
      id: "t1",
      track: "V1",
      from: "c1",
      to: "c3",
      type: "fade",
      duration_f: 6,
      mode: "handle",
      audio: "crossfade",
      params: {},
    });
    const warnings: Array<{ code: string }> = [];
    removeClips(p, new Set(["c1"]), warnings as never);
    expect(findClip(p, "c2")).toBeTruthy();
    expect(isMediaClip(findClip(p, "c2").clip) && (findClip(p, "c2").clip as { link: unknown }).link).toBeNull();
    expect(p.transitions).toHaveLength(0);
    expect(warnings.map((w) => w.code)).toContain("W_TRANSITION_REMOVED");
    expect(validateProject(p).ok).toBe(true);
  });
});

describe("clip-editing: sortClips", () => {
  test("start_f 昇順に並べ替える", () => {
    const p = makeProject();
    addPair(p, 1, 0, 30);
    addPair(p, 2, 30, 60);
    track(p, "V1").clips.reverse();
    sortClips(p);
    expect(track(p, "V1").clips.map((c) => c.id)).toEqual(["c1", "c3"]);
  });
});
