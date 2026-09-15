/**
 * `core/clip-create.ts` の単体テスト（docs/04 §6 `clip add`、§10 `overlay add`）。
 *
 * ここは「どこに何を足すか」だけを見る。時間表記やスタイルの解釈は cli 側のテスト
 * （tests/unit/cli/editing.test.ts, overlay.test.ts）が担当する。
 */
import { describe, expect, test } from "bun:test";
import { MontashError, type Warning } from "../../../src/cli/errors.ts";
import { addClip, assertSourceRange, type IdAllocator } from "../../../src/core/clip-create.ts";
import { carveRange } from "../../../src/core/clip-editing.ts";
import { AssetSchema, clipEndF, isMediaClip, type Project, TrackSchema } from "../../../src/core/schema.ts";
import { counterpartTrackId, requireTrack } from "../../../src/core/timeline.ts";
import { validateProject } from "../../../src/core/validate.ts";
import { addBgm, addPair, makeProject, rng, track } from "./editing-helpers.ts";

/** `c1` から順に配る採番関数（`.montash/ids.json` の代わり） */
function allocator(start = 1): IdAllocator {
  let n = start;
  return () => `c${n++}`;
}

/** 画像アセット（`duration_f` を持たない）を足す */
function addImageAsset(project: Project): void {
  project.assets.logo = AssetSchema.parse({
    id: "logo",
    path: "logo.png",
    type: "image",
    duration_s: null,
    duration_f: null,
    video: { codec: "png", width: 256, height: 128, has_alpha: true },
  });
}

