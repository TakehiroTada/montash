/**
 * トランスポート（docs/06 §2.3）。現在時刻を HH:MM:SS.mmm と f:<frame> の両方で表示し、クリックでコピーする。
 * プレビュー再生とタイムラインのシークを操作する。
 *
 * シークバーは hover でその位置のサムネイルを出す（§2.3）。サムネイルは「その時刻を覆っている
 * 一番上の映像クリップ」の素材スプライト（`GET /api/assets/:id/thumbs.jpg`）から 1 枚を切り出す。
 * 生成されていない素材では時刻ラベルだけを出す。
 */

import { useRef, useState } from "react";
import { redo, undo } from "../cli-client.ts";
import { getThumbs, thumbSourceAt, thumbTile, tileStyle } from "../lib/derived.ts";
import { formatTc, fpsOf, timelineDuration, useStore } from "../store.ts";
import { useDerivedTick } from "./use-derived-tick.ts";

/** hover サムネイルの表示倍率（160px 幅のタイルを 120px で出す） */
const THUMB_SCALE = 0.75;

export function Transport() {
  const playhead = useStore((s) => s.playhead_f);
  const playing = useStore((s) => s.isPlaying);
  const available = useStore((s) => Boolean(s.status?.preview.url));
  const project = useStore((s) => s.project);
  const readOnly = useStore((s) => s.status?.server.read_only ?? false);
  const fps = fpsOf(project);
  const dur = timelineDuration(project);
  // サムネイルは非同期に届くので、届いたら描き直す
  useDerivedTick();
  const scrub = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ frame: number; ratio: number } | null>(null);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => useStore.getState().toast("info", `copied: ${text}`));
  };

  const frameAt = (clientX: number): { frame: number; ratio: number } | null => {
    const el = scrub.current;
    if (!el || dur <= 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return { frame: Math.min(dur, Math.round(ratio * dur)), ratio };
  };

  // hover 位置を覆う一番上の映像クリップのサムネイル（無ければ時刻ラベルだけ）
  const source = hover === null ? null : thumbSourceAt(project?.tracks ?? [], hover.frame);
  const thumbs = source === null ? null : getThumbs(source.assetId);
  const tile = thumbs === null || source === null ? null : thumbTile(thumbs, source.sourceF);

  return (
    <div className="transport">
      <button
        type="button"
        disabled={!available || playing}
        onClick={() => useStore.getState().setPlaying(true)}
        aria-label="play"
        title="play (Space)"
      >
        ▶
      </button>
      <button
        type="button"
        disabled={!available || !playing}
        onClick={() => useStore.getState().setPlaying(false)}
        aria-label="pause"
        title="pause (Space)"
      >
        ❚❚
      </button>
      <button type="button" onClick={() => useStore.getState().setPlayhead(0)} title="Home">
        ⏮
      </button>
      <button type="button" onClick={() => useStore.getState().setPlayhead(dur)} title="End">
        ⏭
      </button>
      <div
        ref={scrub}
        className="scrub"
        role="slider"
        aria-label="seek"
        aria-valuemin={0}
        aria-valuemax={dur}
        aria-valuenow={playhead}
        tabIndex={-1}
        onPointerMove={(e) => setHover(frameAt(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onPointerDown={(e) => {
          const at = frameAt(e.clientX);
          if (at) useStore.getState().setPlayhead(at.frame);
        }}
        onKeyDown={(e) => {
          // ←/→ は App のグローバルハンドラに任せる（ここでは何もしない）
          if (e.key === "Enter") useStore.getState().setPlayhead(playhead);
        }}
      >
        <div className="fill" style={{ width: dur > 0 ? `${(playhead / dur) * 100}%` : "0%" }} />
        {hover !== null ? (
          <div className="scrub-preview" style={{ left: `${hover.ratio * 100}%` }}>
            {tile && thumbs && source ? (
              <div className="tile" style={tileStyle(thumbs, tile, source.assetId, THUMB_SCALE)} />
            ) : null}
            <span className="mono">{formatTc(hover.frame, fps)}</span>
          </div>
        ) : null}
      </div>
      <span className="time" onClick={() => copy(formatTc(playhead, fps))} title="click to copy">
        {formatTc(playhead, fps)}
      </span>
      <span className="time frame" onClick={() => copy(`f:${playhead}`)} title="click to copy (recommended for AI)">
        f:{playhead}
      </span>
      <span className="dim">/ {formatTc(dur, fps)}</span>
      <button type="button" onClick={() => void undo()} disabled={readOnly} title="undo ( [ )">
        ◀ undo
      </button>
      <button type="button" onClick={() => void redo()} disabled={readOnly} title="redo ( ] )">
        redo ▶
      </button>
      <span className="hint">Space play/pause · [ / ] undo·redo · ←/→ frame · Shift+←/→ 30f</span>
    </div>
  );
}
