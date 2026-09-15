import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MontashError } from "../../../src/cli/errors.ts";
import {
  canonicalJson,
  createProject,
  fpsLabel,
  framesToSeconds,
  framesToTc,
  GITIGNORE_CONTENT,
  hashProject,
  initProjectDir,
  loadProject,
  parseFps,
  parseProject,
  parseResolution,
  projectPaths,
  saveProject,
  secondsToFrames,
} from "../../../src/core/project.ts";

const tmp = (prefix = "montash-core-") => mkdtempSync(join(tmpdir(), prefix));
const fps2997 = { num: 30000, den: 1001 };

describe("fps helpers (re-exported from core/time)", () => {
  test("presets and fractions", () => {
    expect(parseFps("29.97")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps("23.976")).toEqual({ num: 24000, den: 1001 });
    expect(parseFps("59.94")).toEqual({ num: 60000, den: 1001 });
    expect(parseFps("30")).toEqual({ num: 30, den: 1 });
    expect(parseFps(24)).toEqual({ num: 24, den: 1 });
    expect(parseFps("30000/1001")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps("60000/2002")).toEqual({ num: 30000, den: 1001 }); // 既約化
    expect(parseFps("48")).toEqual({ num: 48, den: 1 });
  });
  test("rejects garbage", () => {
    for (const bad of ["abc", "0", "30/0", "-30", "24.5.1", ""]) {
      expect(() => parseFps(bad)).toThrow(MontashError);
    }
  });
  test("labels, seconds, timecode", () => {
    expect(fpsLabel(fps2997)).toBe("29.97");
    expect(fpsLabel({ num: 30, den: 1 })).toBe("30");
    expect(fpsLabel({ num: 48, den: 1 })).toBe("48");
    expect(framesToSeconds(30000, fps2997)).toBeCloseTo(1001, 10);
    expect(secondsToFrames(5, fps2997)).toBe(150);
    expect(secondsToFrames(5, { num: 24, den: 1 })).toBe(120);
    expect(framesToTc(0, fps2997)).toBe("00:00:00.000");
    expect(framesToTc(1335, fps2997)).toBe("00:00:44.545");
    expect(framesToTc(30 * 3600 + 30 * 61, { num: 30, den: 1 })).toBe("01:01:01.000");
  });
  test("resolution parsing requires even pixels", () => {
    expect(parseResolution("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseResolution("1080X1920")).toEqual({ width: 1080, height: 1920 });
    expect(() => parseResolution("1921x1080")).toThrow(MontashError);
    expect(() => parseResolution("1080p")).toThrow(MontashError);
  });
});

describe("createProject", () => {
  test("defaults: V1/A1, 5 s image duration, libass, schema v2", () => {
    const p = createProject({
      name: "vlog",
      fps: fps2997,
      resolution: { width: 1920, height: 1080 },
      now: new Date("2026-09-14T01:23:45.678Z"),
    });
    expect(p.schema_version).toBe(3);
    expect(p.name).toBe("vlog");
    expect(p.created_at).toBe("2026-09-14T01:23:45Z");
    expect(p.updated_at).toBe(p.created_at);
    expect(p.settings.fps).toEqual(fps2997);
    expect(p.settings.default_image_duration_f).toBe(150);
    expect(p.settings.text_engine).toBe("libass");
    expect(p.settings.sample_rate).toBe(48000);
    expect(p.settings.channels).toBe(2);
    expect(p.tracks.map((t) => [t.id, t.kind])).toEqual([
      ["V1", "video"],
      ["A1", "audio"],
    ]);
    expect(p.assets).toEqual({});
    expect(p.transitions).toEqual([]);
  });
  test("image duration follows fps; sample rate / channels override", () => {
    const p = createProject({
      name: "x",
      fps: { num: 24, den: 1 },
      resolution: { width: 1920, height: 1080 },
      sampleRate: 44100,
      channels: 1,
    });
    expect(p.settings.default_image_duration_f).toBe(120);
    expect(p.settings.sample_rate).toBe(44100);
    expect(p.settings.channels).toBe(1);
  });
});

describe("save / load round trip", () => {
  test("saveProject writes 2-space JSON atomically and updates updated_at", async () => {
    const dir = tmp();
    const p = createProject({
      name: "rt",
      fps: fps2997,
      resolution: { width: 1920, height: 1080 },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    await saveProject(dir, p, { now: new Date("2026-01-02T00:00:00Z") });
    expect(p.updated_at).toBe("2026-01-02T00:00:00Z");
    const text = readFileSync(join(dir, "project.json"), "utf8");
    expect(text.startsWith('{\n  "schema_version": 3,\n')).toBe(true);
    expect(text.endsWith("\n")).toBe(true);
    expect(existsSync(join(dir, "project.json.tmp"))).toBe(false);
    const loaded = await loadProject(dir);
    expect(loaded).toEqual(p);
    expect(hashProject(loaded)).toBe(hashProject(p));
  });
  test("loadProject: missing → E_PROJECT_NOT_FOUND, bad JSON → E_PROJECT_INVALID", async () => {
    const dir = tmp();
    await expect(loadProject(dir)).rejects.toMatchObject({ code: "E_PROJECT_NOT_FOUND" });
    writeFileSync(join(dir, "project.json"), "{ not json");
    await expect(loadProject(dir)).rejects.toMatchObject({ code: "E_PROJECT_INVALID" });
  });
  test("loadProject: schema violations carry zod issues in detail", async () => {
    const dir = tmp();
    const p = createProject({ name: "bad", fps: fps2997, resolution: { width: 1920, height: 1080 } });
    const broken = { ...p, settings: { ...p.settings, fps: { num: 29.97, den: 1 } } };
    writeFileSync(join(dir, "project.json"), JSON.stringify(broken));
    try {
      await loadProject(dir);
      throw new Error("should fail");
    } catch (e) {
      const err = e as MontashError;
      expect(err.code).toBe("E_PROJECT_INVALID");
      const issues = err.detail?.issues as Array<{ path: string }>;
      expect(issues.some((i) => i.path === "/settings/fps/num")).toBe(true);
    }
  });
  test("schema_version newer than supported → E_SCHEMA_TOO_NEW", () => {
    const p = createProject({ name: "new", fps: fps2997, resolution: { width: 1920, height: 1080 } });
    expect(() => parseProject({ ...p, schema_version: 99 })).toThrow(
      expect.objectContaining({ code: "E_SCHEMA_TOO_NEW" }),
    );
    expect(() => parseProject([])).toThrow(expect.objectContaining({ code: "E_PROJECT_INVALID" }));
  });
});

describe("hashProject", () => {
  test("is deterministic and independent of key order", () => {
    const p = createProject({
      name: "h",
      fps: fps2997,
      resolution: { width: 1920, height: 1080 },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    // すべてのオブジェクトのキー順を逆にしたコピー（配列順は保持）
    const reverseKeys = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reverseKeys);
      if (v && typeof v === "object")
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, x]) => [k, reverseKeys(x)]),
        );
      return v;
    };
    const reordered = reverseKeys(p) as typeof p;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(p));
    expect(hashProject(reordered)).toBe(hashProject(p));
    expect(hashProject(p)).toMatch(/^sha1:[0-9a-f]{40}$/);
  });
  test("changes when content changes; array order matters", () => {
    const p = createProject({
      name: "h",
      fps: fps2997,
      resolution: { width: 1920, height: 1080 },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const renamed = { ...p, name: "h2" };
    expect(hashProject(renamed)).not.toBe(hashProject(p));
    const swapped = { ...p, tracks: [p.tracks[1]!, p.tracks[0]!] };
    expect(hashProject(swapped)).not.toBe(hashProject(p));
  });
  test("canonicalJson sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [3, { z: 1, y: undefined }], c: undefined })).toBe('{"a":[3,{"z":1}],"b":1}');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("s")).toBe('"s"');
  });
});

