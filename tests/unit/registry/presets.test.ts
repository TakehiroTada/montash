/**
 * `text_presets` / `render_presets` をレジストリ共通基盤に載せ替えたあとの外向き挙動（docs/13 D-16）。
 * `montash text presets` / `montash render presets` が出す `source` ラベルと並びを固定する。
 */
import { describe, expect, test } from "bun:test";
import { createProject } from "../../../src/core/project.ts";
import type { Project } from "../../../src/core/schema.ts";
import { BUILTIN_TEXT_PRESETS, requireTextPreset, resolveTextPresets } from "../../../src/core/text-presets.ts";
import { BUILTIN_PRESETS, resolvePresets } from "../../../src/ffmpeg/presets.ts";

const project = (): Project =>
  createProject({ name: "reg", fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 } });

describe("text_presets", () => {
  test("組み込みだけなら名前順・source は builtin", () => {
    const entries = resolveTextPresets(project());
    expect(entries.map((e) => e.name)).toEqual([...Object.keys(BUILTIN_TEXT_PRESETS)].sort());
    expect(new Set(entries.map((e) => e.source))).toEqual(new Set(["builtin"]));
  });

  test("上書きは overridden、追加は project、マージはキー単位の後勝ち", () => {
    const p = project();
    p.text_presets = { "title-center": { size: 120 }, mine: { size: 24 } };
    const entries = resolveTextPresets(p);
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect(byName.get("title-center")?.source).toBe("overridden");
    expect(byName.get("title-center")?.preset.size).toBe(120);
    // 指定していないキーは組み込みのまま
    expect(byName.get("title-center")?.preset.position).toBe("center");
    expect(byName.get("mine")?.source).toBe("project");
    expect(byName.get("caption-bottom")?.source).toBe("builtin");
    // 名前順（追加した mine も並びに入る）
    expect(entries.map((e) => e.name)).toEqual([...entries.map((e) => e.name)].sort());
  });

  test("組み込みを書き換えない（返すのはコピー）", () => {
    const p = project();
    const preset = requireTextPreset(p, "title-center");
    preset.size = 1;
    expect(requireTextPreset(p, "title-center").size).toBe(96);
  });

  test("未知名は E_PRESET_NOT_FOUND（hint に一覧）", () => {
    try {
      requireTextPreset(project(), "nope");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { code: string; hint?: string; detail?: Record<string, unknown> };
      expect(err.code).toBe("E_PRESET_NOT_FOUND");
      expect(err.hint).toContain("caption-bottom, corner-tag, lower-third, title-center");
      expect(err.detail?.known_presets).toEqual([...Object.keys(BUILTIN_TEXT_PRESETS)].sort());
    }
  });
});

describe("render_presets", () => {
  test("組み込みは登録順のまま source: builtin、追加は末尾に project", () => {
    const p = project();
    p.render_presets = { mine: { base: "twitter", crf: 30 } };
    const table = resolvePresets(p);
    expect(Object.keys(table)).toEqual([...Object.keys(BUILTIN_PRESETS), "mine"]);
    expect(table["youtube-1080p"]?.source).toBe("builtin");
    expect(table.mine?.source).toBe("project");
    expect(table.mine?.base).toBe("twitter");
    expect(table.mine?.video?.crf).toBe(30);
    expect(table.mine?.resolution).toEqual({ width: 1280, height: 720 });
  });

  test("組み込みと同名の上書きは元の位置に残り source が project になる", () => {
    const p = project();
    p.render_presets = { "web-preview": { base: "twitter", crf: 30 } };
    const table = resolvePresets(p);
    // 並びは組み込みのまま（末尾に移動しない）
    expect(Object.keys(table)).toEqual([...Object.keys(BUILTIN_PRESETS)]);
    expect(table["web-preview"]?.source).toBe("project");
    expect(table["web-preview"]?.base).toBe("twitter");
    expect(table["web-preview"]?.video?.crf).toBe(30);
    // 組み込みの表そのものは汚れない
    expect(BUILTIN_PRESETS["web-preview"]?.video?.crf).toBe(28);
    expect(BUILTIN_PRESETS["web-preview"]?.source).toBeUndefined();
  });

  test("同名を自分の base にしたら循環（組み込みの上書きでも）", () => {
    const p = project();
    p.render_presets = { gif: { base: "gif", fps: 24 } };
    expect(() => resolvePresets(p)).toThrow(/base loop/);
  });

  test("未知キーは E_USAGE（許可キーの一覧つき）", () => {
    const p = project();
    p.render_presets = { bad: { base: "twitter", nope: 1 } };
    try {
      resolvePresets(p);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { code: string; message: string; hint?: string; detail?: Record<string, unknown> };
      expect(err.code).toBe("E_USAGE");
      expect(err.message).toContain("render preset 'bad' has unknown key(s): nope");
      expect(err.hint).toContain("Supported keys: base, format, ext");
      expect(err.detail?.preset).toBe("bad");
    }
  });

  test("未知の base は E_PRESET_NOT_FOUND、循環は E_USAGE", () => {
    const p = project();
    p.render_presets = { x: { base: "nope" } };
    expect(() => resolvePresets(p)).toThrow(/unknown render preset 'nope'/);
    p.render_presets = { a: { base: "b" }, b: { base: "a" } };
    expect(() => resolvePresets(p)).toThrow(/base loop/);
  });
});
