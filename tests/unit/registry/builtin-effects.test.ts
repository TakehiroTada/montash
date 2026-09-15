/**
 * 組み込みエフェクトの拡充（計画 P1-3。F-FX-3 回転・反転 / F-FX-4 LUT / F-FX-7 ぼかし・モザイク）。
 *
 * 要点:
 *   1. **組み込みも外部プラグインとまったく同じ契約**（`defineEffect` + 純関数の `build()`）
 *   2. `build()` は既定値のときも指定時も**決まったフィルタ文字列**を返す（`--dry-run` で読める形）
 *   3. 範囲外・choices 外は `E_USAGE`
 *   4. 各エフェクトの `requires` が `doctor` の検査対象（`registeredRequirements()`）に載る
 *
 * `color` の出力は P0-3 から 1 文字も変えない（`effects.test.ts` が見張っている）。
 */
import { describe, expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import {
  blurEffect,
  buildEffectFilters,
  type EffectBuildContext,
  type EffectSpec,
  flipEffect,
  lut3dEffect,
  mosaicEffect,
  resolveEffectParams,
  rotateEffect,
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
function apply(type: string, params: Record<string, unknown> = {}, c: EffectBuildContext = ctx): string[] {
  return buildEffectFilters("video", [{ type, params }], c);
}

const BUILTIN: readonly EffectSpec[] = [blurEffect, mosaicEffect, lut3dEffect, flipEffect, rotateEffect];

describe("登録", () => {
  test("追加した組み込みはすべて builtin として登録されている", () => {
    for (const spec of BUILTIN) {
      expect(videoEffects.has(spec.name)).toBe(true);
      expect(videoEffects.entry(spec.name)?.source).toBe("builtin");
      expect(videoEffects.entry(spec.name)?.value).toBe(spec);
    }
    // 組み込みはこの 6 種（音声エフェクトは P1-3 の範囲外なので足していない）。
    // レジストリはプロセス内で 1 つなので、他のテストが登録したプラグイン由来は除いて数える。
    const builtinNames = videoEffects.names().filter((n) => videoEffects.entry(n)?.source === "builtin");
    expect(builtinNames).toEqual(["blur", "color", "flip", "lut3d", "mosaic", "rotate"]);
  });

  test("requires が doctor の検査対象（registeredRequirements）に載る", () => {
    const ids = [...registeredRequirements().keys()];
    for (const spec of BUILTIN) expect(ids).toContain(`effect:video:${spec.name}`);
    // 宣言した ffmpeg フィルタがそのまま検査対象の中身になっている
    expect(registeredRequirements().get("effect:video:blur")?.filters).toEqual(["gblur"]);
    expect(registeredRequirements().get("effect:video:mosaic")?.filters).toEqual(["pixelize"]);
    expect(registeredRequirements().get("effect:video:lut3d")?.filters).toEqual(["lut3d"]);
    expect(registeredRequirements().get("effect:video:flip")?.filters).toEqual(["hflip", "vflip"]);
    expect(registeredRequirements().get("effect:video:rotate")?.filters).toEqual(["transpose", "hflip", "vflip"]);
  });

  test("すべて映像向けで、要求フィルタを宣言している", () => {
    for (const spec of BUILTIN) {
      expect(spec.target).toBe("video");
      expect(spec.requires?.length).toBeGreaterThan(0);
    }
  });
});

describe("blur（F-FX-7）", () => {
  test("既定は sigma=4", () => {
    expect(apply("blur")).toEqual(["gblur=sigma=4"]);
  });

  test("sigma を指定する", () => {
    expect(apply("blur", { sigma: 12 })).toEqual(["gblur=sigma=12"]);
    expect(apply("blur", { sigma: 0.5 })).toEqual(["gblur=sigma=0.5"]);
  });

  test("steps は 1 以外のときだけ出す", () => {
    expect(apply("blur", { sigma: 8, steps: 1 })).toEqual(["gblur=sigma=8"]);
    expect(apply("blur", { sigma: 8, steps: 3 })).toEqual(["gblur=sigma=8:steps=3"]);
  });

  test("sigma=0 はフィルタを足さない（color が空のときと同じ扱い）", () => {
    expect(apply("blur", { sigma: 0 })).toEqual([]);
  });

  test("範囲外は E_USAGE", () => {
    expect(() => apply("blur", { sigma: 129 })).toThrow(/blur': sigma must be <= 128/);
    expect(() => apply("blur", { sigma: -1 })).toThrow(/blur': sigma must be >= 0/);
    expect(() => apply("blur", { steps: 7 })).toThrow(/blur': steps must be <= 6/);
    expect(() => apply("blur", { sigma: "4" })).toThrow(/blur': sigma must be a number/);
  });
});

describe("mosaic（F-FX-7）", () => {
  test("既定は 16px の正方ブロック（avg）", () => {
    expect(apply("mosaic")).toEqual(["pixelize=w=16:h=16:mode=avg"]);
  });

  test("ブロックサイズと縮約方法を指定する", () => {
    expect(apply("mosaic", { size: 48 })).toEqual(["pixelize=w=48:h=48:mode=avg"]);
    expect(apply("mosaic", { size: 8, mode: "max" })).toEqual(["pixelize=w=8:h=8:mode=max"]);
  });

  test("ブロックサイズは整数に丸める（pixelize は整数しか受けない）", () => {
    expect(apply("mosaic", { size: 12.4 })).toEqual(["pixelize=w=12:h=12:mode=avg"]);
  });

  test("範囲外・choices 外は E_USAGE", () => {
    expect(() => apply("mosaic", { size: 1 })).toThrow(/mosaic': size must be >= 2/);
    expect(() => apply("mosaic", { size: 999 })).toThrow(/mosaic': size must be <= 256/);
    expect(() => apply("mosaic", { mode: "median" })).toThrow(/mosaic': mode must be one of: avg, min, max/);
  });
});

describe("lut3d（F-FX-4）", () => {
  test("file は必須", () => {
    expect(() => apply("lut3d")).toThrow(/lut3d': file is required/);
    try {
      apply("lut3d");
    } catch (e) {
      expect((e as MontashError).code).toBe("E_USAGE");
    }
  });

  test("パスは常に '' で括る", () => {
    expect(apply("lut3d", { file: "/luts/film.cube" })).toEqual(["lut3d=file='/luts/film.cube'"]);
  });

  test("filtergraph のメタ文字をエスケープする（Windows のドライブレターやクォート）", () => {
    expect(apply("lut3d", { file: "C:\\luts\\a'b.cube" })).toEqual(["lut3d=file='C\\:\\\\luts\\\\a\\'b.cube'"]);
  });

  test("interp は指定したときだけ出す", () => {
    expect(apply("lut3d", { file: "a.cube", interp: "tetrahedral" })).toEqual([
      "lut3d=file='a.cube':interp=tetrahedral",
    ]);
    expect(() => apply("lut3d", { file: "a.cube", interp: "bicubic" })).toThrow(/lut3d': interp must be one of/);
  });

  test("空のパスは E_USAGE（ファイルの存在確認はしない = build は純関数）", () => {
    expect(() => apply("lut3d", { file: "   " })).toThrow(/lut3d': file must not be empty/);
    // 存在しないパスはここでは通る（レンダー時に ffmpeg が失敗する）
    expect(apply("lut3d", { file: "/nope/missing.cube" })).toEqual(["lut3d=file='/nope/missing.cube'"]);
  });
});

describe("flip（F-FX-3）", () => {
  test("既定は水平反転", () => {
    expect(apply("flip")).toEqual(["hflip"]);
  });

  test("direction ごとのフィルタ", () => {
    expect(apply("flip", { direction: "horizontal" })).toEqual(["hflip"]);
    expect(apply("flip", { direction: "vertical" })).toEqual(["vflip"]);
    expect(apply("flip", { direction: "both" })).toEqual(["hflip", "vflip"]);
  });

  test("choices 外は E_USAGE", () => {
    expect(() => apply("flip", { direction: "diagonal" })).toThrow(
      /flip': direction must be one of: horizontal, vertical, both/,
    );
  });
});

describe("rotate（F-FX-3）", () => {
  test("angle は必須で 90 / 180 / 270 のみ", () => {
    expect(() => apply("rotate")).toThrow(/rotate': angle is required/);
    expect(() => apply("rotate", { angle: "45" })).toThrow(/rotate': angle must be one of: 90, 180, 270/);
    // 数値ではなく文字列で受ける（choices は文字列でのみ検査できる）
    expect(() => apply("rotate", { angle: 90 })).toThrow(/rotate': angle must be a string/);
  });

  test("180 は大きさが変わらないので hflip,vflip だけ", () => {
    expect(apply("rotate", { angle: "180" })).toEqual(["hflip", "vflip"]);
    // fit を付けても 180 では効かない
    expect(apply("rotate", { angle: "180", fit: true })).toEqual(["hflip", "vflip"]);
  });

  test("90 / 270 は既定でタイムライン解像度へ letterbox して戻す", () => {
    expect(apply("rotate", { angle: "90" })).toEqual([
      "transpose=1",
      "scale=640:360:force_original_aspect_ratio=decrease:flags=bicubic",
      "pad=640:360:(ow-iw)/2:(oh-ih)/2",
      "setsar=1",
    ]);
    expect(apply("rotate", { angle: "270" })).toEqual([
      "transpose=2",
      "scale=640:360:force_original_aspect_ratio=decrease:flags=bicubic",
      "pad=640:360:(ow-iw)/2:(oh-ih)/2",
      "setsar=1",
    ]);
  });

  test("戻す先は ctx.resolution（縦のタイムラインでもそのまま追随する）", () => {
    const vertical = { ...ctx, resolution: { width: 1080, height: 1920 } };
    expect(apply("rotate", { angle: "90" }, vertical)).toEqual([
      "transpose=1",
      "scale=1080:1920:force_original_aspect_ratio=decrease:flags=bicubic",
      "pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
      "setsar=1",
    ]);
  });

  test("fit: false は回転だけ（overlay の native クリップ用。大きさが入れ替わる）", () => {
    expect(apply("rotate", { angle: "90", fit: false })).toEqual(["transpose=1"]);
    expect(apply("rotate", { angle: "270", fit: false })).toEqual(["transpose=2"]);
  });
});

describe("契約", () => {
  test("build() は純関数（同じ入力なら何度呼んでも同じ。params を書き換えない）", () => {
    const REQUIRED: Record<string, Record<string, unknown>> = { lut3d: { file: "a.cube" }, rotate: { angle: "90" } };
    for (const spec of BUILTIN) {
      const raw = REQUIRED[spec.name] ?? {};
      const params = Object.freeze(resolveEffectParams(spec, raw));
      expect(spec.build(params, ctx)).toEqual(spec.build(params, ctx));
    }
  });

  test("複数の組み込みを並べると配列順に展開される", () => {
    expect(
      buildEffectFilters(
        "video",
        [
          { type: "color", params: { saturation: 1.2 } },
          { type: "blur", params: { sigma: 6 } },
          { type: "flip", params: { direction: "vertical" } },
        ],
        ctx,
      ),
    ).toEqual(["eq=saturation=1.2", "gblur=sigma=6", "vflip"]);
  });
});
