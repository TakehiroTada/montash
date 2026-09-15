/**
 * Level C（capabilities）の境界（docs/14 §4）。
 *
 *   - `analyze` を宣言していないプラグインは `analyze()` を持つ効果を登録できない
 *   - 解析は「外で実行して値で注入する」（ducking / loudnorm と同じ形）
 *   - 解析が要る効果が無ければ ffmpeg は 1 度も起動しない
 *   - プラグインは ffmpeg を直接起動できない（`probe(filter)` の引数はホストが組み立てる）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLoadedPlugins, loadAllPlugins } from "../../../src/plugins/loader.ts";
import {
  analysisKey,
  buildEffectFilters,
  defineEffect,
  type EffectBuildContext,
  effectsNeedingAnalysis,
  registerEffect,
  videoEffects,
} from "../../../src/registry/effects.ts";

const ctx: EffectBuildContext = {
  fps: { num: 30, den: 1 },
  resolution: { width: 640, height: 360 },
  frames: 30,
  sampleRate: 48000,
};

async function makePlugin(root: string, id: string, manifestExtra: object, entry: string): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "montash-plugin.json"),
    JSON.stringify({ id, apiVersion: 1, version: "1.0.0", ...manifestExtra }),
  );
  await writeFile(join(dir, "index.js"), entry);
}

const envWith = (dir: string) => ({ MONTASH_PLUGIN_PATH: dir }) as NodeJS.ProcessEnv;

afterEach(() => {
  clearLoadedPlugins();
});

const ANALYZING_PLUGIN = `export default {
  register(host) {
    host.effects.define({
      name: "needs-analysis",
      target: "video",
      summary: "t",
      async analyze() { return { measured: 1 }; },
      build: () => ["null"],
    });
  },
};`;

describe("capabilities の宣言", () => {
  test("analyze を宣言しないプラグインは analyze() 付きの効果を登録できない", async () => {
    const root = await mkdtemp(join(tmpdir(), "montash-caps-"));
    await makePlugin(root, "com.example.undeclared", {}, ANALYZING_PLUGIN);

    const { plugins, failures } = await loadAllPlugins(null, { env: envWith(root) });
    expect(plugins).toEqual([]);
    expect(failures[0]?.error.code).toBe("E_PLUGIN_CAPABILITY_REQUIRED");
    expect(failures[0]?.error.hint).toContain('"capabilities": ["analyze"]');
    // 登録は行われていない
    expect(videoEffects.has("needs-analysis")).toBe(false);
  });

  test("宣言していれば登録できる", async () => {
    const root = await mkdtemp(join(tmpdir(), "montash-caps-"));
    await makePlugin(root, "com.example.declared", { capabilities: ["analyze"] }, ANALYZING_PLUGIN);

    const { plugins, failures } = await loadAllPlugins(null, { env: envWith(root) });
    expect(failures).toEqual([]);
    expect(plugins[0]?.registered.effects).toEqual(["video:needs-analysis"]);
    expect(videoEffects.has("needs-analysis")).toBe(true);
  });
});

describe("解析結果の注入", () => {
  test("analyze を持つ効果だけが解析対象に挙がる", () => {
    registerEffect(defineEffect({ name: "cap-plain", target: "video", summary: "", build: () => ["null"] }), "plugin");
    registerEffect(
      defineEffect({
        name: "cap-analyzed",
        target: "video",
        summary: "",
        analyze: async () => ({ v: 1 }),
        build: () => ["null"],
      }),
      "plugin",
    );

    const needing = effectsNeedingAnalysis("video", [{ type: "cap-plain" }, { type: "cap-analyzed" }]);
    expect(needing.map((s) => s.name)).toEqual(["cap-analyzed"]);
    expect(effectsNeedingAnalysis("video", [{ type: "cap-plain" }])).toEqual([]);
    expect(effectsNeedingAnalysis("video", undefined)).toEqual([]);
  });

  test("build() には解析結果が ctx.analysis として渡る", () => {
    registerEffect(
      defineEffect({
        name: "cap-uses-analysis",
        target: "video",
        summary: "",
        analyze: async () => ({ avg: 100 }),
        build: (_p, c) => [`eq=brightness=${(c.analysis as { avg: number } | undefined)?.avg ?? "none"}`],
      }),
      "plugin",
    );

    // 解析結果あり
    expect(
      buildEffectFilters("video", [{ type: "cap-uses-analysis" }], ctx, {
        [analysisKey("video", "cap-uses-analysis")]: { avg: 100 },
      }),
    ).toEqual(["eq=brightness=100"]);

    // 解析結果なし（build は既定の挙動に落ちる）
    expect(buildEffectFilters("video", [{ type: "cap-uses-analysis" }], ctx)).toEqual(["eq=brightness=none"]);
  });

  test("同じ効果を 2 度掛けても解析は 1 つを共有する", () => {
    const needing = effectsNeedingAnalysis("video", [
      { type: "cap-uses-analysis" },
      { type: "cap-uses-analysis", params: { x: 1 } },
    ]);
    expect(needing).toHaveLength(1);
  });
});
