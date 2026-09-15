/**
 * 下部常設の History タイムライン（docs/06 §2.7）。canvas に op を点で描く（この段階は等間隔配置のみ）。
 * ノードクリックで `checkout <id>` を発行する。
 *
 * 誤クリック対策（docs/13 D-8）:
 * - クリック判定は `lib/history-hit.ts` の `hitTestHistoryNode`（描かれた円の内側だけ）。
 * - checkout が走ったら「元に戻す」付きのトーストを出す（押すと直前の位置へ `checkout` を再発行）。
 * - detached の間は警告帯を出し、`checkout tip` への導線を常設する。
 */
import { useEffect, useRef } from "react";
import { checkout } from "../../cli-client.ts";
import {
  checkoutIntentAt,
  HISTORY_PAD,
  type HistoryNode,
  hitTestHistoryNode,
  layoutHistoryNodes,
  R_COMMIT,
} from "../../lib/history-hit.ts";
import { useStore } from "../../store.ts";

/** 「元に戻す」を押す時間を確保するため、通常のトーストより長く出す */
const UNDO_TOAST_MS = 12_000;

function draw(ctx: CanvasRenderingContext2D, width: number, height: number, ns: HistoryNode[]): void {
  ctx.clearRect(0, 0, width, height);
  const st = useStore.getState();
  const head = st.status?.head?.op ?? st.history?.head ?? null;
  if (ns.length === 0) {
    ctx.fillStyle = "#8b919b";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("no history yet — ops appear here as `montash` commands run", HISTORY_PAD, height / 2);
    return;
  }
  // 辺
  ctx.strokeStyle = "#3a404a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const byId = new Map(ns.map((n) => [n.op.id, n]));
  for (const [i, n] of ns.entries()) {
    const parent = n.op.parent ? byId.get(n.op.parent) : undefined;
    if (!parent) continue;
    ctx.moveTo(parent.x, parent.y);
    if (ns[i - 1] === parent) ctx.lineTo(n.x, n.y);
    else ctx.quadraticCurveTo((parent.x + n.x) / 2, n.y - 24, n.x, n.y);
  }
  ctx.stroke();
  ctx.lineWidth = 1;
  // ノード（半径はレイアウト済みの値 = クリック判定と同じ）
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelEvery = Math.max(1, Math.ceil((ns.length * 44) / Math.max(1, width - HISTORY_PAD * 2)));
  ns.forEach((n, i) => {
    const isHead = head !== null && n.op.id === head;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fillStyle = n.op.commit ? "#4f8cff" : "#1a1d22";
    ctx.fill();
    ctx.strokeStyle = isHead ? "#ffffff" : n.op.actor === "web" ? "#3fb950" : "#8b919b";
    ctx.stroke();
    if (i % labelEvery === 0 || isHead || i === ns.length - 1) {
      ctx.fillStyle = isHead ? "#ffffff" : "#8b919b";
      ctx.fillText(n.op.id, n.x, n.y + R_COMMIT + 4);
    }
  });
  ctx.textAlign = "start";
}

export function HistoryStrip() {
  const ref = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<HistoryNode[]>([]);
  const ops = useStore((s) => s.history?.ops.length ?? 0);
  const head = useStore((s) => s.status?.head?.op ?? null);
  const detached = useStore((s) => s.status?.head?.detached ?? false);
  const pending = useStore((s) => s.status?.head?.pending ?? 0);
  const readOnly = useStore((s) => s.status?.server.read_only ?? false);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let dirty = true;
    const unsub = useStore.subscribe(() => {
      dirty = true;
    });
    const ro = new ResizeObserver(() => {
      dirty = true;
    });
    ro.observe(canvas);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!dirty) return;
      dirty = false;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const st = useStore.getState();
      const at = st.status?.head?.op ?? st.history?.head ?? null;
      nodesRef.current = layoutHistoryNodes(st.history?.ops ?? [], w, h, at);
      draw(ctx, w, h, nodesRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      ro.disconnect();
    };
  }, []);

  /** ノードの上だけ pointer カーソルにして、当たり判定の範囲を見えるようにする */
  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = ref.current;
    if (!canvas || readOnly) return;
    const r = canvas.getBoundingClientRect();
    const hit = hitTestHistoryNode(nodesRef.current, e.clientX - r.left, e.clientY - r.top);
    canvas.style.cursor = hit ? "pointer" : "default";
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = ref.current;
    if (!canvas || readOnly) return;
    const r = canvas.getBoundingClientRect();
    const from = useStore.getState().status?.head?.op ?? null;
    // ノード本体の外・HEAD 自身は無反応（D-8: 帯の余白を踏んだだけで checkout が走らないようにする）
    const intent = checkoutIntentAt(nodesRef.current, e.clientX - r.left, e.clientY - r.top, from);
    if (!intent) return;
    const { to, undoTo } = intent;
    void checkout(to, {
      toastMs: UNDO_TOAST_MS,
      action: undoTo ? { label: `元に戻す（checkout ${undoTo}）`, run: () => void checkout(undoTo) } : undefined,
    });
  };

  return (
    <section className="history">
      <div className="bar">
        <b>History</b>
        <span>{ops} ops</span>
        <span>
          HEAD <span className="mono">{head ?? "—"}</span>
        </span>
        {pending > 0 ? (
          <span>
            pending {pending} — <code>montash commit -m "..."</code>
          </span>
        ) : null}
        <span style={{ marginLeft: "auto" }}>
          click a node → <code>checkout</code>
        </span>
      </div>
      <div className="canvas-wrap">
        <canvas ref={ref} onClick={onClick} onMouseMove={onMouseMove} style={{ cursor: "default" }} />
        {detached ? (
          <div className="detached-banner" role="status">
            <span>
              過去の状態を表示中（detached）— このまま <code>preview build</code> すると、まだクリップの無い時点では{" "}
              <code>E_EMPTY_TIMELINE</code> になります
            </span>
            {readOnly ? null : (
              <button type="button" onClick={() => void checkout("tip")} title="montash checkout tip">
                最新へ
              </button>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