describe("initProjectDir", () => {
  test("creates the documented layout and refuses to overwrite without force", async () => {
    const root = tmp();
    const dir = join(root, "proj");
    const p = createProject({ name: "proj", fps: fps2997, resolution: { width: 1920, height: 1080 } });
    const paths = await initProjectDir(dir, p);
    for (const d of [
      paths.projectFile,
      paths.idsFile,
      paths.gitignore,
      paths.assetsDir,
      paths.outDir,
      paths.historyDir,
      paths.cacheDir,
      paths.previewDir,
      paths.tmpDir,
      paths.logsDir,
    ]) {
      expect(existsSync(d)).toBe(true);
    }
    expect(readFileSync(paths.gitignore, "utf8")).toBe(GITIGNORE_CONTENT);
    expect(JSON.parse(readFileSync(paths.idsFile, "utf8"))).toEqual({ counters: { c: 1, t: 1, x: 1, s: 1, d: 1 } });
    await expect(initProjectDir(dir, p)).rejects.toMatchObject({ code: "E_PROJECT_EXISTS" });
  });
  test("force replaces project.json and resets .montash, keeps assets/ and a custom .gitignore", async () => {
    const dir = join(tmp(), "proj");
    const p1 = createProject({ name: "one", fps: fps2997, resolution: { width: 1920, height: 1080 } });
    const paths = await initProjectDir(dir, p1);
    writeFileSync(join(paths.assetsDir, "keep.txt"), "keep");
    writeFileSync(paths.gitignore, "custom\n");
    writeFileSync(paths.idsFile, JSON.stringify({ counters: { c: 42 } }));
    const p2 = createProject({ name: "two", fps: { num: 30, den: 1 }, resolution: { width: 1280, height: 720 } });
    await initProjectDir(dir, p2, { force: true });
    const loaded = await loadProject(dir);
    expect(loaded.name).toBe("two");
    expect(loaded.settings.fps).toEqual({ num: 30, den: 1 });
    expect(readFileSync(join(paths.assetsDir, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(paths.gitignore, "utf8")).toBe("custom\n");
    expect(JSON.parse(readFileSync(paths.idsFile, "utf8")).counters.c).toBe(1);
  });
  test("projectPaths resolves under the root", () => {
    const paths = projectPaths("/x/y");
    expect(paths.projectFile).toBe("/x/y/project.json");
    expect(paths.idsFile).toBe("/x/y/.montash/ids.json");
    expect(paths.historyDir).toBe("/x/y/.montash/history");
  });
});
