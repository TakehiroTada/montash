/**
 * ジェネレータレジストリ（計画 P1-4、docs/05 §6.4）。
 *
 * 要点:
 *   1. 組み込みの `color` / `hold` も外部プラグインと同じ契約（`defineGenerator`）で定義されている
 *   2. 未登録の種別は **読み込み・保存は通り、レンダーでだけ** `E_PLUGIN_MISSING`（D-14 と同じ扱い）
 *   3. 種別ごとの意味検査は `validate()` フックとして仕様の隣にある（`hold` の `params.from_clip`）
 *   4. `requires` は `doctor` の検査対象に合成される
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import { createProject } from "../../../src/core/project.ts";
import { GeneratorClipSchema, type Project, ProjectSchema } from "../../../src/core/schema.ts";
import { validateProject } from "../../../src/core/validate.ts";
import { buildGraph } from "../../../src/ffmpeg/graph/builder.ts";
import {
  assertGeneratorAvailable,
  colorGenerator,
  defineGenerator,
  type GeneratorSpec,
  generators,
  holdGenerator,
  registerGenerator,
  validateGeneratorClip,
} from "../../../src/registry/generators.ts";
import { registeredRequirements, unregisterRequirements } from "../../../src/registry/requirements.ts";

const CTX = { fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 } };

const added: string[] = [];
function addTestGenerator(spec: GeneratorSpec) {
  registerGenerator(spec, "plugin");
  added.push(spec.name);
  return spec;
}

afterEach(() => {
  for (const name of added.splice(0)) {
    unregisterRequirements(`generator:${name}`);
    // レジストリからの取り消しは Phase 2（プラグインのアンロード）の仕事。ここでは要求だけ戻す
  }
});

/** 生成クリップ 1 本だけを持つプロジェクト */
function projectWithGenerator(generator: string, params: Record<string, unknown> = {}): Project {
  const project = createProject({ name: "gen", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.tracks[0]!.clips.push(
    GeneratorClipSchema.parse({ id: "g1", type: "generator", generator, params, start_f: 0, duration_f: 30 }),
  );
  return project;
}

describe("組み込みジェネレータ", () => {
  test("color / hold が builtin として登録されている", () => {
    expect(generators.names()).toEqual(["color", "hold"]);
    expect(generators.entry("color")?.source).toBe("builtin");
    expect(generators.entry("hold")?.source).toBe("builtin");
    expect(generators.get("color")).toBe(colorGenerator);
    expect(generators.get("hold")).toBe(holdGenerator);
  });

  test("defineGenerator は名前の形を検査する", () => {
    expect(() => defineGenerator({ name: "Color", summary: "x" })).toThrow(/invalid generator name/);
    expect(defineGenerator({ name: "count-down", summary: "x" }).name).toBe("count-down");
  });
});

describe("未登録のジェネレータ", () => {
  test("読み込み（スキーマ）は通る", () => {
    const clip = GeneratorClipSchema.parse({
      id: "g1",
      type: "generator",
      generator: "sparkle",
      params: { density: 3 },
      start_f: 0,
      duration_f: 30,
    });
    expect(clip.generator).toBe("sparkle");
    // 未知のパラメータもそのまま保持される（looseObject）
    expect(clip.params).toEqual({ density: 3 });
  });

  test("プロジェクト全体の読み込み・保存でも消えない", () => {
    const project = projectWithGenerator("sparkle", { density: 3 });
    const round = ProjectSchema.parse(JSON.parse(JSON.stringify(project)));
    expect(round.tracks[0]!.clips[0]).toMatchObject({ generator: "sparkle", params: { density: 3 } });
  });

  test("validate は警告だけ（エラーにしない）", () => {
    const result = validateProject(projectWithGenerator("sparkle"), {});
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("W_UNKNOWN_CLIP_TYPE");
    expect(result.warnings.find((w) => w.code === "W_UNKNOWN_CLIP_TYPE")?.path).toBe("/tracks/0/clips/0/generator");
  });

  test("レンダーでだけ E_PLUGIN_MISSING で止まる", () => {
    const project = projectWithGenerator("sparkle");
    try {
      buildGraph(project, { resolution: { width: 320, height: 180 }, source: () => "/x" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MontashError);
      expect((e as MontashError).code).toBe("E_PLUGIN_MISSING");
      expect((e as MontashError).detail).toMatchObject({ clip: "g1", generator: "sparkle" });
    }
  });

  test("登録済みの種別は E_PLUGIN_MISSING にはならない（フィルタグラフ未実装のまま）", () => {
    const project = projectWithGenerator("color", { color: "#000000" });
    try {
      buildGraph(project, { resolution: { width: 320, height: 180 }, source: () => "/x" });
      throw new Error("should have thrown");
    } catch (e) {
      // ジェネレータのレンダーは docs/09 M3。ここでは「プラグイン不足ではない」ことだけ確かめる
      expect((e as MontashError).code).toBe("E_NOT_IMPLEMENTED");
    }
    expect(assertGeneratorAvailable("g1", "color")).toBe(colorGenerator);
  });
});

describe("validate フック", () => {
  test("hold は params.from_clip を要求する（従来 core/validate.ts にあった検査）", () => {
    const result = validateProject(projectWithGenerator("hold"), {});
    expect(result.ok).toBe(false);
    const issue = result.errors.find((e) => e.code === "E_CLIP_NOT_FOUND");
    expect(issue?.message).toBe('hold generator "g1" needs params.from_clip');
    expect(issue?.path).toBe("/tracks/0/clips/0/params");
  });

  test("from_clip があれば通る", () => {
    const result = validateProject(projectWithGenerator("hold", { from_clip: "c1" }), {});
    expect(result.errors.map((e) => e.code)).not.toContain("E_CLIP_NOT_FOUND");
  });

  test("color はパラメータ検査を持たない", () => {
    expect(validateGeneratorClip({ id: "g1", generator: "color", params: {}, duration_f: 30 }, CTX)).toEqual([]);
  });

  test("プラグインのジェネレータも自分のパラメータを検査できる", () => {
    addTestGenerator(
      defineGenerator({
        name: "test-countdown",
        summary: "countdown",
        validate: (clip) =>
          typeof clip.params.from === "number"
            ? []
            : [{ code: "E_USAGE", message: `countdown "${clip.id}" needs params.from`, path: "/params" }],
      }),
    );
    const bad = validateGeneratorClip({ id: "g1", generator: "test-countdown", params: {}, duration_f: 30 }, CTX);
    expect(bad).toEqual([{ code: "E_USAGE", message: 'countdown "g1" needs params.from', path: "/params" }]);
    const ok = validateGeneratorClip(
      { id: "g1", generator: "test-countdown", params: { from: 3 }, duration_f: 30 },
      CTX,
    );
    expect(ok).toEqual([]);
  });
});

describe("requires", () => {
  test("宣言した ffmpeg フィルタが doctor の検査対象に載る", () => {
    addTestGenerator(defineGenerator({ name: "test-noise", summary: "noise", requires: ["geq"] }));
    const requirements = registeredRequirements();
    expect([...requirements.keys()]).toContain("generator:test-noise");
    expect(requirements.get("generator:test-noise")?.filters).toEqual(["geq"]);
  });

  test("組み込みの 2 種は requires を宣言しない（レンダー未実装のため。生成関数の PR で足す）", () => {
    expect(colorGenerator.requires).toBeUndefined();
    expect(holdGenerator.requires).toBeUndefined();
  });
});
