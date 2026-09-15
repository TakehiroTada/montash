/**
 * 組み込みの**音声**エフェクト（docs/07 §3a・§8a）。
 *
 * 要点は映像側（`builtin-effects.test.ts`）とまったく同じ:
 *   1. **組み込みも外部プラグインと同じ契約**（`defineEffect` + 純関数の `build()`）
 *   2. `build()` は既定値のときも指定時も**決まったフィルタ文字列**を返す（`--dry-run` で読める形）
 *   3. 範囲外・組み合わせ不正は `E_USAGE`
 *   4. 各エフェクトの `requires` が `doctor` の検査対象（`registeredRequirements()`）に載る
 *
 * 加えて音声固有の 2 点を見る:
 *   - dB で受けて**線形振幅**で ffmpeg に渡す値（`acompressor` の threshold / makeup）が、
 *     宣言した範囲のどこを取っても **ffmpeg が受け付ける範囲に収まる**こと
 *   - 映像レジストリには載らないこと（レジストリは対象ごとに別）
 */
import { describe, expect, test } from "bun:test";
import type { MontashError } from "../../../src/cli/errors.ts";
import {
  audioEffects,
  audioEqEffect,
  buildEffectFilters,
  compressEffect,
  denoiseEffect,
  type EffectBuildContext,
  type EffectSpec,
  videoEffects,
} from "../../../src/registry/effects.ts";
import { registeredRequirements } from "../../../src/registry/requirements.ts";

const ctx: EffectBuildContext = {
  fps: { num: 30, den: 1 },
  resolution: { width: 640, height: 360 },
  frames: 90,
  sampleRate: 48000,
};

/** `effects[]` の 1 要素として展開する（既定値の適用と範囲検査を通した実際の経路） */
function apply(type: string, params: Record<string, unknown> = {}): string[] {
  return buildEffectFilters("audio", [{ type, params }], ctx);
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as MontashError).code;
  }
  return undefined;
}

const BUILTIN: readonly EffectSpec[] = [denoiseEffect, audioEqEffect, compressEffect];

describe("登録", () => {
  test("追加した組み込みはすべて builtin として登録されている", () => {
    for (const spec of BUILTIN) {
      expect(audioEffects.has(spec.name)).toBe(true);
      expect(audioEffects.entry(spec.name)?.source).toBe("builtin");
      expect(audioEffects.entry(spec.name)?.value).toBe(spec);
    }
    // レジストリはプロセス内で 1 つなので、他のテストが登録したプラグイン由来は除いて数える。
    const builtinNames = audioEffects.names().filter((n) => audioEffects.entry(n)?.source === "builtin");
    expect(builtinNames).toEqual(["compress", "denoise", "eq"]);
  });

  test("requires が doctor の検査対象（registeredRequirements）に載る", () => {
    const ids = [...registeredRequirements().keys()];
    for (const spec of BUILTIN) expect(ids).toContain(`effect:audio:${spec.name}`);
    // 宣言した ffmpeg フィルタがそのまま検査対象の中身になっている
    expect(registeredRequirements().get("effect:audio:denoise")?.filters).toEqual(["afftdn", "highpass"]);
    expect(registeredRequirements().get("effect:audio:eq")?.filters).toEqual(["highpass", "lowpass", "equalizer"]);
    expect(registeredRequirements().get("effect:audio:compress")?.filters).toEqual(["acompressor"]);
  });

  test("すべて音声向けで、要求フィルタを宣言している", () => {
    for (const spec of BUILTIN) {
      expect(spec.target).toBe("audio");
      expect(spec.requires?.length).toBeGreaterThan(0);
    }
  });

  test("映像レジストリには載らない（対象ごとに別のレジストリ）", () => {
    for (const spec of BUILTIN) expect(videoEffects.has(spec.name)).toBe(false);
    expect(() => buildEffectFilters("video", [{ type: "denoise" }], ctx)).toThrow(/unknown video effect 'denoise'/);
    expect(codeOf(() => buildEffectFilters("video", [{ type: "denoise" }], ctx))).toBe("E_PLUGIN_MISSING");
    // 映像の `color` は ffmpeg の `eq` フィルタを使うが、音声の `eq` エフェクトとは別物
    expect(audioEffects.has("color")).toBe(false);
  });

  test("外部ファイルも解析も要らない（純関数のまま）", () => {
    for (const spec of BUILTIN) {
      expect(spec.externalFiles).toBeUndefined();
      expect(spec.analyze).toBeUndefined();
    }
  });
});

