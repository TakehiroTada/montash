import { describe, expect, test } from "bun:test";
import type { Warning } from "../../../src/cli/errors.ts";
import { timelineDurationF } from "../../../src/core/assets.ts";
import {
  findClip,
  findClipOrNull,
  linkedGroup,
  removeClips,
  sortClips,
  splitClipAt,
} from "../../../src/core/clip-editing.ts";
import { parseRippleScope, rippleTimeline } from "../../../src/core/ripple.ts";
import { clipDurationF, clipEndF, isMediaClip, type Project } from "../../../src/core/schema.ts";
import { validateProject } from "../../../src/core/validate.ts";
import { addBgm, addPair, makeProject, rng, track } from "./editing-helpers.ts";

const codes = (w: Warning[]) => w.map((x) => x.code);

/** 3 組（各 30f）が隙間なく並んだタイムライン */
function threeCuts(): Project {
  const p = makeProject();
  addPair(p, 1, 0, 30);
  addPair(p, 2, 30, 60);
  addPair(p, 3, 60, 90);
  return p;
}

/** リンクが常に相互参照で start_f / 尺が一致するか（docs/05 §14.6） */
function linksConsistent(project: Project): boolean {
  for (const t of project.tracks) {
    for (const clip of t.clips) {
      if (!isMediaClip(clip) || clip.link === null) continue;
      const partner = findClipOrNull(project, clip.link)?.clip;
      if (!partner || !isMediaClip(partner) || partner.link !== clip.id) return false;
      if (partner.start_f !== clip.start_f || clipDurationF(partner) !== clipDurationF(clip)) return false;
    }
  }
  return true;
}

describe("parseRippleScope", () => {
  test("--ripple / =all / =track / 未指定", () => {
    expect(parseRippleScope(undefined)).toBe(false);
    expect(parseRippleScope("")).toBe("all");
    expect(parseRippleScope("true")).toBe("all");
    expect(parseRippleScope(true)).toBe("all");
    expect(parseRippleScope("all")).toBe("all");
    expect(parseRippleScope("track")).toBe("track");
    expect(() => parseRippleScope("nope")).toThrow(/--ripple/);
  });
});