describe("addClip", () => {
  test("リンク音声は V1 → A1 に作られ、link は相互参照になる", async () => {
    const project = makeProject();
    const { clip, linked, linkedTrack } = await addClip(
      project,
      { asset: "a", track: track(project, "V1"), start_f: 0, in_f: 0, out_f: 60, linkAudio: true },
      allocator(),
    );
    expect(clip.id).toBe("c1");
    expect(linked?.id).toBe("c2");
    expect(linkedTrack?.id).toBe("A1");
    expect(clip.link).toBe("c2");
    expect(linked?.link).toBe("c1");
    expect(clip.video).toBeDefined();
    expect(clip.audio).toBeUndefined();
    expect(linked?.audio).toBeDefined();
    expect(linked?.video).toBeUndefined();
    // start_f と尺が一致する（docs/05 §14.6）
    expect(linked?.start_f).toBe(clip.start_f);
    expect(clipEndF(linked!)).toBe(clipEndF(clip));
    expect(track(project, "V1").clips.map((c) => c.id)).toEqual(["c1"]);
    expect(track(project, "A1").clips.map((c) => c.id)).toEqual(["c2"]);
    expect(validateProject(project).ok).toBe(true);
  });

  test("linkAudio なしなら音声トラックには何も置かない", async () => {
    const project = makeProject();
    const { linked, linkedTrack } = await addClip(
      project,
      { asset: "a", track: track(project, "V1"), start_f: 0, in_f: 0, out_f: 60 },
      allocator(),
    );
    expect(linked).toBeNull();
    expect(linkedTrack).toBeNull();
    expect(track(project, "A1").clips).toHaveLength(0);
  });

  test("audioOnly は audio ブロックだけを持つクリップになる", async () => {
    const project = makeProject();
    const { clip } = await addClip(
      project,
      { asset: "bgm", track: track(project, "A2"), start_f: 0, in_f: 0, out_f: 300, audioOnly: true },
      allocator(),
    );
    expect(clip.audio).toBeDefined();
    expect(clip.video).toBeUndefined();
    expect(clip.audio?.gain_db).toBe(0);
    expect(validateProject(project).ok).toBe(true);
  });

  test("画像クリップ（尺は呼び出し側が決める）も同じ経路で置ける", async () => {
    const project = makeProject();
    addImageAsset(project);
    const { clip } = await addClip(
      project,
      { asset: "logo", track: track(project, "V1"), start_f: 0, in_f: 0, out_f: 150 },
      allocator(),
    );
    expect(clipEndF(clip)).toBe(150);
    expect(clip.video?.transform).toBeNull();
    expect(validateProject(project).ok).toBe(true);
  });

  test("video の初期値（overlay の transform / opacity / keep_alpha）を渡せる", async () => {
    const project = makeProject();
    addImageAsset(project);
    project.tracks.push(TrackSchema.parse({ id: "V2", kind: "video", name: "V2" }));
    const { clip } = await addClip(
      project,
      {
        asset: "logo",
        track: requireTrack(project, "V2"),
        start_f: 0,
        in_f: 0,
        out_f: 90,
        label: "logo",
        video: { opacity: 0.9, keep_alpha: true, transform: { position: "top-right", scale: 0.12 } },
      },
      allocator(),
    );
    expect(clip.label).toBe("logo");
    expect(clip.video?.opacity).toBe(0.9);
    expect(clip.video?.keep_alpha).toBe(true);
    expect(clip.video?.transform?.position).toBe("top-right");
    expect(clip.video?.transform?.scale).toBe(0.12);
    // 未指定のフィールドはスキーマの既定値が入る
    expect(clip.video?.transform?.margin).toBe(0);
    expect(clip.video?.fade).toEqual({ in_f: 0, out_f: 0, color: "black" });
  });

  test("--id で ID を明示でき、採番カウンタは進めない", async () => {
    const project = makeProject();
    const allocate = allocator();
    const { clip, linked } = await addClip(
      project,
      { asset: "a", track: track(project, "V1"), start_f: 0, in_f: 0, out_f: 60, id: "mine", linkAudio: true },
      allocate,
    );
    expect(clip.id).toBe("mine");
    // 明示 ID は採番を消費しないので、リンク音声が最初の採番を受け取る
    expect(linked?.id).toBe("c1");
    expect(linked?.link).toBe("mine");
  });

  test("既に使われている --id は E_ID_EXISTS", async () => {
    const project = makeProject();
    addPair(project, 1, 0, 60);
    await expect(
      addClip(
        project,
        { asset: "a", track: track(project, "V1"), start_f: 60, in_f: 0, out_f: 60, id: "c1" },
        allocator(10),
      ),
    ).rejects.toMatchObject({ code: "E_ID_EXISTS" });
  });

  test("並び順は start_f 昇順を保つ", async () => {
    const project = makeProject();
    addPair(project, 1, 0, 60, 60);
    await addClip(
      project,
      { asset: "a", track: track(project, "V1"), start_f: 0, in_f: 0, out_f: 60, linkAudio: true },
      allocator(10),
    );
    expect(track(project, "V1").clips.map((c) => c.start_f)).toEqual([0, 60]);
    expect(track(project, "A1").clips.map((c) => c.start_f)).toEqual([0, 60]);
  });

  describe("重なり（--on-overlap error の既定挙動）", () => {
    test("置き先が埋まっていれば E_CLIP_OVERLAP で、project は変わらない", async () => {
      const project = makeProject();
      addPair(project, 1, 0, 60);
      const before = structuredClone(project);
      await expect(
        addClip(
          project,
          { asset: "a", track: track(project, "V1"), start_f: 30, in_f: 0, out_f: 60, linkAudio: true },
          allocator(10),
        ),
      ).rejects.toMatchObject({ code: "E_CLIP_OVERLAP" });
      expect(project).toEqual(before);
    });

    test("映像トラックが空いていてもリンク先の音声トラックが埋まっていれば足さない", async () => {
      const project = makeProject();
      addBgm(project, "z1", 0, 60);
      // A1 だけを埋める
      track(project, "A1").clips.push(structuredClone(track(project, "A2").clips[0]!));
      track(project, "A1").clips[0]!.id = "z2";
      const before = structuredClone(project);
      await expect(
        addClip(
          project,
          { asset: "a", track: track(project, "V1"), start_f: 0, in_f: 0, out_f: 60, linkAudio: true },
          allocator(10),
        ),
      ).rejects.toMatchObject({ code: "E_CLIP_OVERLAP" });
      expect(project).toEqual(before);
    });

    test("ロックされたトラックには置けない（E_TRACK_LOCKED）", async () => {
      const project = makeProject();
      track(project, "V1").locked = true;
      await expect(
        addClip(project, { asset: "a", track: track(project, "V1"), start_f: 0, in_f: 0, out_f: 60 }, allocator()),
      ).rejects.toMatchObject({ code: "E_TRACK_LOCKED" });
    });

    test("リンク先の音声トラックが無ければ E_TRACK_NOT_FOUND", async () => {
      const project = makeProject();
      project.tracks = project.tracks.filter((t) => t.id !== "A1");
      await expect(
        addClip(
          project,
          { asset: "a", track: track(project, "V1"), start_f: 0, in_f: 0, out_f: 60, linkAudio: true },
          allocator(),
        ),
      ).rejects.toMatchObject({ code: "E_TRACK_NOT_FOUND" });
    });
  });
});

describe("assertSourceRange", () => {
  test("0 <= in < out <= 素材尺なら通る", () => {
    expect(() => assertSourceRange(0, 150, 150)).not.toThrow();
    expect(() => assertSourceRange(10, 11, 150)).not.toThrow();
  });

  test("out <= in は E_RANGE_OUT_OF_ASSET", () => {
    expect(() => assertSourceRange(30, 30, 150)).toThrow(MontashError);
    try {
      assertSourceRange(30, 20, 150);
    } catch (e) {
      expect((e as MontashError).code).toBe("E_RANGE_OUT_OF_ASSET");
      expect((e as MontashError).hint).toBe("Choose 0 <= in < out <= f:150.");
    }
  });

  test("素材尺を超えると E_RANGE_OUT_OF_ASSET。上限なし（画像・尺不明）なら通る", () => {
    expect(() => assertSourceRange(0, 151, 150)).toThrow(MontashError);
    expect(() => assertSourceRange(0, 100000, undefined)).not.toThrow();
  });
});

