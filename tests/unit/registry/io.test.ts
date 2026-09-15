/**
 * 入出力レジストリ（docs/14、計画 P3-1）。
 *
 *   - 組み込みの取り込み分岐（text / subtitle / media）がレジストリ経由になっている
 *   - 拡張子で importer が引け、名乗り出るものが無ければ既定（ffprobe）に落ちる
 *   - プラグインが importer / exporter を足せる
 *   - I/O はホストが渡す `read()` / `probe()` に限られる（任意のパスは読めない）
 */
import { describe, expect, test } from "bun:test";
import { exporterNames, registerExporter, resolvePresets } from "../../../src/ffmpeg/presets.ts";
import {
  DEFAULT_IMPORTER,
  defineImporter,
  type ImporterContext,
  importerFor,
  importers,
  registerImporter,
} from "../../../src/registry/io.ts";

const ctx = (over: Partial<ImporterContext> = {}): ImporterContext => ({
  path: "/tmp/x.txt",
  extension: "txt",
  fps: { num: 30, den: 1 },
  toFrames: (s) => Math.round(s * 30),
  read: async () => "line1\nline2\n",
  probe: async () => ({
    summary: { type: "video", duration_s: 5, container: { format: "mov,mp4", bit_rate: 1000 } },
    raw: {},
  }),
  ...over,
});

describe("組み込み importer", () => {
  test("text / subtitle / media が登録されている", () => {
    expect(importers.names()).toEqual(expect.arrayContaining(["text", "subtitle", "media"]));
    for (const name of ["text", "subtitle", "media"]) {
      expect(importers.entry(name)?.source).toBe("builtin");
    }
  });

  test("拡張子で引ける", () => {
    expect(importerFor("txt")?.name).toBe("text");
    expect(importerFor("MD")?.name).toBe("text");
    expect(importerFor("srt")?.name).toBe("subtitle");
    expect(importerFor("ass")?.name).toBe("subtitle");
  });

  test("名乗り出る importer が無ければ null（呼び出し側が既定に落とす）", () => {
    expect(importerFor("mp4")).toBeNull();
    expect(importers.has(DEFAULT_IMPORTER)).toBe(true);
  });

  test("text は行数と冒頭を拾う（従来の import と同じ形）", async () => {
    const asset = await importers.require("text").build(ctx());
    expect(asset).toEqual({
      type: "text",
      duration_s: null,
      duration_f: null,
      text_preview: "line1\nline2\n",
      line_count: 3,
    });
  });

  test("subtitle は拡張子を format に入れる", async () => {
    const asset = await importers.require("subtitle").build(ctx({ extension: "vtt" }));
    expect(asset).toEqual({ type: "subtitle", format: "vtt" });
  });

  test("media は probe の結果から duration_f を算出する", async () => {
    const asset = await importers.require("media").build(ctx());
    expect(asset.type).toBe("video");
    expect(asset.duration_f).toBe(150);
    expect(asset.container).toEqual({ format: "mov,mp4", bit_rate: 1000 });
  });

  test("bit_rate が無ければ container に入れない（従来どおり）", async () => {
    const asset = await importers.require("media").build(
      ctx({
        probe: async () => ({
          summary: { type: "video", duration_s: null, container: { format: "x", bit_rate: null } },
          raw: {},
        }),
      }),
    );
    expect(asset.container).toEqual({ format: "x" });
    expect(asset.duration_f).toBeNull();
  });
});

describe("プラグインからの登録", () => {
  test("importer を足すと拡張子で引けるようになる", () => {
    registerImporter(
      defineImporter({
        name: "test-fake",
        summary: "",
        extensions: ["fake"],
        build: async () => ({ type: "text", duration_s: null, duration_f: null }),
      }),
      "plugin",
    );
    expect(importerFor("fake")?.name).toBe("test-fake");
    expect(importers.entry("test-fake")?.source).toBe("plugin");
  });

  test("exporter（出力プリセット）を足すと render presets に出る", () => {
    const before = exporterNames().length;
    registerExporter("test-exporter", {
      format: "mp4",
      ext: ".mp4",
      note: "from a plugin",
      video: { codec: "libx264", crf: 20 },
      audio: { codec: "aac", bitrate: "128k" },
    } as never);
    expect(exporterNames()).toContain("test-exporter");
    expect(exporterNames().length).toBe(before + 1);
    const resolved = resolvePresets(null);
    expect(resolved["test-exporter"]?.source).toBe("plugin");
  });

  test("プラグインのプリセットを base にして派生できる", () => {
    const resolved = resolvePresets({
      render_presets: { "my-variant": { base: "test-exporter", note: "derived" } },
    } as never);
    expect(resolved["my-variant"]?.note).toBe("derived");
    expect(resolved["my-variant"]?.source).toBe("project");
  });

  test("project 側から base にして派生できる（登録済みを継承元にできる）", () => {
    const derived = resolvePresets({
      render_presets: { "my-variant": { base: "test-exporter", note: "derived" } },
    } as never);
    expect(derived["my-variant"]?.note).toBe("derived");
    expect(derived["my-variant"]?.source).toBe("project");
  });

  test("base 省略時の既定 base は youtube-1080p 固定なので、その名前自身は上書きできない（docs/13 D-20）", () => {
    expect(() => resolvePresets({ render_presets: { "youtube-1080p": { note: "mine" } } } as never)).toThrow(
      /inherits from itself/,
    );
  });
});