describe("rippleTimeline: 基本規則（docs/04 §6a）", () => {
  test("scope false / delta 0 は何もしない", () => {
    const p = threeCuts();
    expect(rippleTimeline(p, { point: 30, delta: -30, scope: false }, [])).toEqual([]);
    expect(rippleTimeline(p, { point: 30, delta: 0, scope: "all" }, [])).toEqual([]);
    expect(timelineDurationF(p)).toBe(90);
  });

  test("start_f >= p_f の要素を全トラックで delta だけ動かす", () => {
    const p = threeCuts();
    const warnings: Warning[] = [];
    rippleTimeline(p, { point: 30, delta: -30, scope: "all", exclude: ["c3", "c4"] }, warnings);
    expect(findClip(p, "c5").clip.start_f).toBe(30);
    expect(findClip(p, "c6").clip.start_f).toBe(30);
    expect(findClip(p, "c1").clip.start_f).toBe(0);
  });

  test("削除で編集点を跨ぐ BGM は尺が縮む", () => {
    const p = threeCuts();
    addBgm(p, "c9", 0, 90);
    rippleTimeline(p, { point: 30, delta: -30, scope: "all", exclude: ["c3", "c4"] }, []);
    const bgm = findClip(p, "c9").clip;
    expect(bgm.start_f).toBe(0);
    expect(clipDurationF(bgm)).toBe(60);
  });

  test("削除区間に完全に収まるクリップは消える", () => {
    const p = threeCuts();
    const warnings: Warning[] = [];
    rippleTimeline(p, { point: 30, delta: -30, scope: "all" }, warnings);
    expect(findClipOrNull(p, "c3")).toBeNull();
    expect(findClipOrNull(p, "c4")).toBeNull();
    expect(findClip(p, "c5").clip.start_f).toBe(30);
    expect(validateProject(p).ok).toBe(true);
  });

  test("削除区間の途中から始まるクリップは頭を切って編集点に寄る", () => {
    const p = makeProject();
    addPair(p, 1, 0, 30);
    addPair(p, 2, 0, 60, 30); // f:30..90
    rippleTimeline(p, { point: 20, delta: -30, scope: "all", exclude: ["c1", "c2"] }, []);
    const moved = findClip(p, "c3").clip;
    expect(moved.start_f).toBe(20);
    expect(clipDurationF(moved)).toBe(40);
    expect(isMediaClip(moved) && moved.in_f).toBe(20);
  });

  test("挿入で跨ぐクリップはソースに余白があれば伸びる", () => {
    const p = makeProject();
    addBgm(p, "c9", 0, 60);
    const warnings: Warning[] = [];
    rippleTimeline(p, { point: 30, delta: 20, scope: "all" }, warnings);
    expect(clipDurationF(findClip(p, "c9").clip)).toBe(80);
    expect(codes(warnings)).toEqual([]);
  });

  test("余白が無ければ伸ばさず W_RIPPLE_SPAN_NOT_EXTENDED", () => {
    const p = makeProject();
    addBgm(p, "c9", 0, 300); // アセット尺ぴったり
    const warnings: Warning[] = [];
    rippleTimeline(p, { point: 30, delta: 20, scope: "all" }, warnings);
    expect(clipDurationF(findClip(p, "c9").clip)).toBe(300);
    expect(codes(warnings)).toEqual(["W_RIPPLE_SPAN_NOT_EXTENDED"]);
  });

  test("loop クリップはアセット尺を超えて伸びる", () => {
    const p = makeProject();
    const bgm = addBgm(p, "c9", 0, 300);
    bgm.loop = true;
    const warnings: Warning[] = [];
    rippleTimeline(p, { point: 30, delta: 20, scope: "all" }, warnings);
    expect(clipDurationF(findClip(p, "c9").clip)).toBe(320);
    expect(codes(warnings)).toEqual([]);
  });

  test("locked トラックは動かない", () => {
    const p = threeCuts();
    addBgm(p, "c9", 0, 90);
    track(p, "A2").locked = true;
    rippleTimeline(p, { point: 30, delta: -30, scope: "all", exclude: ["c3", "c4"] }, []);
    expect(clipDurationF(findClip(p, "c9").clip)).toBe(90);
    expect(findClip(p, "c5").clip.start_f).toBe(30);
  });

  test("--ripple=track は当該トラックとリンク先トラックだけに効く", () => {
    const p = threeCuts();
    addBgm(p, "c9", 0, 90);
    rippleTimeline(p, { point: 30, delta: -30, scope: "track", tracks: ["V1"], exclude: ["c3", "c4"] }, []);
    expect(findClip(p, "c5").clip.start_f).toBe(30); // V1
    expect(findClip(p, "c6").clip.start_f).toBe(30); // リンク先 A1 も追随する
    expect(clipDurationF(findClip(p, "c9").clip)).toBe(90); // A2 は対象外
  });

  test("リンク相手がロックされていると E_TRACK_LOCKED で止める", () => {
    const p = threeCuts();
    track(p, "A1").locked = true;
    expect(() => rippleTimeline(p, { point: 30, delta: -30, scope: "all" }, [])).toThrow(/desynchronize|locked/);
  });

  test("編集点で不成立になったトランジションは W_TRANSITION_REMOVED で落ちる", () => {
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
    expect(validateProject(p).ok).toBe(true);
    const warnings: Warning[] = [];
    // 接合点にフレームを挿入すると c1 と c3 が離れる
    rippleTimeline(p, { point: 30, delta: 10, scope: "all" }, warnings);
    expect(p.transitions).toHaveLength(0);
    expect(codes(warnings)).toContain("W_TRANSITION_REMOVED");
  });

  test("字幕クリップは点として移動する", () => {
    const p = threeCuts();
    track(p, "T1").clips.push({
      id: "s1",
      type: "subtitle",
      asset: "sub",
      mode: "burn",
      start_f: 60,
      offset_f: 0,
      style: {},
    } as never);
    p.assets.sub = { id: "sub", path: "s.srt", type: "subtitle", owned: false, tags: [] } as never;
    rippleTimeline(p, { point: 30, delta: -30, scope: "all" }, []);
    expect(findClip(p, "s1").clip.start_f).toBe(30);
  });
});

