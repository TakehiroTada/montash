/**
 * クリップ種別の開放（docs/13 D-14, F-EXT-4）。
 *
 * 要点は 3 つ:
 *   1. 未知種別を含む project.json が**開けて、保存しても消えない**
 *   2. 判別規則が CLI / サーバ / フロントで**同一**（`shared/clip-kind.ts` 1 実装）
 *   3. 失敗するのは**レンダーのときだけ**（`E_PLUGIN_MISSING`）
 */
import { describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import { canonicalJson, createProject, parseProject, serializeProject } from "../../../src/core/project.ts";
import { clipKind, SCHEMA_VERSION } from "../../../src/core/schema.ts";
import { validateProject } from "../../../src/core/validate.ts";
import { computedClipKind } from "../../../src/server/computed.ts";
import { clipDurationFrames, clipKindOf } from "../../../src/shared/clip-kind.ts";
import { clipDuration as webClipDuration, clipKindOf as webClipKind } from "../../../web/src/lib/timeline.ts";

/** 既定設定のプロジェクトに、任意のクリップを V1 へ置いた生 JSON */
const base = (clips: unknown[]): Record<string, unknown> => {
  const project = createProject({ name: "p", fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 } });
  const raw = JSON.parse(serializeProject(project)) as Record<string, unknown>;
  (raw.tracks as Array<Record<string, unknown>>)[0]!.clips = clips;
  return raw;
};

const opaque = {
  id: "p1",
  type: "shape",
  start_f: 0,
  duration_f: 45,
  // プラグイン固有のパラメータ（本体は解釈しない）
  shape: "circle",
  radius: 120,
  nested: { color: "#ff0000", points: [1, 2, 3] },
};

describe("未知種別クリップ（opaque）", () => {
  test("project.json が開ける", () => {
    const p = parseProject(base([opaque]));
    expect(p.tracks[0]?.clips).toHaveLength(1);
    expect(clipKind(p.tracks[0]!.clips[0]!)).toBe("opaque");
  });

  test("プラグイン固有のフィールドが保存で消えない", () => {
    const p = parseProject(base([opaque]));
    const round = JSON.parse(serializeProject(p)) as typeof p;
    const clip = round.tracks[0]!.clips[0] as Record<string, unknown>;
    expect(clip.shape).toBe("circle");
    expect(clip.radius).toBe(120);
    expect(clip.nested).toEqual({ color: "#ff0000", points: [1, 2, 3] });
    // 往復しても内容が同一（canonicalJson で比較）
    expect(canonicalJson(round.tracks[0]!.clips[0])).toBe(canonicalJson(p.tracks[0]!.clips[0]));
  });

  test("validate は警告のみで、エラーにはしない", () => {
    const r = validateProject(parseProject(base([opaque])));
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("W_UNKNOWN_CLIP_TYPE");
  });

  test("長さは duration_f で決まる（1 フレーム幅に潰れない）", () => {
    expect(clipDurationFrames(opaque)).toBe(45);
    expect(webClipDuration(opaque as Parameters<typeof webClipDuration>[0])).toBe(45);
  });

  test("既知の種別が壊れている場合は opaque に逃げず、そのままエラーになる", () => {
    // type は "text" だが duration_f が無い → TextClip として失敗すべき
    expect(() => parseProject(base([{ id: "x1", type: "text", start_f: 0 }]))).toThrow(MontashError);
  });

  test("type を持たないクリップは受理しない（判別キーは必須）", () => {
    expect(() => parseProject(base([{ id: "c1", asset: "a", start_f: 0, in_f: 0, out_f: 30 }]))).toThrow(MontashError);
  });
});

describe("判別規則は 1 実装", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["media", { id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 90, speed: 1 }, "media"],
    ["text", { id: "x1", type: "text", start_f: 0, duration_f: 30 }, "text"],
    ["subtitle", { id: "s1", type: "subtitle", asset: "a", start_f: 0 }, "subtitle"],
    ["generator", { id: "g1", type: "generator", generator: "color", start_f: 0, duration_f: 30 }, "generator"],
    ["unknown", opaque, "opaque"],
  ];

  for (const [name, clip, expected] of cases) {
    test(`${name}: core / server / web が一致する`, () => {
      expect(clipKindOf(clip)).toBe(expected as never);
      expect(computedClipKind(clip)).toBe(expected as never);
      expect(webClipKind(clip as Parameters<typeof webClipKind>[0])).toBe(expected as never);
    });
  }
});

describe("schema_version", () => {
  test(`現行は ${SCHEMA_VERSION}`, () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  test("古いプロジェクトは E_SCHEMA_TOO_OLD で明快に落とす（v1.0 前なので移行しない）", () => {
    try {
      parseProject({ ...base([]), schema_version: 2 });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MontashError);
      expect((e as MontashError).code).toBe("E_SCHEMA_TOO_OLD");
      expect((e as MontashError).hint).toContain("montash init");
    }
  });
});
