/**
 * History ストリップのノード配置とクリック判定（docs/06 §2.7、docs/13 D-8）。
 * canvas も DOM もストアも触らない純関数だけを置く（テストは tests/unit/web/history-hit.test.ts）。
 *
 * D-8（放置中の誤クリックで意図しない `checkout` が走った事故）を受けて、
 * **クリック判定は「実際に描かれたノードの円の内側」だけ** に限る。以前は半径 + 4px の余白まで
 * 反応していたため、op が詰まった履歴では帯のほぼ全域が checkout の当たり判定になっていた。
 */
import type { OpLike } from "../store.ts";

/** 左右の余白（ノードの中心が置かれる最小 x） */
export const HISTORY_PAD = 24;
/** op ノードの半径 */
export const R_OP = 4;
/** commit ノードの半径 */
export const R_COMMIT = 6;
/** HEAD ノードは一回り大きく描く（描画と判定でこの値を共有する） */
export const R_HEAD_BONUS = 2;

export interface HistoryNode {
  op: OpLike;
  x: number;
  y: number;
  /** 描画半径。ヒットテストもこの半径で行う（描かれていない所は反応させない） */
  r: number;
}

/** op を等間隔に並べる（docs/06 §2.7 の「等間隔」表示）。 */
export function layoutHistoryNodes(
  ops: readonly OpLike[],
  width: number,
  height: number,
  head: string | null = null,
): HistoryNode[] {
  if (ops.length === 0) return [];
  const span = Math.max(0, width - HISTORY_PAD * 2);
  const gap = ops.length > 1 ? span / (ops.length - 1) : 0;
  const y = Math.round(height / 2);
  return ops.map((op, i) => ({
    op,
    x: HISTORY_PAD + i * gap,
    y,
    r: (op.commit ? R_COMMIT : R_OP) + (head !== null && op.id === head ? R_HEAD_BONUS : 0),
  }));
}

/**
 * 点 (x, y) を含むノードを返す。ノード本体（円）の内側だけを当たりとし、
 * 重なっている場合は中心が最も近いものを選ぶ。どのノードにも当たらなければ null。
 */
export function hitTestHistoryNode(nodes: readonly HistoryNode[], x: number, y: number): HistoryNode | null {
  let best: HistoryNode | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const node of nodes) {
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance <= node.r && distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

/** クリック 1 回で発行するコマンド（`checkout to`）と、取り消し先（`checkout undoTo`）。 */
export interface CheckoutIntent {
  to: string;
  /** クリック時点の HEAD。トーストの「元に戻す」で戻る先（HEAD 不明なら null） */
  undoTo: string | null;
}

/**
 * ストリップ上の点から、発行すべき `checkout` を決める（純関数）。
 * ノード本体の外、または HEAD 自身のクリックは `null`（= コマンドを発行しない）。
 */
export function checkoutIntentAt(
  nodes: readonly HistoryNode[],
  x: number,
  y: number,
  head: string | null,
): CheckoutIntent | null {
  const hit = hitTestHistoryNode(nodes, x, y);
  if (!hit || hit.op.id === head) return null;
  return { to: hit.op.id, undoTo: head };
}