describe("rippleTimeline: 性質テスト", () => {
  test("リップル削除で全長が |delta_f| だけ縮む（100 通りの区間）", () => {
    const random = rng(20260915);
    for (let i = 0; i < 100; i++) {
      const p = threeCuts();
      addBgm(p, "c9", 0, 90);
      const before = timelineDurationF(p);
      const point = Math.floor(random() * 60);
      const cut = 1 + Math.floor(random() * (90 - point - 1));
      rippleTimeline(p, { point, delta: -cut, scope: "all" }, []);
      expect(timelineDurationF(p)).toBe(before - cut);
      expect(validateProject(p).errors.map((e) => e.code)).toEqual([]);
      expect(linksConsistent(p)).toBe(true);
    }
  });

  test("リップル挿入と削除は打ち消し合う（余白のある素材）", () => {
    const random = rng(7);
    for (let i = 0; i < 100; i++) {
      const p = threeCuts();
      const point = Math.floor(random() * 90);
      const delta = 1 + Math.floor(random() * 30);
      rippleTimeline(p, { point, delta, scope: "all" }, []);
      rippleTimeline(p, { point, delta: -delta, scope: "all" }, []);
      expect(timelineDurationF(p)).toBe(90);
      expect(validateProject(p).errors.map((e) => e.code)).toEqual([]);
      expect(linksConsistent(p)).toBe(true);
    }
  });

  test("ランダムな add/trim/move/split/delete を 100 回行っても不変条件が保たれる", () => {
    const random = rng(424242);
    const p = makeProject();
    let counter = 0;
    let newId = 1000;
    const pick = <T>(xs: T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(random() * xs.length)]);
    const videoClips = () => track(p, "V1").clips.map((c) => c.id);

    for (let step = 0; step < 100; step++) {
      const warnings: Warning[] = [];
      const scope = random() < 0.5 ? "all" : random() < 0.5 ? "track" : false;
      const id = pick(videoClips());
      const op = id === undefined ? 0 : Math.floor(random() * 5);

      if (op === 0) {
        // add: 末尾にリンク付きで追加
        counter += 1;
        const inF = Math.floor(random() * 100);
        addPair(p, counter, inF, inF + 1 + Math.floor(random() * 40));
      } else if (op === 1 && id) {
        // trim: 頭か尻を削る（リップルは編集点以降を詰める）
        const group = linkedGroup(p, id);
        const head = group[0]!.clip;
        const duration = clipDurationF(head);
        if (duration > 2) {
          const cut = 1 + Math.floor(random() * (duration - 1));
          const end = clipEndF(head);
          for (const g of group) {
            const c = g.clip;
            if (isMediaClip(c)) c.out_f -= cut;
          }
          rippleTimeline(
            p,
            {
              point: end - cut,
              delta: -cut,
              scope,
              tracks: group.map((g) => g.track.id),
              exclude: [...group.map((g) => g.clip.id)],
            },
            warnings,
          );
        }
      } else if (op === 2 && id) {
        // move: 取り外し → 元を詰め → 移動先を押し出し
        const group = linkedGroup(p, id);
        const duration = clipDurationF(group[0]!.clip);
        const oldStart = group[0]!.clip.start_f;
        const ids = group.map((g) => g.clip.id);
        for (const g of group) g.track.clips = g.track.clips.filter((c) => c.id !== g.clip.id);
        rippleTimeline(p, { point: oldStart, delta: -duration, scope: "all", exclude: ids }, warnings);
        // 挿入位置はクリップ境界から選ぶ（クリップの内側に差し込むと跨ぎクリップが伸びるだけで場所は空かない）
        const boundaries = [0, ...track(p, "V1").clips.flatMap((c) => [c.start_f, clipEndF(c)])];
        const to = pick(boundaries) ?? 0;
        rippleTimeline(p, { point: to, delta: duration, scope: "all", exclude: ids }, warnings);
        for (const g of group) {
          g.clip.start_f = to;
          g.track.clips.push(g.clip);
        }
        sortClips(p);
      } else if (op === 3 && id) {
        // split: 内側で 2 分割し、前半同士・後半同士でリンクし直す
        const group = linkedGroup(p, id);
        const head = group[0]!.clip;
        const duration = clipDurationF(head);
        if (duration >= 2) {
          const at = head.start_f + 1 + Math.floor(random() * (duration - 1));
          const created = group.map((g) => splitClipAt(p, g, at, `c${newId++}`));
          if (created.length === 2 && isMediaClip(created[0]!) && isMediaClip(created[1]!)) {
            created[0]!.link = created[1]!.id;
            created[1]!.link = created[0]!.id;
          }
          sortClips(p);
        }
      } else if (id) {
        // delete
        const group = linkedGroup(p, id);
        const start = group[0]!.clip.start_f;
        const end = clipEndF(group[0]!.clip);
        removeClips(p, new Set(group.map((g) => g.clip.id)), warnings);
        rippleTimeline(p, { point: start, delta: start - end, scope, tracks: group.map((g) => g.track.id) }, warnings);
      }

      const result = validateProject(p);
      if (!result.ok) throw new Error(`step ${step} (op ${op}): ${JSON.stringify(result.errors)}`);
      expect(linksConsistent(p)).toBe(true);
    }
    expect(validateProject(p).ok).toBe(true);
  });
});
