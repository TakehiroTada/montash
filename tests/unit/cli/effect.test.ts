/**
 * `effect` コマンド群（docs/04 §effect、W-18）。
 *
 * ハンドラを直接呼び、一時プロジェクトの project.json を検査する。
 * 効果そのもの（フィルタ文字列）はレジストリ側のテストで見るので、ここは
 * 「クリップの `effects[]` をどう並べ替えるか」と引数の導出に絞る。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectAdd, effectList, effectPresets, effectRemove, effectSet } from "../../../src/cli/commands/effect.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject, saveProject } from "../../../src/core/project.ts";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: true,
  quiet: false,
  verbose: false,
  dryRun: false,
  yes: false,
  noColor: true,
  timeFormat: "seconds",
  ...over,
});

let dir = "";
const ctx = (over: Partial<GlobalOptions> = {}) =>
  createContext(globals(over), { cwd: dir, env: {}, isTTY: false, argv: ["effect"] });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-effect-"));
  const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  project.assets.a = {
    id: "a",
    type: "video",
    path: "a.mp4",
    owned: false,
    tags: [],
    duration_f: 300,
  } as never;
  project.tracks[0]!.clips.push({
    id: "c1",
    type: "media",
    asset: "a",
    start_f: 0,
    in_f: 0,
    out_f: 60,
    speed: 1,
    pitch_keep: false,
    loop: false,
    link: null,
    effects: [],
  } as never);
  await initProjectDir(dir, project);
  await saveProject(dir, project);
  await recordInitialOp(dir, project, ctx());
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const effectsOf = async () => {
  const p = await loadProject(dir);
  return (p.tracks[0]!.clips[0] as { effects: Array<{ type: string; params: Record<string, unknown> }> }).effects;
};

describe("effect presets", () => {
  test("組み込みの color がパラメータ付きで載る", async () => {
    const res = await effectPresets.handler(ctx(), { target: "video" });
    const list = res.result as Array<{ name: string; source: string; params: Record<string, unknown> }>;
    const color = list.find((e) => e.name === "color");
    expect(color?.source).toBe("builtin");
    expect(color?.params.saturation).toMatchObject({ type: "number", min: 0, max: 3 });
  });
});

describe("effect add", () => {
  test("効果が追加され、パラメータが数値として入る", async () => {
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", saturation: 1.2 });
    expect(await effectsOf()).toEqual([{ type: "color", params: { saturation: 1.2 } }]);
  });

  test("文字列で来た数値を型に合わせて解釈する（CLI からの入力）", async () => {
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", saturation: "1.5" });
    expect((await effectsOf())[0]?.params.saturation).toBe(1.5);
  });

  test("その効果が受け取らない引数は無視する", async () => {
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", saturation: 1.1, index: undefined, sigma: 9 });
    expect(await effectsOf()).toEqual([{ type: "color", params: { saturation: 1.1 } }]);
  });

  test("--index で差し込み位置を指定できる", async () => {
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", saturation: 1.1 });
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", gamma: 1.2, index: 0 });
    expect((await effectsOf()).map((e) => e.params)).toEqual([{ gamma: 1.2 }, { saturation: 1.1 }]);
  });

  test("範囲外の値はレンダーまで持ち越さずここで弾く", async () => {
    expect(effectAdd.handler(ctx(), { clip: "c1", effect: "color", saturation: 99 })).rejects.toThrow(/must be <= 3/);
    expect(await effectsOf()).toEqual([]);
  });

  test("未登録の効果は E_PLUGIN_MISSING（終了コードは 1、I/O ではない）", async () => {
    try {
      await effectAdd.handler(ctx(), { clip: "c1", effect: "glow" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MontashError);
      expect((e as MontashError).code).toBe("E_PLUGIN_MISSING");
      expect((e as MontashError).exitCode).toBe(1);
    }
  });
});

describe("effect set", () => {
  beforeEach(async () => {
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", saturation: 1.2, brightness: 0.05 });
  });

  test("指定した値だけ更新し、他は残す", async () => {
    await effectSet.handler(ctx(), { clip: "c1", effect: "color", saturation: 1.05 });
    expect((await effectsOf())[0]?.params).toEqual({ saturation: 1.05, brightness: 0.05 });
  });

  test("index で並べ替えられる", async () => {
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", gamma: 1.1 });
    await effectSet.handler(ctx(), { clip: "c1", effect: "1", index: 0 });
    expect((await effectsOf()).map((e) => e.params)).toEqual([{ gamma: 1.1 }, { saturation: 1.2, brightness: 0.05 }]);
  });

  test("掛かっていない効果は E_EFFECT_NOT_FOUND", async () => {
    expect(effectSet.handler(ctx(), { clip: "c1", effect: "nope" })).rejects.toThrow(MontashError);
  });
});

describe("effect remove / list", () => {
  test("名前でも index でも外せる", async () => {
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", saturation: 1.2 });
    await effectRemove.handler(ctx(), { clip: "c1", effect: "color" });
    expect(await effectsOf()).toEqual([]);

    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", gamma: 1.1 });
    await effectRemove.handler(ctx(), { clip: "c1", effect: "0" });
    expect(await effectsOf()).toEqual([]);
  });

  test("list は適用順に返し、プラグイン不足の効果には印を付ける", async () => {
    await effectAdd.handler(ctx(), { clip: "c1", effect: "color", saturation: 1.2 });
    // プラグイン不在の状態を模す（未知の効果が project.json に残っているケース）
    const p = await loadProject(dir);
    (p.tracks[0]!.clips[0] as { effects: unknown[] }).effects.push({ type: "glow", params: { radius: 8 } });
    await saveProject(dir, p);

    const res = await effectList.handler(ctx(), { clip: "c1" });
    const out = res.result as { effects: Array<{ type: string; missing?: boolean }> };
    expect(out.effects.map((e) => e.type)).toEqual(["color", "glow"]);
    expect(out.effects[0]?.missing).toBeUndefined();
    expect(out.effects[1]?.missing).toBe(true);
  });
});

describe("プラグインのエフェクトのパラメータが CLI オプションに載る", () => {
  // ドッグフーディングで踏んだ不具合（`effect add c2 denoise --amount 10` が
  // `Unknown arguments: amount` になった）。`effect add` / `effect set` のオプションは
  // 「登録済みエフェクトのパラメータの和集合」なので、モジュール読み込み時に固めてはいけない。
  test("後から登録した効果のパラメータが getCommands() 経由で現れる", async () => {
    const { getCommands } = await import("../../../src/registry/commands.ts");
    const { defineEffect, registerEffect } = await import("../../../src/registry/effects.ts");
    const optionsOf = async (path: string) => {
      const spec = (await getCommands()).find((c) => c.path === path);
      return Object.keys(spec?.options ?? {});
    };

    expect(await optionsOf("effect add")).not.toContain("late-param");

    registerEffect(
      defineEffect({
        name: "late-registered",
        target: "video",
        summary: "",
        params: { "late-param": { type: "number", describe: "added after module load" } },
        build: () => [],
      }),
      "plugin",
    );

    // 再取得すると載っている（schema / help / yargs はすべてここを通る）
    expect(await optionsOf("effect add")).toContain("late-param");
    expect(await optionsOf("effect set")).toContain("late-param");
  });
});
