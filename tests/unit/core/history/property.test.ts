/**
 * 性質テスト: ランダムな JSON 変更と undo / redo / checkout を混ぜても
 * 常に `hash(現在の project) === HEAD.after` かつ最終的に `verify().ok`。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { MontashError } from "../../../../src/cli/errors.ts";
import { applyChanges, canonicalHash, History } from "../../../../src/core/history/index.ts";
import { init, openHistory, tempDir, type Project } from "./helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
let h: History;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  h = await openHistory(dir);
});
afterEach(() => cleanup());

/** 決定的な擬似乱数（mulberry32） */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomMutation(p: Project, rand: () => number, seq: { n: number }): void {
  const track = p.tracks[Math.floor(rand() * p.tracks.length)]!;
  const r = rand();
  if (r < 0.3 || track.clips.length === 0) {
    const start = Math.floor(rand() * 1000);
    track.clips.push({ id: `c${++seq.n}`, asset: "a", start_f: start, duration_f: 1 + Math.floor(rand() * 100), in_f: 0, out_f: 10 });
  } else if (r < 0.5) {
    track.clips.splice(Math.floor(rand() * track.clips.length), 1);
  } else if (r < 0.8) {
    const clip = track.clips[Math.floor(rand() * track.clips.length)]!;
    clip.start_f = Math.floor(rand() * 1000);
    if (rand() < 0.5) clip.duration_f = 1 + Math.floor(rand() * 100);
  } else if (r < 0.9) {
    p.meta = { ...(p.meta ?? {}), [`k${Math.floor(rand() * 5)}`]: rand() < 0.5 ? Math.floor(rand() * 10) : { nested: [rand() < 0.5, "x"] } };
  } else if (p.meta && Object.keys(p.meta).length > 0) {
    const keys = Object.keys(p.meta);
    delete p.meta[keys[Math.floor(rand() * keys.length)]!];
  } else {
    p.settings.fps = rand() < 0.5 ? { num: 30, den: 1 } : { num: 30000, den: 1001 };
  }
}

describe("性質: HEAD.after は常に現在の project のハッシュ", () => {
  test.each([1, 7, 42])("seed %i: 200 変更 + ランダムな undo/redo/checkout/commit", async (seed) => {
    const rand = rng(seed);
    const seq = { n: 1 };
    let { project: current } = await init(h);
    let edits = 0;
    const objectHashes = new Set<string>([canonicalHash(current)]);

    const assertConsistent = async (): Promise<void> => {
      const st = await h.status({ project: current });
      expect(st.headOp?.after).toBe(canonicalHash(current));
      expect(st.dirty).toBe(false);
      expect(st.detached).toBe(st.head !== st.tip);
    };

    while (edits < 200) {
      const r = rand();
      if (r < 0.55) {
        const after = structuredClone(current);
        randomMutation(after, rand, seq);
        const res = await h.recordOp({ before: current, after, command: ["rand", String(edits)], actor: rand() < 0.5 ? "ai" : "human", summary: `edit ${edits}` });
        expect(res.warnings).toEqual([]);
        // 記録された changes を before に当てると after になる
        expect(applyChanges(current, res.op.changes)).toEqual(after);
        current = after;
        objectHashes.add(canonicalHash(current));
        edits++;
      } else if (r < 0.7) {
        const n = 1 + Math.floor(rand() * 3);
        try {
          current = (await h.undo(n, "human")).project as Project;
        } catch (e) {
          expect(e).toBeInstanceOf(MontashError);
          expect((e as MontashError).code).toBe("E_NOTHING_TO_UNDO");
        }
      } else if (r < 0.85) {
        const n = 1 + Math.floor(rand() * 3);
        try {
          current = (await h.redo(n, "human")).project as Project;
        } catch (e) {
          expect(e).toBeInstanceOf(MontashError);
          expect((e as MontashError).code).toBe("E_NOTHING_TO_REDO");
        }
      } else if (r < 0.95) {
        const ops = await h.store.readOps();
        const ref = rand() < 0.2 ? "tip" : ops[Math.floor(rand() * ops.length)]!.id;
        current = (await h.checkout(ref, "web")).project as Project;
      } else {
        try {
          await h.commit({ message: `commit at ${edits}`, author: "ai", last: rand() < 0.3 ? 1 : undefined });
        } catch (e) {
          expect((e as MontashError).code).toBe("E_NOTHING_TO_COMMIT");
        }
      }
      await assertConsistent();
    }

    // object は内容ごとに 1 つだけ（undo/redo/checkout で増えない）
    const files = await readdir(join(h.store.dir, "objects"));
    expect(files.length).toBe(objectHashes.size);
    const v = await h.verify();
    expect(v.problems.join("\n")).toBe("");
    expect(v.ok).toBe(true);
    // 別インスタンスから開いても同じ状態
    const reopened = await History.open(dir);
    expect((await reopened.status({ project: current })).dirty).toBe(false);
    expect((await reopened.store.readOps()).length).toBe(201);
  }, 60_000);
});