describe("denoise（マイクのノイズ除去）", () => {
  test("既定は highpass=80 + afftdn（nr=12 / nf=-50 / 白色雑音）", () => {
    expect(apply("denoise")).toEqual(["highpass=f=80", "afftdn=nr=12:nf=-50:nt=w"]);
  });

  test("実測で 9.4dB 下がった設定がそのまま書ける（amount 10 / floor -50 / highpass 80）", () => {
    expect(apply("denoise", { amount: 10, floor: -50, highpass: 80 })).toEqual([
      "highpass=f=80",
      "afftdn=nr=10:nf=-50:nt=w",
    ]);
  });

  test("highpass=0 は highpass を足さない（afftdn だけ掛かる）", () => {
    expect(apply("denoise", { highpass: 0 })).toEqual(["afftdn=nr=12:nf=-50:nt=w"]);
  });

  test("小数も指数表記にならない", () => {
    expect(apply("denoise", { amount: 0.01, floor: -79.5, highpass: 62.5 })).toEqual([
      "highpass=f=62.5",
      "afftdn=nr=0.01:nf=-79.5:nt=w",
    ]);
  });

  test("範囲は ffmpeg の afftdn がそのまま受け付ける範囲", () => {
    // nr: 0.01 .. 97 / nf: -80 .. -20
    expect(() => apply("denoise", { amount: 0 })).toThrow(/denoise': amount must be >= 0.01/);
    expect(() => apply("denoise", { amount: 98 })).toThrow(/denoise': amount must be <= 97/);
    expect(() => apply("denoise", { floor: -81 })).toThrow(/denoise': floor must be >= -80/);
    expect(() => apply("denoise", { floor: -19 })).toThrow(/denoise': floor must be <= -20/);
    expect(() => apply("denoise", { highpass: 400 })).toThrow(/denoise': highpass must be <= 300/);
    expect(() => apply("denoise", { highpass: -1 })).toThrow(/denoise': highpass must be >= 0/);
    expect(codeOf(() => apply("denoise", { amount: 0 }))).toBe("E_USAGE");
    expect(() => apply("denoise", { amount: "12" })).toThrow(/denoise': amount must be a number/);
  });
});

describe("eq（トーン調整）", () => {
  test("何も指定しなければフィルタを足さない（color と同じ規則）", () => {
    expect(apply("eq")).toEqual([]);
  });

  test("highpass / lowpass はそれぞれ単独で掛かる", () => {
    expect(apply("eq", { highpass: 120 })).toEqual(["highpass=f=120"]);
    expect(apply("eq", { lowpass: 12000 })).toEqual(["lowpass=f=12000"]);
    expect(apply("eq", { highpass: 100, lowpass: 8000 })).toEqual(["highpass=f=100", "lowpass=f=8000"]);
  });

  test("0 は無効（highpass=0 / lowpass=0 はフィルタを足さない）", () => {
    expect(apply("eq", { highpass: 0 })).toEqual([]);
  });

  test("ピーキング EQ は f / t=q / w / g の順（既定の Q は 1）", () => {
    expect(apply("eq", { frequency: 3000, gain: 3 })).toEqual(["equalizer=f=3000:t=q:w=1:g=3"]);
    expect(apply("eq", { frequency: 200, gain: -3, width: 2.5 })).toEqual(["equalizer=f=200:t=q:w=2.5:g=-3"]);
  });

  test("並びは highpass → lowpass → equalizer", () => {
    expect(apply("eq", { highpass: 80, lowpass: 15000, frequency: 3000, gain: 2 })).toEqual([
      "highpass=f=80",
      "lowpass=f=15000",
      "equalizer=f=3000:t=q:w=1:g=2",
    ]);
  });

  test("frequency と gain は対。片方だけは黙って無視せず E_USAGE", () => {
    expect(() => apply("eq", { gain: 3 })).toThrow(/eq': frequency is required when gain is set/);
    expect(() => apply("eq", { frequency: 3000 })).toThrow(/eq': gain is required when frequency is set/);
    expect(codeOf(() => apply("eq", { gain: 3 }))).toBe("E_USAGE");
    expect(codeOf(() => apply("eq", { frequency: 3000 }))).toBe("E_USAGE");
  });

  test("gain=0 でも対が揃っていればフィルタを出す（指定されたものは出す）", () => {
    expect(apply("eq", { frequency: 1000, gain: 0 })).toEqual(["equalizer=f=1000:t=q:w=1:g=0"]);
  });

  test("範囲外は E_USAGE", () => {
    expect(() => apply("eq", { highpass: 2001 })).toThrow(/eq': highpass must be <= 2000/);
    expect(() => apply("eq", { lowpass: 900 })).toThrow(/eq': lowpass must be >= 1000/);
    expect(() => apply("eq", { lowpass: 20001 })).toThrow(/eq': lowpass must be <= 20000/);
    expect(() => apply("eq", { frequency: 19, gain: 1 })).toThrow(/eq': frequency must be >= 20/);
    expect(() => apply("eq", { frequency: 1000, gain: 31 })).toThrow(/eq': gain must be <= 30/);
    expect(() => apply("eq", { frequency: 1000, gain: -31 })).toThrow(/eq': gain must be >= -30/);
    expect(() => apply("eq", { frequency: 1000, gain: 1, width: 0 })).toThrow(/eq': width must be >= 0.1/);
    expect(() => apply("eq", { frequency: 1000, gain: 1, width: 11 })).toThrow(/eq': width must be <= 10/);
  });
});

describe("compress（ダイナミクス圧縮）", () => {
  test("既定は threshold -18dB / ratio 3 / attack 20ms / release 250ms / makeup 0dB", () => {
    // threshold / makeup は dB → 線形振幅（10^(dB/20)）
    expect(apply("compress")).toEqual(["acompressor=threshold=0.125893:ratio=3:attack=20:release=250:makeup=1"]);
  });

  test("dB は線形振幅に直して渡す", () => {
    expect(apply("compress", { threshold: -20, makeup: 6 })).toEqual([
      "acompressor=threshold=0.1:ratio=3:attack=20:release=250:makeup=1.995262",
    ]);
    expect(apply("compress", { threshold: 0, makeup: 0 })).toEqual([
      "acompressor=threshold=1:ratio=3:attack=20:release=250:makeup=1",
    ]);
  });

  test("ratio / attack / release はそのままの単位で渡す", () => {
    expect(apply("compress", { ratio: 6, attack: 5, release: 120 })).toEqual([
      "acompressor=threshold=0.125893:ratio=6:attack=5:release=120:makeup=1",
    ]);
  });

  test("宣言した範囲の両端が、ffmpeg の acompressor が受け付ける範囲に収まっている", () => {
    // threshold: 0.000976563 .. 1 / makeup: 1 .. 64（範囲外は ffmpeg に黙って拒否されるので、
    // 宣言側の min/max がそのまま収まるように決めてある = 丸めが要らない）
    const lowest = Number(/threshold=([\d.]+)/.exec(apply("compress", { threshold: -60 })[0] ?? "")?.[1]);
    expect(lowest).toBeGreaterThanOrEqual(0.000976563);
    expect(lowest).toBeLessThanOrEqual(1);
    const highest = Number(/makeup=([\d.]+)/.exec(apply("compress", { makeup: 36 })[0] ?? "")?.[1]);
    expect(highest).toBeGreaterThanOrEqual(1);
    expect(highest).toBeLessThanOrEqual(64);
  });

  test("範囲外は E_USAGE", () => {
    expect(() => apply("compress", { threshold: -61 })).toThrow(/compress': threshold must be >= -60/);
    expect(() => apply("compress", { threshold: 1 })).toThrow(/compress': threshold must be <= 0/);
    expect(() => apply("compress", { ratio: 0.5 })).toThrow(/compress': ratio must be >= 1/);
    expect(() => apply("compress", { ratio: 21 })).toThrow(/compress': ratio must be <= 20/);
    expect(() => apply("compress", { attack: 0 })).toThrow(/compress': attack must be >= 0.01/);
    expect(() => apply("compress", { release: 9001 })).toThrow(/compress': release must be <= 9000/);
    expect(() => apply("compress", { makeup: -1 })).toThrow(/compress': makeup must be >= 0/);
    expect(() => apply("compress", { makeup: 37 })).toThrow(/compress': makeup must be <= 36/);
    expect(codeOf(() => apply("compress", { ratio: 21 }))).toBe("E_USAGE");
  });
});

describe("組み合わせ", () => {
  test("effects[] は配列順に展開される（ノイズ除去 → トーン → 圧縮）", () => {
    expect(
      buildEffectFilters(
        "audio",
        [
          { type: "denoise", params: { amount: 10 } },
          { type: "eq", params: { frequency: 3000, gain: 3 } },
          { type: "compress", params: { threshold: -20, ratio: 4, makeup: 3 } },
        ],
        ctx,
      ),
    ).toEqual([
      "highpass=f=80",
      "afftdn=nr=10:nf=-50:nt=w",
      "equalizer=f=3000:t=q:w=1:g=3",
      "acompressor=threshold=0.1:ratio=4:attack=20:release=250:makeup=1.412538",
    ]);
  });

  test("同じ効果を 2 度掛けられる（build は文脈を持たない純関数）", () => {
    expect(
      buildEffectFilters(
        "audio",
        [
          { type: "eq", params: { frequency: 200, gain: -3 } },
          { type: "eq", params: { frequency: 3000, gain: 3 } },
        ],
        ctx,
      ),
    ).toEqual(["equalizer=f=200:t=q:w=1:g=-3", "equalizer=f=3000:t=q:w=1:g=3"]);
  });

  test("効果が無いクリップのフィルタは 1 つも増えない（既存の出力は変わらない）", () => {
    expect(buildEffectFilters("audio", undefined, ctx)).toEqual([]);
    expect(buildEffectFilters("audio", [], ctx)).toEqual([]);
  });
});
