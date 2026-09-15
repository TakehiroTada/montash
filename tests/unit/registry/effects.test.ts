/**
 * エフェクトレジストリ（docs/13 D-15、計画 P0-3）。
 *
 * 要点:
 *   1. 組み込み（color）も外部プラグインとまったく同じ契約で定義されている
 *   2. `build()` は純関数で、パラメータからフィルタ片を返すだけ
 *   3. 未登録の種別は「未実装」ではなく **プラグイン不足**（`E_PLUGIN_MISSING`）
 *   4. クリップの `effects[]` は**配列順**に展開される
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import {
  audioEffects,
  buildEffectFilters,
  colorEffect,
  defineEffect,
  type EffectBuildContext,
  registerEffect,
  resolveEffectParams,
  videoEffects,
} from "../../../src/registry/effects.ts";
import { registeredRequirements, unregisterRequirements } from "../../../src/registry/requirements.ts";

const ctx: EffectBuildContext = {
  fps: { num: 30, den: 1 },
  resolution: { width: 1920, height: 1080 },
  frames: 90,
  sampleRate: 48000,
};

const added: string[] = [];
function addTestEffect(spec: Parameters<typeof registerEffect>[0]) {
  registerEffect(spec, "plugin");
  added.push(`effect:${spec.target}:${spec.name}`);
  return spec;
}

afterEach(() => {
  for (const id of added.splice(0)) unregisterRequirements(id);
});

describe("組み込みエフェクト", () => {
  test("color は builtin として登録されている", () => {
    expect(videoEffects.has("color")).toBe(true);
    expect(videoEffects.entry("color")?.source).toBe("builtin");
  });

  test("color の出力は従来の eq= と同じ（指定したキーだけ固定順）", () => {
    expect(colorEffect.build({ saturation: 1.2, brightness: -0.1 }, ctx)).toEqual([
      "eq=brightness=-0.1:saturation=1.2",
    ]);
    expect(colorEffect.build({ gamma: 1.1 }, ctx)).toEqual(["eq=gamma=1.1"]);
    // 何も指定が無ければフィルタを足さない
    expect(colorEffect.build({}, ctx)).toEqual([]);
  });

  test("必要な ffmpeg フィルタが doctor の検査対象に載っている", () => {
    const ids = [...registeredRequirements().keys()];
    expect(ids).toContain("effect:video:color");
  });
});

describe("パラメータの解決", () => {
  const spec = defineEffect({
    name: "test-params",
    target: "video",
    summary: "for tests",
    params: {
      sigma: { type: "number", describe: "blur radius", default: 4, min: 0, max: 64 },
      mode: { type: "string", describe: "mode", choices: ["a", "b"], default: "a" },
      on: { type: "boolean", describe: "toggle" },
      must: { type: "number", describe: "required one", required: true },
    },
    build: () => [],
  });

  test("既定値を当てる", () => {
    expect(resolveEffectParams(spec, { must: 1 })).toEqual({ must: 1, sigma: 4, mode: "a" });
  });

  test("範囲・型・choices を検査する", () => {
    expect(() => resolveEffectParams(spec, { must: 1, sigma: 999 })).toThrow(/sigma must be <= 64/);
    expect(() => resolveEffectParams(spec, { must: 1, sigma: -1 })).toThrow(/sigma must be >= 0/);
    expect(() => resolveEffectParams(spec, { must: 1, mode: "z" })).toThrow(/mode must be one of: a, b/);
    expect(() => resolveEffectParams(spec, { must: 1, on: "yes" })).toThrow(/on must be a boolean/);
    expect(() => resolveEffectParams(spec, {})).toThrow(/must is required/);
  });

  test("未知のキーは落とさずそのまま通す（プラグインが後から意味を足せる）", () => {
    expect(resolveEffectParams(spec, { must: 1, future: "x" }).future).toBe("x");
  });
});

describe("展開", () => {
  test("effects[] は配列順に展開される", () => {
    addTestEffect(
      defineEffect({
        name: "mark-a",
        target: "video",
        summary: "",
        params: { n: { type: "number", describe: "", default: 1 } },
        build: (p) => [`a=${p.n as number}`],
      }),
    );
    addTestEffect(defineEffect({ name: "mark-b", target: "video", summary: "", build: () => ["b=1", "b=2"] }));

    const out = buildEffectFilters("video", [{ type: "mark-b" }, { type: "mark-a", params: { n: 7 } }], ctx);
    expect(out).toEqual(["b=1", "b=2", "a=7"]);
  });

  test("空・未指定なら何も足さない", () => {
    expect(buildEffectFilters("video", [], ctx)).toEqual([]);
    expect(buildEffectFilters("video", undefined, ctx)).toEqual([]);
  });

  test("未登録の種別はプラグイン不足（E_PLUGIN_MISSING）", () => {
    try {
      buildEffectFilters("video", [{ type: "nope" }], ctx);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MontashError);
      expect((e as MontashError).code).toBe("E_PLUGIN_MISSING");
      expect((e as MontashError).message).toContain("unknown video effect 'nope'");
    }
  });

  test("keyframes はまだ実装されていない（F-FX-8）", () => {
    expect(() => buildEffectFilters("video", [{ type: "color", keyframes: [{ f: 0 }] }], ctx)).toThrow(
      /keyframes are not implemented/,
    );
  });

  test("映像と音声のレジストリは別（同名でも混ざらない）", () => {
    addTestEffect(defineEffect({ name: "dup", target: "video", summary: "", build: () => ["v=1"] }));
    addTestEffect(defineEffect({ name: "dup", target: "audio", summary: "", build: () => ["a=1"] }));
    expect(buildEffectFilters("video", [{ type: "dup" }], ctx)).toEqual(["v=1"]);
    expect(buildEffectFilters("audio", [{ type: "dup" }], ctx)).toEqual(["a=1"]);
    expect(videoEffects.has("dup")).toBe(true);
    expect(audioEffects.has("dup")).toBe(true);
  });
});

describe("プラグイン由来の登録", () => {
  test("source: plugin として出自が残り、requires が doctor に載る", () => {
    addTestEffect(
      defineEffect({ name: "from-plugin", target: "video", summary: "", requires: ["gblur"], build: () => ["gblur"] }),
    );
    expect(videoEffects.entry("from-plugin")?.source).toBe("plugin");
    expect([...registeredRequirements().keys()]).toContain("effect:video:from-plugin");
  });
});