describe("counterpartTrackId", () => {
  test("V ↔ A を入れ替える", () => {
    expect(counterpartTrackId("V1", "video")).toBe("A1");
    expect(counterpartTrackId("V2", "video")).toBe("A2");
    expect(counterpartTrackId("A3", "audio")).toBe("V3");
    // 既定の命名から外れたトラック名はそのまま（呼び出し側が requireTrack で弾く）
    expect(counterpartTrackId("main", "video")).toBe("main");
  });
});

describe("carveRange（--on-overlap overwrite の実体）", () => {
  test("区間に丸ごと入るクリップは消し、掛かるクリップは削る", () => {
    const project = makeProject();
    addBgm(project, "z1", 0, 30);
    addBgm(project, "z2", 30, 30);
    addBgm(project, "z3", 60, 30);
    const warnings: Warning[] = [];
    carveRange(project, track(project, "A2"), 20, 70, new Set(), warnings);
    const clips = track(project, "A2").clips;
    // z2 は丸ごと消え、z1 は末尾を、z3 は頭を削られる
    expect(clips.map((c) => c.id)).toEqual(["z1", "z3"]);
    expect(clipEndF(clips[0]!)).toBe(20);
    expect(clips[1]!.start_f).toBe(70);
  });

  test("keep に入れたクリップは触らない", () => {
    const project = makeProject();
    addBgm(project, "z1", 0, 30);
    carveRange(project, track(project, "A2"), 0, 30, new Set(["z1"]), []);
    expect(track(project, "A2").clips.map((c) => c.id)).toEqual(["z1"]);
  });

  test("区間が既存クリップの内側なら E_NOT_IMPLEMENTED", () => {
    const project = makeProject();
    addBgm(project, "z1", 0, 90);
    expect(() => carveRange(project, track(project, "A2"), 30, 60, new Set(), [])).toThrow(MontashError);
  });
});

describe("性質テスト", () => {
  test("ランダムな addClip を 100 回繰り返しても project は妥当で、link は常に相互参照", async () => {
    const project = makeProject();
    const random = rng(20260915);
    const allocate = allocator();
    let added = 0;
    let rejected = 0;

    for (let i = 0; i < 100; i++) {
      const pair = random() < 0.6;
      const trackId = pair ? "V1" : "A2";
      const target = track(project, trackId);
      const end = target.clips.reduce((e, c) => Math.max(e, clipEndF(c)), 0);
      // 半分は末尾に追記、半分は既存に重なりうる位置（E_CLIP_OVERLAP になるはず）
      const startF = random() < 0.5 ? end : Math.floor(random() * Math.max(end, 1));
      const inF = Math.floor(random() * 50);
      const outF = inF + 1 + Math.floor(random() * 60);

      try {
        const { clip, linked } = await addClip(
          project,
          {
            asset: pair ? "a" : "bgm",
            track: target,
            start_f: startF,
            in_f: inF,
            out_f: outF,
            audioOnly: !pair,
            linkAudio: pair,
          },
          allocate,
        );
        added++;
        if (pair) {
          expect(linked).not.toBeNull();
          expect(clip.link).toBe(linked!.id);
          expect(linked!.link).toBe(clip.id);
        } else {
          expect(linked).toBeNull();
        }
      } catch (e) {
        rejected++;
        expect(e).toBeInstanceOf(MontashError);
        expect((e as MontashError).code).toBe("E_CLIP_OVERLAP");
      }

      // 不変条件: project は妥当で、link は常に相互参照
      const result = validateProject(project);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      for (const t of project.tracks) {
        for (const c of t.clips) {
          if (!isMediaClip(c) || c.link === null) continue;
          const partner = project.tracks.flatMap((x) => x.clips).find((x) => x.id === c.link);
          expect(partner).toBeDefined();
          expect(isMediaClip(partner!) && partner.link).toBe(c.id);
          expect(partner!.start_f).toBe(c.start_f);
          expect(clipEndF(partner!)).toBe(clipEndF(c));
        }
      }
      // clips は常に start_f 昇順（docs/05 §6）
      for (const t of project.tracks) {
        const starts = t.clips.map((c) => c.start_f);
        expect(starts).toEqual([...starts].sort((x, y) => x - y));
      }
    }

    expect(added).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });
});
