/**
 * トランスポート（docs/06 §2.3）。現在時刻を HH:MM:SS.mmm と f:<frame> の両方で表示し、クリックでコピーする。
 * プレビュー再生とタイムラインのシークを操作する。
 */

import { redo, undo } from "../cli-client.ts";
import { formatTc, fpsOf, timelineDuration, useStore } from "../store.ts";

export function Transport() {
  const playhead = useStore((s) => s.playhead_f);
  const playing = useStore((s) => s.isPlaying);
  const available = useStore((s) => Boolean(s.status?.preview.url));
  const project = useStore((s) => s.project);
  const readOnly = useStore((s) => s.status?.server.read_only ?? false);
  const fps = fpsOf(project);
  const dur = timelineDuration(project);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => useStore.getState().toast("info", `copied: ${text}`));
  };

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
