/**
 * Inspector の spec 駆動フォーム（docs/06 §2.5, §3.2, §3.6、計画 P3-2）。
 *
 * `GET /api/specs` の定義だけから入力欄・CLI 例・許可判定を導けること、
 * プラグイン不足（定義の無い効果 / 未知種別のクリップ）でも値を失わないことを守る。
 */
import { describe, expect, test } from "bun:test";
import {
  availableEffects,
  type CommandSpec,
  clipCliExamples,
  clipCommands,
  clipEffects,
  clipPropertyRows,
  commandDisabledReason,
  controlOf,
  type EffectSpec,
  effectFields,
  effectSetArgs,
  effectTargetOfTrack,
  effectViews,
  isCommandAllowed,
  paramFlag,
  type Specs,
  sliderStep,
  unknownParams,
} from "../../../web/src/lib/specs.ts";
import type { ClipLike } from "../../../web/src/lib/timeline.ts";

// 実際の `/api/specs` の抜粋（src/registry/effects.ts と src/cli/commands/* の定義そのまま）
const colorSpec: EffectSpec = {
  name: "color",
  target: "video",
  source: "builtin",
  summary: "adjust brightness / contrast / saturation / gamma (eq)",
  requires: ["eq"],
  params: {
    brightness: { type: "number", describe: "-1.0 .. 1.0", min: -1, max: 1 },
    saturation: { type: "number", describe: "0.0 .. 3.0", min: 0, max: 3 },
  },
};

const blurSpec: EffectSpec = {
  name: "blur",
  target: "video",
  source: "builtin",
  summary: "gaussian blur (gblur)",
  requires: ["gblur"],
  params: {
    sigma: { type: "number", describe: "0.0 .. 128.0", default: 4, min: 0, max: 128 },
    steps: { type: "number", describe: "1 .. 6", default: 1, min: 1, max: 6 },
  },
};

const rotateSpec: EffectSpec = {
  name: "rotate",
  target: "video",
  source: "plugin",
  summary: "rotate by 90 / 180 / 270 degrees (transpose)",
  requires: ["transpose"],
  params: {
    angle: { type: "string", describe: "clockwise rotation", choices: ["90", "180", "270"], required: true },
    fit: { type: "boolean", describe: "letterbox back", default: true },
    file: { type: "string", describe: "free text" },
  },
};

const gainSpec: EffectSpec = {
  name: "gain",
  target: "audio",
  source: "plugin",
  summary: "audio gain",
  requires: [],
  params: { db: { type: "number", describe: "gain in dB" } },
};

const command = (over: Partial<CommandSpec> & { path: string }): CommandSpec => ({
  summary: "",
  workflows: [],
  mutates: true,
  positionals: [{ name: "id", describe: "clip ID", type: "string", required: true }],
  options: {},
  examples: [],
  ...over,
});

const SPECS: Specs = {
  version: "0.0.1",
  effects: [colorSpec, blurSpec, rotateSpec, gainSpec],
  commands: [
    command({
      path: "clip trim",
      options: {
        in: { type: "string", describe: "source in point", time: true },
        ripple: { type: "string", describe: "ripple following elements" },
      },
      examples: [{ cmd: "montash clip trim c2 --in +0.5 --ripple", note: "cut 0.5s off the head" }],
    }),
    command({
      path: "clip split",
      options: { at: { type: "string", describe: "timeline position to split at", time: true, required: true } },
      examples: [{ cmd: "montash clip split c1 --at 00:00:08.000 --json" }],
    }),
    command({
      path: "clip move",
      options: {
        by: { type: "string", describe: "signed timeline offset", time: true },
        before: { type: "string", describe: "place immediately before this clip" },
      },
      examples: [{ cmd: "montash clip move c3 --before c2 --ripple" }, { cmd: "montash clip move c2 --by +f:15" }],
    }),
    command({
      path: "clip delete",
      positionals: [{ name: "ids", describe: "clip IDs", type: "string", required: true, variadic: true }],
      examples: [{ cmd: "montash clip delete c5 --ripple" }],
    }),
    command({
      path: "effect add",
      positionals: [
        { name: "clip", describe: "clip ID", type: "string", required: true },
        { name: "effect", describe: "effect name", type: "string", required: true },
      ],
      options: { saturation: { type: "number", describe: "0.0 .. 3.0" } },
      examples: [{ cmd: "montash effect add c1 color --saturation 1.2" }],
    }),
    command({
      path: "effect list",
      mutates: false,
      positionals: [{ name: "clip", describe: "clip ID", type: "string", required: true }],
      examples: [{ cmd: "montash effect list c1 --json" }],
    }),
    command({
      path: "import",
      positionals: [{ name: "path", describe: "file path", type: "string", required: true }],
      examples: [{ cmd: "montash import a.mp4" }],
    }),
  ],
};

