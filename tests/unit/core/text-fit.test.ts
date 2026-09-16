/**
 * テロップの幅自動フィット（`src/core/text-fit.ts`）。
 * 外部依存ゼロの純関数なので、期待値を数値で固定しておく。
 */
import { expect, test } from "bun:test";
import { MontashError } from "../../../src/cli/errors.ts";
import {
  charEm,
  defaultFitBounds,
  estimateLineEm,
  FIT_DEFAULTS,
  fitFontSize,
  isFullWidth,
  parseFitWidth,
} from "../../../src/core/text-fit.ts";

// ---------------------------------------------------------------------------
// 字幅の概算
// ---------------------------------------------------------------------------

test("全角は 1em、半角は字ごとの advance で数える", () => {
  expect(charEm("あ")).toBe(1);
  expect(charEm("漢")).toBe(1);
  expect(charEm("ー")).toBe(1);
  expect(charEm("、")).toBe(1);
  expect(charEm("Ａ")).toBe(1); // 全角ラテン
  expect(charEm("　")).toBe(1); // 全角スペース
  expect(charEm("i")).toBeLessThan(charEm("W"));
  expect(charEm("1")).toBe(charEm("9"));
  expect(charEm(" ")).toBeLessThan(0.3);
});

test("isFullWidth は CJK・全角記号・絵文字を全角として扱う", () => {
  for (const ch of ["あ", "ア", "漢", "。", "「", "＆", "🎉"]) expect(isFullWidth(ch)).toBe(true);
  for (const ch of ["a", "Z", "0", ".", " ", "ｱ"]) expect(isFullWidth(ch)).toBe(false);
});

test("estimateLineEm は 1 行の em 幅を足し合わせる（サロゲートペアは 1 文字）", () => {
  expect(estimateLineEm("")).toBe(0);
  expect(estimateLineEm("あいうえお")).toBe(5);
  expect(estimateLineEm("🎉🎉")).toBe(2);
  // 半角混じりは全角より狭い
  expect(estimateLineEm("abcde")).toBeLessThan(estimateLineEm("あいうえお"));
});

// ---------------------------------------------------------------------------
// 幅指定のパース
// ---------------------------------------------------------------------------

test("--fit-width は % でも px でも受ける", () => {
  expect(parseFitWidth("90%", 1920)).toBe(1728);
  expect(parseFitWidth("100%", 1280)).toBe(1280);
  expect(parseFitWidth("1152", 1920)).toBe(1152);
  expect(parseFitWidth(" 1152px ", 1920)).toBe(1152);
});

test("--fit-width の 0% 以下・100% 超・書式違いは E_USAGE", () => {
  for (const bad of ["0%", "120%", "-10%", "0", "abc", ""]) {
    expect(() => parseFitWidth(bad, 1920)).toThrow(MontashError);
  }
});

// ---------------------------------------------------------------------------
// サイズの決定
// ---------------------------------------------------------------------------

test("収まる最大サイズを切り下げて返す", () => {
  // 10 全角 = 10em。1000px に収めるなら 100px
  const fit = fitFontSize({ text: "あいうえおかきくけこ", maxWidth: 1000, maxSize: 200, minSize: 10 });
  expect(fit.size).toBe(100);
  expect(fit.em).toBe(10);
  expect(fit.width).toBe(1000);
  expect(fit.clamped).toBeNull();
});

test("短い一言は上限で頭打ちになる（clamped: max）", () => {
  const fit = fitFontSize({ text: "うわ", maxWidth: 1000, maxSize: 108, minSize: 40 });
  expect(fit.size).toBe(108);
  expect(fit.clamped).toBe("max");
});

test("長い一言は下限で止まり clamped: min（黙って溢れさせない）", () => {
  const fit = fitFontSize({ text: "あ".repeat(60), maxWidth: 1000, maxSize: 108, minSize: 40 });
  expect(fit.size).toBe(40);
  expect(fit.clamped).toBe("min");
  expect(fit.width).toBeGreaterThan(1000);
});

test("いちばん幅の要る行が全体のサイズを決める", () => {
  const fit = fitFontSize({ text: "あ\nあいうえお\nあい", maxWidth: 500, maxSize: 200, minSize: 10 });
  expect(fit.line).toBe("あいうえお");
  expect(fit.size).toBe(100);
});

test("縁取りの太さは左右に 1 本ずつ出るので幅から差し引く", () => {
  const plain = fitFontSize({ text: "あいうえおかきくけこ", maxWidth: 1000, maxSize: 200, minSize: 10 });
  const outlined = fitFontSize({
    text: "あいうえおかきくけこ",
    maxWidth: 1000,
    maxSize: 200,
    minSize: 10,
    outlineWidth: 10,
  });
  expect(outlined.size).toBeLessThan(plain.size);
  expect(outlined.width).toBeLessThanOrEqual(1000);
});

test("sizeScale は libass の縮尺（Fontsize 1px あたりの em 数）として掛かる", () => {
  const fit = fitFontSize({
    text: "あいうえおかきくけこ",
    maxWidth: 1000,
    maxSize: 500,
    minSize: 10,
    sizeScale: 0.8,
  });
  // 10em × 0.8 = 8em/px なので 125px まで入る
  expect(fit.size).toBe(125);
  expect(fit.em).toBeCloseTo(8, 6);
});

test("measure で実測値を差し込める（em の出どころを差し替えるだけ）", () => {
  const fit = fitFontSize({
    text: "あいうえおかきくけこ",
    maxWidth: 1000,
    maxSize: 500,
    minSize: 10,
    measure: () => 5,
  });
  expect(fit.size).toBe(200);
});

test("空文字は幅の制約が無いので上限をそのまま使う", () => {
  const fit = fitFontSize({ text: "", maxWidth: 1000, maxSize: 96, minSize: 10 });
  expect(fit.size).toBe(96);
  expect(fit.em).toBe(0);
  expect(fit.clamped).toBeNull();
});

test("minSize が maxSize を超えていても maxSize を超える値は返さない", () => {
  const fit = fitFontSize({ text: "あ", maxWidth: 10, maxSize: 50, minSize: 200 });
  expect(fit.size).toBe(50);
});

test("既定の上限・下限は解像度の高さ基準。--size があればそれが上限になる", () => {
  expect(defaultFitBounds(1080)).toEqual({ maxSize: 1080 * FIT_DEFAULTS.maxSizeRatio, minSize: 43 });
  expect(defaultFitBounds(720)).toEqual({ maxSize: 72, minSize: 29 });
  expect(defaultFitBounds(1080, 60)).toEqual({ maxSize: 60, minSize: 43 });
  // --size が既定の下限より小さいときは下限も下がる（矛盾した組を作らない）
  expect(defaultFitBounds(1080, 20)).toEqual({ maxSize: 20, minSize: 20 });
});
