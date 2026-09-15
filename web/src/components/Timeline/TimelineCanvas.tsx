/**
 * 編集タイムラインの canvas 描画（docs/06 §4, docs/12 ADR-06）。
 * rAF ループで `useStore.getState()` を直接読み、React の再レンダーを経由しない。
 * ルーラー・クリップ矩形（start_f / end_f）・音声クリップの波形・再生ヘッド・選択枠・ヒットテスト。
 * 波形（docs/06 §2.4）は `GET /api/assets/:id/waveform.json` を lib/derived.ts のキャッシュ越しに読み、
 * まだ無ければ従来どおり矩形だけを描く。
 */
import { useEffect, useRef } from "react";
import { getWaveform, onDerivedLoaded, waveformColumns } from "../../lib/derived.ts";
import {
  type ClipLike,
  type ComputedClip,
  clipLabel,
  clipSpan,
  computedIndex,
  displayTracks,
  formatTc,
  fpsOf,
  type TrackLike,
  timelineScaleFrames,
  timelineSpan,
  useStore,
} from "../../store.ts";

export const RULER_H = 18;
export const ROW_H = 28;
const PAD_R = 24;

interface Layout {
  pxPerFrame: number;
  tracks: TrackLike[];
  /** サーバが返した正規化済みの区間（クリップ ID 引き。docs/13 D-1） */
  spans: Map<string, ComputedClip>;
  width: number;
  height: number;
}

function layout(width: number, height: number): Layout {
  const st = useStore.getState();
  const p = st.project;
  // 既定のスケールはプロジェクト尺 + 1 秒。クリップが無いときだけ 10 秒（docs/13 D-2）
  const frames = timelineScaleFrames(timelineSpan(p), fpsOf(p), { playhead_f: st.playhead_f });
  return {
    pxPerFrame: (width - PAD_R) / frames,
    tracks: displayTracks(p),
    spans: computedIndex(p),
    width,
    height,
  };
}

/** クリップ矩形のヒットテスト（canvas 側で自前実装。docs/06 §4） */
export function hitTest(x: number, y: number, lay: Layout): { clip: ClipLike; track: TrackLike } | null {
  const row = Math.floor((y - RULER_H) / ROW_H);
  const track = lay.tracks[row];
  if (!track) return null;
  const f = x / lay.pxPerFrame;
  for (const c of track.clips ?? []) {
    const span = clipSpan(c, lay.spans);
    if (f >= span.start_f && f < span.end_f) return { clip: c, track };
  }
  return null;
}

const COLORS: Record<string, string> = { video: "#3a5f9e", audio: "#2f7d5a", text: "#8a5fb8" };
/** 波形の色（クリップ色の上に重ねる） */
const WAVE_COLOR = "#a8f0c8";

/**
 * 音声クリップの矩形の中に波形を描く。データが無ければ何もしない（矩形だけが残る）。
 * ピークは素材内フレーム `in_f..out_f` の範囲を矩形幅ぶんの列に畳んだもの。
 */
function drawWaveform(
  ctx: CanvasRenderingContext2D,
  clip: ClipLike,
  fps: { num: number; den: number },
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const assetId = typeof clip.asset === "string" ? clip.asset : null;
  if (assetId === null || w < 2 || h < 4) return;
  const waveform = getWaveform(assetId);
  if (!waveform) return;
  const columns = waveformColumns(waveform, fps, clip.in_f ?? 0, clip.out_f ?? 0, Math.max(1, Math.floor(w)));
  if (columns.length === 0) return;
  const mid = y + h / 2;
  const half = h / 2 - 1;
  const alpha = ctx.globalAlpha;
  ctx.fillStyle = WAVE_COLOR;
  // ミュートトラックの薄さ（呼び出し側の globalAlpha）を保ったまま、さらに少し透かす
  ctx.globalAlpha = alpha * 0.75;
  for (let i = 0; i < columns.length; i++) {
    const amp = Math.max(0.5, (columns[i] ?? 0) * half);
    ctx.fillRect(x + i, mid - amp, 1, amp * 2);
  }
  ctx.globalAlpha = alpha;
}

function draw(ctx: CanvasRenderingContext2D, lay: Layout): void {
  const st = useStore.getState();
  const fps = fpsOf(st.project);
  const { width, height, pxPerFrame, tracks, spans } = lay;
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
      // テキスト・字幕も映像と同じく区間の矩形で描く（長さの持ち方の差は clipSpan が吸収する）
      const span = clipSpan(c, spans);
      const x0 = span.start_f * pxPerFrame;
      const w = Math.max(2, span.duration_f * pxPerFrame);
      const base = COLORS[t.kind ?? ""] ?? "#555b66";
      ctx.globalAlpha = t.muted ? 0.4 : 1;
      ctx.fillStyle = base;
      ctx.fillRect(x0, y + 3, w - 1, ROW_H - 6);
      if (t.kind === "audio") drawWaveform(ctx, c, fps, x0, y + 3, w - 1, ROW_H - 6);
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
        ctx.fillText(clipLabel(c, spans), x0 + 4, y + ROW_H / 2);
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
    // 波形は zustand の外（lib/derived.ts）にあるので、届いたことを別途購読して描き直す
    const unsubDerived = onDerivedLoaded(() => {
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
      unsubDerived();
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
