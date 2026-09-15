/**
 * トランジションレジストリ（計画 P1-4、docs/05 §7、docs/07 §4.2）。
 *
 * 要点:
 *   1. 別名表（`crossfade` → `fade`）が CLI のベタ書きからレジストリに移り、
 *      **レンダー時にも解決される**（手で書いた project.json でも効く）
 *   2. **未登録の `type` は従来どおり xfade へ素通し**（ffmpeg が持つ 50 種以上を本体に列挙しない）
 *   3. パラメータは仕様が無ければ従来どおりの許可文字、仕様があれば色や式も通る
 *   4. `requires: ["xfade"]` が `doctor` の検査対象に載る（既に必須なので集合は変わらない）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import { createProject } from "../../../src/core/project.ts";
import { ClipSchema, type Project, TransitionSchema, VideoAssetSchema } from "../../../src/core/schema.ts";
import { buildGraph } from "../../../src/ffmpeg/graph/builder.ts";
import { REQUIRED_FILTERS } from "../../../src/ffmpeg/locate.ts";
import { registeredRequirements, requiredFilters, unregisterRequirements } from "../../../src/registry/requirements.ts";
import {
  defineTransition,
  registerTransition,
  resolveTransitionType,
  TRANSITION_NAMES,
  transitionParamsSuffix,
  transitionSpec,
  transitions,
} from "../../../src/registry/transitions.ts";

const added: string[] = [];
afterEach(() => {
  for (const name of added.splice(0)) unregisterRequirements(`transition:${name}`);
});

/** c1/c2 を 1 本のトランジションで繋いだ 30fps のプロジェクト */
function projectWith(type: string, params: Record<string, unknown> = {}): Project {
  const project = createProject({ name: "tr", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = VideoAssetSchema.parse({ id: "a", type: "video", path: "a.mp4", duration_f: 300 });
  project.tracks[0]!.clips.push(
    ClipSchema.parse({ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 30 }),
    ClipSchema.parse({ id: "c2", type: "media", asset: "a", start_f: 30, in_f: 60, out_f: 90 }),
  );
  project.transitions.push(
    TransitionSchema.parse({ id: "t1", track: "V1", from: "c1", to: "c2", type, duration_f: 10, params }),
  );
  return project;
}

const filterOf = (project: Project) =>
  buildGraph(project, { resolution: { width: 320, height: 180 }, source: (a) => `/fixtures/${a.path}` }).filterComplex;

describe("組み込みトランジション", () => {
  test("docs/04 §8 が挙げる種類が builtin として登録されている", () => {
    for (const name of ["fade", "dissolve", "wipeleft", "circleopen", "pixelize", "radial", "custom"])
      expect(transitions.entry(name)?.source).toBe("builtin");
    expect(TRANSITION_NAMES).toContain("fade");
    expect(TRANSITION_NAMES).not.toContain("crossfade"); // 別名は正規名の一覧に出さない
  });

  test("defineTransition は名前の形を検査し、requires を既定で付ける", () => {
    expect(() => defineTransition({ name: "Wipe-Left", summary: "x" })).toThrow(/invalid transition name/);
    expect(defineTransition({ name: "hlslice", summary: "x" }).requires).toEqual(["xfade"]);
  });
});

describe("別名の解決", () => {
  test("crossfade は fade の別名として登録されている", () => {
    expect(transitions.entry("crossfade")?.source).toBe("builtin");
    expect(transitions.get("crossfade")?.aliasOf).toBe("fade");
    expect(resolveTransitionType("crossfade")).toBe("fade");
    expect(resolveTransitionType("fade")).toBe("fade");
    // 別名から仕様を引くと正規名の仕様が返る
    expect(transitionSpec("crossfade")).toBe(transitions.get("fade"));
  });

  test("手で書かれた project.json の別名もレンダー時に解決される", () => {
    expect(filterOf(projectWith("crossfade"))).toContain("xfade=transition=fade:");
  });
});

describe("未登録の type は素通しする", () => {
  test("resolveTransitionType はそのまま返す", () => {
    expect(resolveTransitionType("hrslice")).toBe("hrslice");
  });

  test("レンダーも従来どおり xfade へ渡す（E_PLUGIN_MISSING にしない）", () => {
    // ffmpeg が持つ xfade は 50 種以上あり、本体に列挙しない（registry/transitions.ts 冒頭）
    expect(filterOf(projectWith("hrslice"))).toContain("xfade=transition=hrslice:");
  });
});

describe("パラメータ", () => {
  test("仕様が無いパラメータは従来どおりの許可文字", () => {
    expect(transitionParamsSuffix("t1", "wipeleft", { offset: 2 })).toBe(":offset=2");
    expect(() => transitionParamsSuffix("t1", "wipeleft", { color: "#ff0000" })).toThrow(
      /parameter "color" has unsupported characters/,
    );
    expect(() => transitionParamsSuffix("t1", "wipeleft", { "bad key": 1 })).toThrow(/invalid parameter name/);
    expect(transitionParamsSuffix("t1", "wipeleft", {})).toBe("");
  });

  test("custom の expr は式を受け取り、シングルクォートで包んで渡す", () => {
    expect(transitionParamsSuffix("t1", "custom", { expr: "A*(1-P)+B*P" })).toBe(":expr='A*(1-P)+B*P'");
    // `,` を含む式も通る（従来のホワイトリストでは弾かれていた）
    expect(transitionParamsSuffix("t1", "custom", { expr: "if(gt(X,W/2),A,B)" })).toBe(":expr='if(gt(X,W/2),A,B)'");
    // クォートとバックスラッシュは ffmpeg のクォートを壊すので拒否する
    expect(() => transitionParamsSuffix("t1", "custom", { expr: "A'B" })).toThrow(/unsupported characters/);
  });

  test("required なパラメータが欠けていれば E_USAGE", () => {
    try {
      transitionParamsSuffix("t1", "custom", {});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MontashError);
      expect((e as MontashError).code).toBe("E_USAGE");
      expect((e as MontashError).message).toContain("needs params.expr");
    }
  });

  test("プラグインが宣言した色パラメータは # を通す", () => {
    const spec = defineTransition({
      name: "test_fadecolor",
      summary: "fade through a colour",
      params: { c: { type: "color", describe: "colour to fade through" } },
    });
    registerTransition(spec, "plugin");
    added.push(spec.name);
    expect(transitionParamsSuffix("t1", "test_fadecolor", { c: "#ff8800" })).toBe(":c=#ff8800");
    expect(() => transitionParamsSuffix("t1", "test_fadecolor", { c: "not a colour!" })).toThrow(/is not a colour/);
  });
});

describe("requires", () => {
  test("組み込みが宣言した xfade が doctor の検査対象に載る", () => {
    const requirements = registeredRequirements();
    expect([...requirements.keys()]).toContain("transition:fade");
    expect(requirements.get("transition:fade")?.filters).toEqual(["xfade"]);
  });

  test("xfade は既に必須なので合成しても集合は変わらない", () => {
    expect(requiredFilters(REQUIRED_FILTERS).filter((f) => f === "xfade")).toEqual(["xfade"]);
  });
});
