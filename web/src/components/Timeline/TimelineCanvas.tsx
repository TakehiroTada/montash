/**
 * 編集タイムラインの canvas 描画（docs/06 §4, docs/12 ADR-06）。
 * rAF ループで `useStore.getState()` を直接読み、React の再レンダーを経由しない。
 * この段階はルーラー・クリップ矩形（start_f / end_f）・再生ヘッド・選択枠・ヒットテストのみ。
 */
import { useEffect, useRef } from "react";
import {
  type ClipLike,
  clipEnd,
  displayTracks,
  formatTc,
  fpsOf,
  type TrackLike,
  timelineDuration,
  useStore,
} from "../../store.ts";

export const RULER_H = 18;
export const ROW_H = 28;
const PAD_R = 24;

interface Layout {
  pxPerFrame: number;
  tracks: TrackLike[];
  width: number;
  height: number;
}

function layout(width: number, height: number): Layout {
  const st = useStore.getState();
  const p = st.project;
  const fps = fpsOf(p);
  const dur = timelineDuration(p);
  // 最低 10 秒分は表示し、それ以上は尺に合わせる（ズーム／スクロールは後続）
  const frames = Math.max(dur, Math.round((10 * fps.num) / fps.den), st.playhead_f + 1);
  return { pxPerFrame: (width - PAD_R) / frames, tracks: displayTracks(p), width, height };
}

/** クリップ矩形のヒットテスト（canvas 側で自前実装。docs/06 §4） */
export function hitTest(x: number, y: number, lay: Layout): { clip: ClipLike; track: TrackLike } | null {
  const row = Math.floor((y - RULER_H) / ROW_H);
  const track = lay.tracks[row];
  if (!track) return null;
  const f = x / lay.pxPerFrame;
  for (const c of track.clips ?? []) if (f >= c.start_f && f < clipEnd(c)) return { clip: c, track };
  return null;
}

const COLORS: Record<string, string> = { video: "#3a5f9e", audio: "#2f7d5a", text: "#8a5fb8" };

function draw(ctx: CanvasRenderingContext2D, lay: Layout): void {
  const st = useStore.getState();
  const fps = fpsOf(st.project);
  const { width, height, pxPerFrame, tracks } = lay;
  ctx.clearRect(0, 0, width, height);

  // ルーラー: 1 秒刻み（詰まるときは 5 / 10 秒）
  const secPx = (pxPerFrame * fps.num) / fps.den;
  const step = secPx > 60 ? 1 : secPx > 14 ? 5 : 10;
  ctx.fillStyle = "#1a1d22";
  ctx.fillRect(0, 0, width, RULER_H);
  ctx.strokeStyle = "#2e333b";
  ctx.fillStyle = "#8b919b";
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "top";
  for (let s = 0; s * secPx < width; s += step) {
    const x = Math.round(s * secPx) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, RULER_H - 5);
    ctx.lineTo(x, RULER_H);
    ctx.stroke();
    ctx.fillText(`${s}s`, x + 2, 2);
  }

  // トラック行
  tracks.forEach((t, i) => {
    const y = RULER_H + i * ROW_H;
    ctx.fillStyle = i % 2 ? "#14171b" : "#121417";
    ctx.fillRect(0, y, width, ROW_H);
    ctx.strokeStyle = "#2e333b";
    ctx.beginPath();
    ctx.moveTo(0, y + ROW_H - 0.5);
    ctx.lineTo(width, y + ROW_H - 0.5);
    ctx.stroke();
    for (const c of t.clips ?? []) {
      const x0 = c.start_f * pxPerFrame;
      const w = Math.max(2, (clipEnd(c) - c.start_f) * pxPerFrame);
      const base = COLORS[t.kind ?? ""] ?? "#555b66";
      ctx.globalAlpha = t.muted ? 0.4 : 1;
      ctx.fillStyle = base;
      ctx.fillRect(x0, y + 3, w - 1, ROW_H - 6);
      const selected = st.selection?.id === c.id;
      const hovered = st.hoverClipId === c.id;
      if (selected || hovered) {
        ctx.strokeStyle = selected ? "#ffffff" : "#4f8cff";
        ctx.lineWidth = selected ? 2 : 1;
        ctx.strokeRect(x0 + 0.5, y + 3.5, w - 2, ROW_H - 7);
        ctx.lineWidth = 1;
      }
      if (w > 24) {
        ctx.fillStyle = "#eef1f5";
        ctx.font = "11px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y, w - 4, ROW_H);
        ctx.clip();
        ctx.fillText(`${c.id}${c.label ? ` ${c.label}` : c.asset ? ` ${c.asset}` : ""}`, x0 + 4, y + ROW_H / 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  });

  // 再生ヘッド
  const px = Math.round(st.playhead_f * pxPerFrame) + 0.5;
  ctx.strokeStyle = "#f85149";
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, height);
  ctx.stroke();
  ctx.fillStyle = "#f85149";
  ctx.beginPath();
  ctx.moveTo(px - 5, 0);
  ctx.lineTo(px + 5, 0);
  ctx.lineTo(px, 7);
  ctx.fill();
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "top";
  const label = `${formatTc(st.playhead_f, fps)} f:${st.playhead_f}`;
  const lx = px + 8 + ctx.measureText(label).width > width ? px - 8 - ctx.measureText(label).width : px + 8;
  ctx.fillText(label, lx, 2);
}

export function TimelineCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const layRef = useRef<Layout | null>(null);

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
      const lay = layout(w, h);
      layRef.current = lay;
      draw(ctx, lay);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      ro.disconnect();
    };
  }, []);

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>, click: boolean) => {
    const lay = layRef.current;
    const canvas = ref.current;
    if (!lay || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const st = useStore.getState();
    if (click && y < RULER_H) {
      st.setPlayhead(x / lay.pxPerFrame);
      return;
    }
    const hit = hitTest(x, y, lay);
    if (click) {
      st.setSelection(hit ? { kind: "clip", id: hit.clip.id, trackId: hit.track.id } : null);
      if (hit) st.setTab("inspector");
    } else if (st.hoverClipId !== (hit?.clip.id ?? null)) {
      st.setHover(hit?.clip.id ?? null);
    }
  };

  return (
    <canvas
      ref={ref}
      onPointerMove={(e) => onPointer(e, false)}
      onPointerDown={(e) => onPointer(e, true)}
      onDoubleClick={(e) => {
        const lay = layRef.current;
        const canvas = ref.current;
        if (!lay || !canvas) return;
        const r = canvas.getBoundingClientRect();
        const hit = hitTest(e.clientX - r.left, e.clientY - r.top, lay);
        if (hit) useStore.getState().setPlayhead(hit.clip.start_f);
      }}
      onPointerLeave={() => useStore.getState().setHover(null)}
    />
  );
}