const clip = (over: Partial<ClipLike> = {}): ClipLike => ({ id: "c1", type: "media", start_f: 0, ...over }) as ClipLike;

describe("効果の対象はトラック種別で決まる（cli/commands/effect.ts と同じ規則）", () => {
  test("audio トラックだけ音声効果", () => {
    expect(effectTargetOfTrack("audio")).toBe("audio");
    expect(effectTargetOfTrack("video")).toBe("video");
    expect(effectTargetOfTrack("text")).toBe("video");
    expect(effectTargetOfTrack(undefined)).toBe("video");
  });

  test("候補は対象で絞る", () => {
    expect(availableEffects(SPECS, "video").map((e) => e.name)).toEqual(["color", "blur", "rotate"]);
    expect(availableEffects(SPECS, "audio").map((e) => e.name)).toEqual(["gain"]);
    expect(availableEffects(null, "video")).toEqual([]);
  });
});

describe("パラメータ定義 → 入力の種類", () => {
  test("number は min/max があればスライダー、無ければ数値入力", () => {
    expect(controlOf({ type: "number", describe: "", min: 0, max: 3 })).toBe("slider");
    expect(controlOf({ type: "number", describe: "" })).toBe("number");
    expect(controlOf({ type: "number", describe: "", min: 0 })).toBe("number");
  });

  test("string は choices があればセレクト、無ければテキスト。boolean はチェックボックス", () => {
    expect(controlOf({ type: "string", describe: "", choices: ["a", "b"] })).toBe("select");
    expect(controlOf({ type: "string", describe: "" })).toBe("text");
    expect(controlOf({ type: "boolean", describe: "" })).toBe("checkbox");
  });

  test("整数だけを取るパラメータのスライダーは 1 刻み（steps=1.5 のような値を作らない）", () => {
    expect(sliderStep(blurSpec.params.steps as never)).toBe(1);
    expect(sliderStep(blurSpec.params.sigma as never)).toBe(1);
    // 既定値の無い連続値は範囲の 1/100 以下の「きりの良い」刻み
    expect(sliderStep(colorSpec.params.saturation as never)).toBe(0.01);
    expect(sliderStep({ type: "number", describe: "", min: -1000, max: 1000 })).toBe(10);
  });
});

describe("効果 1 つぶんのフォーム", () => {
  test("宣言順に並び、値は params → 既定値の順で埋まる", () => {
    const fields = effectFields(blurSpec, { sigma: 12 });
    expect(fields.map((f) => f.name)).toEqual(["sigma", "steps"]);
    expect(fields[0]).toMatchObject({ control: "slider", value: 12, present: true, min: 0, max: 128, step: 1 });
    // 書かれていないパラメータは既定値を「既定」として見せる（present: false）
    expect(fields[1]).toMatchObject({ name: "steps", value: 1, present: false });
  });

  test("choices はセレクト、boolean はチェックボックス、required が立つ", () => {
    const fields = effectFields(rotateSpec, { angle: "90" });
    expect(fields[0]).toMatchObject({ control: "select", value: "90", required: true, choices: ["90", "180", "270"] });
    expect(fields[1]).toMatchObject({ control: "checkbox", value: true, present: false });
    expect(fields[2]).toMatchObject({ control: "text", value: "" });
  });

  test("型の合わない値は既定値に落とす（壊れた project.json でも描ける）", () => {
    const fields = effectFields(blurSpec, { sigma: "とても" });
    expect(fields[0]).toMatchObject({ value: 4, present: false });
  });

  test("定義に無いパラメータは失わずに読み取り専用で見せる", () => {
    expect(unknownParams(blurSpec, { sigma: 1, wobble: 3 })).toEqual(["wobble"]);
    // 定義そのものが無い（プラグイン不足）ときは全部が未知
    expect(unknownParams(null, { sigma: 1, wobble: 3 })).toEqual(["sigma", "wobble"]);
  });
});

describe("クリップの効果一覧（effect list の missing に相当）", () => {
  test("定義があれば spec を添え、無ければ missing で「プラグイン不足」", () => {
    const views = effectViews(
      SPECS,
      clip({
        effects: [
          { type: "blur", params: { sigma: 8 } },
          { type: "glow", params: { radius: 3 } },
        ],
      }),
      "video",
    );
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ index: 0, type: "blur", missing: false });
    expect(views[0]?.spec?.source).toBe("builtin");
    expect(views[1]).toMatchObject({ index: 1, type: "glow", missing: true, spec: null, params: { radius: 3 } });
  });

  test("対象が違う効果は missing 扱い（音声トラックに映像効果）", () => {
    expect(effectViews(SPECS, clip({ effects: [{ type: "blur" }] }), "audio")[0]?.missing).toBe(true);
  });

  test("effects が無い・壊れていても落ちない", () => {
    expect(clipEffects(clip())).toEqual([]);
    expect(clipEffects(clip({ effects: "no" }))).toEqual([]);
    expect(clipEffects(clip({ effects: [null, 1, { params: {} }, { type: "blur" }] }))).toEqual([
      { type: "blur", params: {} },
    ]);
  });
});

