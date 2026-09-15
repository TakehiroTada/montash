import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MontashError } from "../../../src/cli/errors.ts";
import {
  assertIdAvailable,
  collectNumberedIds,
  existingIds,
  idPrefixes,
  isValidIdPrefix,
  nextId,
  nextIds,
  parseNumberedId,
  readIds,
  rebuildIds,
  registerIdPrefix,
  resetIdPrefixes,
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

// ---------------------------------------------------------------------------
// 多文字プレフィックス（D-17）
// ---------------------------------------------------------------------------

describe("id prefixes", () => {
  afterEach(() => resetIdPrefixes());

  test("parseNumberedId keeps single-letter ids compatible", () => {
    expect(parseNumberedId("c1")).toEqual({ prefix: "c", n: 1 });
    expect(parseNumberedId("x12")).toEqual({ prefix: "x", n: 12 });
    expect(parseNumberedId("t3")).toEqual({ prefix: "t", n: 3 });
    expect(parseNumberedId("s1")).toEqual({ prefix: "s", n: 1 });
    expect(parseNumberedId("d1")).toEqual({ prefix: "d", n: 1 });
  });
  test("parseNumberedId splits multi-letter prefixes at the trailing digits", () => {
    expect(parseNumberedId("fx1")).toEqual({ prefix: "fx", n: 1 });
    expect(parseNumberedId("fx12")).toEqual({ prefix: "fx", n: 12 });
    expect(parseNumberedId("glow2x9")).toEqual({ prefix: "glow2x", n: 9 });
  });
  test("parseNumberedId rejects non-numbered ids", () => {
    for (const id of ["clip_a", "V1", "c", "1", "C1", "c1a", ""]) expect(parseNumberedId(id)).toBeNull();
  });
  test("isValidIdPrefix rejects shapes that cannot be split back", () => {
    expect(isValidIdPrefix("c")).toBe(true);
    expect(isValidIdPrefix("fx")).toBe(true);
    expect(isValidIdPrefix("a1b")).toBe(true);
    expect(isValidIdPrefix("fx2")).toBe(false); // 末尾が数字だと連番と区別できない
    expect(isValidIdPrefix("Fx")).toBe(false);
    expect(isValidIdPrefix("f_x")).toBe(false);
    expect(isValidIdPrefix("")).toBe(false);
  });
  test("registerIdPrefix is idempotent and rejects invalid prefixes", () => {
    expect(idPrefixes()).toEqual(["c", "t", "x", "s", "d"]);
    registerIdPrefix("fx");
    registerIdPrefix("fx");
    registerIdPrefix("c");
    expect(idPrefixes()).toEqual(["c", "t", "x", "s", "d", "fx"]);
    expect(() => registerIdPrefix("fx2")).toThrow(MontashError);
    try {
      registerIdPrefix("FX");
    } catch (e) {
      expect((e as MontashError).code).toBe("E_USAGE");
    }
  });
  test("collectNumberedIds only counts registered prefixes", () => {
    const tree = { items: [{ id: "fx1" }, { id: "fx7" }, { id: "c3" }, { id: "zz9" }] };
    expect([...collectNumberedIds(tree).entries()]).toEqual([["c", 3]]);
    registerIdPrefix("fx");
    expect([...collectNumberedIds(tree).entries()].sort()).toEqual([
      ["c", 3],
      ["fx", 7],
    ]);
    // 明示的なプレフィックス集合を渡せる（将来 registry から）
    expect([...collectNumberedIds(tree, new Map(), ["zz"]).entries()]).toEqual([["zz", 9]]);
  });
  test("nextId issues and registers multi-letter prefixes", async () => {
    const { dir } = await freshProject();
    expect(await nextId(dir, "fx")).toBe("fx1");
    expect(await nextId(dir, "fx")).toBe("fx2");
    expect(await nextIds(dir, "fx", 2)).toEqual(["fx3", "fx4"]);
    expect((await readIds(dir))?.counters.fx).toBe(5);
    expect(idPrefixes()).toContain("fx");
    // 組み込みの採番は従来どおり
    expect(await nextId(dir, "c")).toBe("c1");
  });
  test("rebuildIds restores a registered multi-letter prefix after ids.json is lost", async () => {
    const { dir, project } = await freshProject();
    withClips(project);
    (project as unknown as Record<string, unknown>).plugins = {
      foo: [{ id: "fx5", clip: "c1" }, { id: "fx2" }],
    };
    await saveProject(dir, project);
    rmSync(projectPaths(dir).idsFile);
    expect(await readIds(dir)).toBeNull();

    // 未登録なら未知プレフィックスは復元されない（従来どおり取りこぼす）
    const without = await rebuildIds(dir, project);
    expect(without.counters.fx).toBeUndefined();

    rmSync(projectPaths(dir).idsFile);
    registerIdPrefix("fx");
    const ids = await rebuildIds(dir, project);
    expect(ids.counters).toEqual({ c: 8, t: 4, x: 1, s: 1, d: 3, fx: 6 });
    // 自動再構築の経路でも取りこぼさない
    rmSync(projectPaths(dir).idsFile);
    expect(await nextId(dir, "fx")).toBe("fx6");
  });
  test("rebuildIds never rewinds a counter that only exists in ids.json", async () => {
    const { dir, project } = await freshProject();
    writeFileSync(projectPaths(dir).idsFile, JSON.stringify({ counters: { c: 1, fx: 42 } }));
    const ids = await rebuildIds(dir, project);
    expect(ids.counters.fx).toBe(42);
  });
  test("history objects contribute to multi-letter prefixes too", async () => {
    const { dir, project } = await freshProject();
    registerIdPrefix("fx");
    const ids = await rebuildIds(dir, project, [{ effects: [{ id: "fx11" }] }]);
    expect(ids.counters.fx).toBe(12);
  });
});

describe("existingIds", () => {
  test("collects ids from arbitrary subtrees (plugin areas)", async () => {
    const { project } = await freshProject();
    withClips(project);
    (project as unknown as Record<string, unknown>).plugins = { foo: [{ id: "fx1" }] };
    (project.meta as unknown as Record<string, unknown>).last_render = { nested: { id: "zz9" } };
    const ids = existingIds(project);
    for (const id of ["c1", "c7", "t3", "d2", "clip_a", "V1", "fx1", "zz9"]) expect(ids.has(id)).toBe(true);
    expect(() => assertIdAvailable(project, "fx1")).toThrow(MontashError);
    try {
      assertIdAvailable(project, "zz9");
    } catch (e) {
      expect((e as MontashError).code).toBe("E_ID_EXISTS");
    }
    expect(() => assertIdAvailable(project, "fx2")).not.toThrow();
  });
  test("stays fast on a large project", async () => {
    const { project } = await freshProject();
    project.assets.clip_a = { id: "clip_a", type: "video", path: "a.mp4", owned: false, tags: [], duration_f: 100000 };
    for (let i = 1; i <= 5000; i++) {
      project.tracks[0]!.clips.push({
        id: `c${i}`,
        asset: "clip_a",
        start_f: i * 10,
        in_f: 0,
        out_f: 10,
        speed: 1,
        pitch_keep: false,
        loop: false,
        link: null,
        effects: [],
      });
    }
    const t0 = performance.now();
    const ids = existingIds(project);
    const elapsed = performance.now() - t0;
    expect(ids.size).toBeGreaterThan(5000);
    expect(elapsed).toBeLessThan(100); // N-3（clip add 200ms）に対して十分小さい
  });
});
