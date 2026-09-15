/**
 * History ストリップのノード配置とクリック判定（web/src/lib/history-hit.ts）。
 * canvas も DOM も使わない純関数だけを検証する（docs/06 §2.7、docs/13 D-8）。
 */
import { describe, expect, test } from "bun:test";
import {
  checkoutIntentAt,
  HISTORY_PAD,
  type HistoryNode,
  hitTestHistoryNode,
  layoutHistoryNodes,
  R_COMMIT,
  R_HEAD_BONUS,
  R_OP,
} from "../../../web/src/lib/history-hit.ts";
import type { OpLike } from "../../../web/src/store.ts";

const WIDTH = 1024;
const HEIGHT = 100;

function ops(n: number, commitEvery = 0): OpLike[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `o_${String(i + 1).padStart(4, "0")}`,
    parent: i === 0 ? null : `o_${String(i).padStart(4, "0")}`,
    commit: commitEvery > 0 && (i + 1) % commitEvery === 0 ? `k_${i + 1}` : null,
  }));
}

describe("layoutHistoryNodes", () => {
  test("places ops evenly between the pads on the vertical center", () => {
    const ns = layoutHistoryNodes(ops(3), WIDTH, HEIGHT);
    expect(ns.map((n) => n.x)).toEqual([HISTORY_PAD, WIDTH / 2, WIDTH - HISTORY_PAD]);
    expect(ns.every((n) => n.y === HEIGHT / 2)).toBe(true);
  });

  test("a single op sits at the left pad", () => {
    expect(layoutHistoryNodes(ops(1), WIDTH, HEIGHT).map((n) => n.x)).toEqual([HISTORY_PAD]);
  });

  test("no ops means no nodes (nothing is clickable)", () => {
    expect(layoutHistoryNodes([], WIDTH, HEIGHT)).toEqual([]);
  });

  test("commit / HEAD nodes get the radius they are drawn with", () => {
    const ns = layoutHistoryNodes(ops(4, 2), WIDTH, HEIGHT, "o_0003");
    expect(ns.map((n) => n.r)).toEqual([R_OP, R_COMMIT, R_OP + R_HEAD_BONUS, R_COMMIT]);
  });

  test("a narrower strip than the pads does not push nodes off to the left", () => {
    const ns = layoutHistoryNodes(ops(3), 20, HEIGHT);
    expect(ns.every((n) => n.x === HISTORY_PAD)).toBe(true);
  });
});

describe("hitTestHistoryNode (docs/13 D-8)", () => {
  const ns = layoutHistoryNodes(ops(3), WIDTH, HEIGHT);
  const mid = ns[1] as HistoryNode;

  test("hits the node body", () => {
    expect(hitTestHistoryNode(ns, mid.x, mid.y)?.op.id).toBe("o_0002");
    expect(hitTestHistoryNode(ns, mid.x + R_OP, mid.y)?.op.id).toBe("o_0002");
    expect(hitTestHistoryNode(ns, mid.x, mid.y - R_OP)?.op.id).toBe("o_0002");
  });

  test("misses just outside the node body — the old ±4px slop is gone", () => {
    expect(hitTestHistoryNode(ns, mid.x + R_OP + 1, mid.y)).toBeNull();
    expect(hitTestHistoryNode(ns, mid.x, mid.y + R_OP + 1)).toBeNull();
    // 円の外（正方形の角）も外す
    expect(hitTestHistoryNode(ns, mid.x + R_OP, mid.y + R_OP)).toBeNull();
  });

  test("the empty space of the strip never checks out anything", () => {
    for (const y of [0, 2, HEIGHT / 2 - R_COMMIT - 1, HEIGHT - 1]) {
      expect(hitTestHistoryNode(ns, WIDTH / 4, y)).toBeNull();
    }
    expect(hitTestHistoryNode(ns, 0, HEIGHT / 2)).toBeNull();
    expect(hitTestHistoryNode(ns, WIDTH - 1, HEIGHT / 2)).toBeNull();
  });

  test("dense histories stay mostly inert between the nodes", () => {
    const dense = layoutHistoryNodes(ops(60), WIDTH, HEIGHT);
    const gap = dense[1]!.x - dense[0]!.x;
    expect(gap).toBeGreaterThan(2 * R_OP); // ノード同士は重ならない
    const between = dense[0]!.x + gap / 2;
    expect(hitTestHistoryNode(dense, between, HEIGHT / 2)).toBeNull();
    expect(hitTestHistoryNode(dense, dense[7]!.x, HEIGHT / 2)?.op.id).toBe("o_0008");
  });

  test("overlapping nodes resolve to the nearest center", () => {
    const overlapping: HistoryNode[] = [
      { op: { id: "a" }, x: 100, y: 50, r: 10 },
      { op: { id: "b" }, x: 108, y: 50, r: 10 },
    ];
    expect(hitTestHistoryNode(overlapping, 103, 50)?.op.id).toBe("a");
    expect(hitTestHistoryNode(overlapping, 106, 50)?.op.id).toBe("b");
  });

  test("an empty strip has nothing to hit", () => {
    expect(hitTestHistoryNode([], 24, 50)).toBeNull();
  });
});

describe("checkoutIntentAt", () => {
  const ns = layoutHistoryNodes(ops(3), WIDTH, HEIGHT, "o_0003");

  test("a node click asks for `checkout <id>` and remembers where to go back", () => {
    expect(checkoutIntentAt(ns, ns[0]!.x, ns[0]!.y, "o_0003")).toEqual({ to: "o_0001", undoTo: "o_0003" });
  });

  test("clicking HEAD issues nothing (no pointless move in moves.jsonl)", () => {
    expect(checkoutIntentAt(ns, ns[2]!.x, ns[2]!.y, "o_0003")).toBeNull();
  });

  test("clicking the padding or the empty rows issues nothing", () => {
    expect(checkoutIntentAt(ns, 4, HEIGHT / 2, "o_0003")).toBeNull();
    expect(checkoutIntentAt(ns, ns[0]!.x, 4, "o_0003")).toBeNull();
    expect(checkoutIntentAt(ns, ns[0]!.x + 10, ns[0]!.y, "o_0003")).toBeNull();
  });

  test("without a known HEAD the move still works, only the undo is unavailable", () => {
    expect(checkoutIntentAt(ns, ns[1]!.x, ns[1]!.y, null)).toEqual({ to: "o_0002", undoTo: null });
  });
});