describe("値の変更は `effect set` の発行（docs/06 §1.1）", () => {
  test("効果は index で指すので、同じ効果を 2 回掛けても取り違えない", () => {
    expect(effectSetArgs("c1", 1, "sigma", 12)).toEqual(["effect", "set", "c1", "1", "--sigma", "12"]);
  });

  test("boolean の false は yargs の否定形", () => {
    expect(paramFlag("fit", true)).toEqual(["--fit"]);
    expect(paramFlag("fit", false)).toEqual(["--no-fit"]);
    expect(paramFlag("mode", "avg")).toEqual(["--mode", "avg"]);
  });
});

describe("許可リスト（docs/06 §3.3）", () => {
  const allowlist = ["checkout", "assets set", "preview build"];

  test("サーバの checkAllowlist と同じ規則で照合する", () => {
    expect(isCommandAllowed(allowlist, "checkout")).toBe(true);
    expect(isCommandAllowed(allowlist, "assets set")).toBe(true);
    expect(isCommandAllowed(allowlist, "assets remove")).toBe(false);
    expect(isCommandAllowed(allowlist, "effect set")).toBe(false);
  });

  test("`effect set` が許可されていなければ理由を返し、UI は入力を無効化する", () => {
    const reason = commandDisabledReason("effect set", { allowlist, readOnly: false });
    expect(reason).toContain("effect set");
    expect(reason).toContain("許可リスト");
  });

  test("--read-only はコマンドによらず変更不可", () => {
    expect(commandDisabledReason("effect set", { allowlist: ["effect set"], readOnly: true })).toContain("--read-only");
  });

  test("許可されていれば null（= 有効化）", () => {
    expect(commandDisabledReason("effect set", { allowlist: ["effect set"], readOnly: false })).toBeNull();
    expect(commandDisabledReason("effect set", { allowlist: ["effect"], readOnly: false })).toBeNull();
  });
});

describe("CLI 例はコマンド定義から組む（/api/cli-examples の置き換え。docs/06 §3.6）", () => {
  test("第 1 位置引数がクリップ ID の変更コマンドだけを拾う", () => {
    expect(clipCommands(SPECS).map((c) => c.path)).toEqual([
      "clip trim",
      "clip split",
      "clip move",
      "clip delete",
      "effect add",
    ]);
  });

  test("クリップ ID を差し替え、絶対時刻は再生ヘッドにする", () => {
    const examples = clipCliExamples(SPECS, "c9", 547);
    expect(examples).toEqual([
      "montash clip trim c9 --in +0.5 --ripple",
      "montash clip split c9 --at f:547",
      "montash clip move c9 --by +f:15",
      "montash clip delete c9 --ripple",
      "montash effect add c9 color --saturation 1.2",
    ]);
  });

  test("別のクリップを要求する例（--before c2）は埋められないので出さない", () => {
    expect(clipCliExamples(SPECS, "c9", 0).join("\n")).not.toContain("--before");
  });

  test("再生ヘッドは切り捨て、負にならない。定義が無ければ例も無い", () => {
    expect(clipCliExamples(SPECS, "c9", 12.9)).toContain("montash clip split c9 --at f:12");
    expect(clipCliExamples(SPECS, "c9", -5)).toContain("montash clip split c9 --at f:0");
    expect(clipCliExamples(null, "c9", 0)).toEqual([]);
  });
});

describe("プロパティ行は種別ごとの固定リストを持たない", () => {
  test("computed の区間が先、残りはクリップが実際に持つキー", () => {
    const rows = clipPropertyRows(clip({ type: "media", asset: "a", in_f: 0, out_f: 90 }), "V1", {
      start_f: 0,
      end_f: 90,
      duration_f: 90,
    });
    expect(rows.slice(0, 4)).toEqual([
      { key: "track", value: "V1" },
      { key: "start_f", value: "0" },
      { key: "end_f", value: "90" },
      { key: "duration_f", value: "90" },
    ]);
    expect(rows.map((r) => r.key)).not.toContain("id");
    expect(rows.map((r) => r.key)).not.toContain("effects");
    expect(rows).toContainEqual({ key: "asset", value: "a" });
  });

  test("未知種別（opaque）のプラグイン由来フィールドも消えない", () => {
    const rows = clipPropertyRows(
      clip({ id: "x1", type: "particles", duration_f: 60, density: 0.8, palette: { a: 1 } }),
      "V2",
      { start_f: 30, end_f: 90, duration_f: 60 },
    );
    expect(rows).toContainEqual({ key: "type", value: "particles" });
    expect(rows).toContainEqual({ key: "density", value: "0.8" });
    expect(rows).toContainEqual({ key: "palette", value: '{"a":1}' });
  });
});
