import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MontashError } from "../../../src/cli/errors.ts";
import {
  assertIdAvailable,
  collectNumberedIds,
  nextId,
  nextIds,
  readIds,
  rebuildIds,
  slugAssetId,
} from "../../../src/core/ids.ts";
import { createProject, initProjectDir, projectPaths, saveProject } from "../../../src/core/project.ts";
import type { Project } from "../../../src/core/schema.ts";

const fps = { num: 30, den: 1 };

async function freshProject(): Promise<{ dir: string; project: Project }> {
  const dir = join(mkdtempSync(join(tmpdir(), "montash-ids-")), "p");
  const project = createProject({ name: "p", fps, resolution: { width: 1920, height: 1080 } });
  await initProjectDir(dir, project);
  return { dir, project };
}

function withClips(project: Project): Project {
  project.assets.clip_a = { id: "clip_a", type: "video", path: "a.mp4", owned: false, tags: [], duration_f: 1000 };
  project.tracks[0]!.clips.push(
    {
      id: "c1",
      asset: "clip_a",
      start_f: 0,
      in_f: 0,
      out_f: 100,
      speed: 1,
      pitch_keep: false,
      loop: false,
      link: null,
      effects: [],
    },
    {
      id: "c7",
      asset: "clip_a",
      start_f: 100,
      in_f: 0,
      out_f: 100,
      speed: 1,
      pitch_keep: false,
      loop: false,
      link: null,
      effects: [],
    },
  );
  project.transitions.push({
    id: "t3",
    track: "V1",
    from: "c1",
    to: "c7",
    type: "fade",
    duration_f: 10,
    mode: "handle",
    audio: "crossfade",
    params: {},
  });
  project.audio.ducking.push({
    id: "d2",
    target: "A1",
    sidechain: "A1",
    threshold_db: -30,
    ratio: 8,
    attack_ms: 20,
    release_ms: 500,
    makeup_db: 0,
  });
  return project;
}

describe("nextId", () => {
  test("issues sequential ids per prefix and persists the counter", async () => {
    const { dir } = await freshProject();
    expect(await nextId(dir, "c")).toBe("c1");
    expect(await nextId(dir, "c")).toBe("c2");
    expect(await nextId(dir, "t")).toBe("t1");
    expect(await nextId(dir, "c")).toBe("c3");
    const ids = await readIds(dir);
    expect(ids?.counters).toEqual({ c: 4, d: 1, s: 1, t: 2, x: 1 });
    expect(readFileSync(projectPaths(dir).idsFile, "utf8").endsWith("\n")).toBe(true);
  });
  test("20 concurrent calls produce 20 distinct ids", async () => {
    const { dir } = await freshProject();
    const ids = await Promise.all(Array.from({ length: 20 }, () => nextId(dir, "c")));
    expect(new Set(ids).size).toBe(20);
    expect(ids.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(
      Array.from({ length: 20 }, (_, i) => `c${i + 1}`),
    );
    expect((await readIds(dir))?.counters.c).toBe(21);
  });
  test("nextIds issues a contiguous block", async () => {
    const { dir } = await freshProject();
    expect(await nextIds(dir, "x", 3)).toEqual(["x1", "x2", "x3"]);
    expect(await nextId(dir, "x")).toBe("x4");
    expect(await nextIds(dir, "x", 0)).toEqual([]);
  });
  test("missing or corrupt ids.json is rebuilt from project.json", async () => {
    const { dir, project } = await freshProject();
    await saveProject(dir, withClips(project));
    writeFileSync(projectPaths(dir).idsFile, "not json");
    expect(await readIds(dir)).toBeNull();
    expect(await nextId(dir, "c")).toBe("c8"); // max c7 → next 8
    expect(await nextId(dir, "t")).toBe("t4");
    expect(await nextId(dir, "x")).toBe("x1");
  });
});

describe("rebuildIds", () => {
  test("uses max+1 across project and history objects, never rewinds", async () => {
    const { dir, project } = await freshProject();
    withClips(project);
    const history = [{ tracks: [{ clips: [{ id: "c12" }, { id: "x5" }] }] }, { transitions: [{ id: "t1" }] }];
    const ids = await rebuildIds(dir, project, history);
    expect(ids.counters).toEqual({ c: 13, t: 4, x: 6, s: 1, d: 3 });
    // 既存カウンタが大きければ維持
    writeFileSync(projectPaths(dir).idsFile, JSON.stringify({ counters: { c: 100 } }));
    const again = await rebuildIds(dir, project);
    expect(again.counters.c).toBe(100);
    expect(again.counters.t).toBe(4);
  });
  test("collectNumberedIds ignores asset slugs, track ids and unknown prefixes", () => {
    const m = collectNumberedIds({
      id: "clip_a",
      tracks: [{ id: "V1" }],
      items: [{ id: "q9" }, { id: "c3" }, { id: "c10" }],
    });
    expect([...m.entries()]).toEqual([["c", 10]]);
  });
});

describe("assertIdAvailable", () => {
  test("throws E_ID_EXISTS for clips, transitions, ducking, assets and tracks", async () => {
    const { project } = await freshProject();
    withClips(project);
    for (const id of ["c1", "c7", "t3", "d2", "clip_a", "V1"]) {
      expect(() => assertIdAvailable(project, id)).toThrow(MontashError);
      try {
        assertIdAvailable(project, id);
      } catch (e) {
        expect((e as MontashError).code).toBe("E_ID_EXISTS");
      }
    }
    expect(() => assertIdAvailable(project, "c2")).not.toThrow();
  });
});

describe("slugAssetId", () => {
  test("strips extension, lowercases, replaces non-alphanumerics", () => {
    expect(slugAssetId("Clip A.mp4")).toBe("clip_a");
    expect(slugAssetId("/raw/DJI_0001.MOV")).toBe("dji_0001");
    expect(slugAssetId("my--file..name.tar.gz")).toBe("my_file_name_tar");
    expect(slugAssetId("__weird__.wav")).toBe("weird");
  });
  test("numeric-leading and empty stems get a prefix / fallback", () => {
    expect(slugAssetId("2026 trip.mp4")).toBe("a_2026_trip");
    expect(slugAssetId("日本語.mp4")).toBe("asset");
    expect(slugAssetId(".hidden")).toBe("hidden");
  });
  test("collisions get _2, _3, ...", () => {
    const existing = new Set(["clip_a", "clip_a_2"]);
    expect(slugAssetId("clip_a.mp4", existing)).toBe("clip_a_3");
    expect(slugAssetId("clip_b.mp4", existing)).toBe("clip_b");
  });
});
