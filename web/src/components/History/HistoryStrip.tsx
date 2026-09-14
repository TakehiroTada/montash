/**
 * 下部常設の History タイムライン（docs/06 §2.7）。canvas に op を点で描く（この段階は等間隔配置のみ）。
 * ノードクリックで `checkout <id>` を発行する。
 */
import { useEffect, useRef } from "react";
import { checkout } from "../../cli-client.ts";
import { type OpLike, useStore } from "../../store.ts";

const PAD = 24;
const R_OP = 4;
const R_COMMIT = 6;

interface Node {
  op: OpLike;
  x: number;
  y: number;
  r: number;
}

function nodes(width: number, height: number): Node[] {
  const h = useStore.getState().history;
  const ops = h?.ops ?? [];
  if (ops.length === 0) return [];
  const gap = ops.length > 1 ? (width - PAD * 2) / (ops.length - 1) : 0;
  const y = Math.round(height / 2);
  return ops.map((op, i) => ({ op, x: PAD + i * gap, y, r: op.commit ? R_COMMIT : R_OP }));
}

function draw(ctx: CanvasRenderingContext2D, width: number, height: number, ns: Node[]): void {
  ctx.clearRect(0, 0, width, height);
  const st = useStore.getState();
  const head = st.status?.head?.op ?? st.history?.head ?? null;
  if (ns.length === 0) {
    ctx.fillStyle = "#8b919b";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("no history yet — ops appear here as `montash` commands run", PAD, height / 2);
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
  // ノード
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelEvery = Math.max(1, Math.ceil((ns.length * 44) / Math.max(1, width - PAD * 2)));
  ns.forEach((n, i) => {
    const isHead = head !== null && n.op.id === head;
    ctx.beginPath();
    ctx.arc(n.x, n.y, isHead ? n.r + 2 : n.r, 0, Math.PI * 2);
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
  const nodesRef = useRef<Node[]>([]);
  const ops = useStore((s) => s.history?.ops.length ?? 0);
  const head = useStore((s) => s.status?.head?.op ?? null);
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
      nodesRef.current = nodes(w, h);
      draw(ctx, w, h, nodesRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      ro.disconnect();
    };
  }, []);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = ref.current;
    if (!canvas || readOnly) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const hit = nodesRef.current.find((n) => Math.hypot(n.x - x, n.y - y) <= n.r + 4);
    if (hit) void checkout(hit.op.id);
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
        <canvas ref={ref} onClick={onClick} style={{ cursor: readOnly ? "default" : "pointer" }} />
      </div>
    </section>
  );
}
