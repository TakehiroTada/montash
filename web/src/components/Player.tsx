/** Preview generations retain the transport position and can remain playable during a rebuild. */
import { useEffect, useRef } from "react";
import { bindPlayback } from "../playback.ts";
import { fpsOf, useStore } from "../store.ts";

export function Player() {
  const preview = useStore((s) => s.status?.preview);
  const project = useStore((s) => s.project);
  const video = useRef<HTMLVideoElement>(null);
  const { num, den } = preview?.fps ?? fpsOf(project);
  const url = preview?.url;
  const duration = preview?.duration_f;
  const state = preview?.state ?? "missing";
  useEffect(() => {
    if (!video.current || !url) {
      useStore.getState().setPlaying(false);
      return;
    }
    return bindPlayback(video.current, url, { num, den }, duration);
  }, [url, num, den, duration]);

  return (
    <div className="player">
      {url ? (
        <video ref={video} aria-label="Timeline preview" controls playsInline />
      ) : (
        <div className="placeholder">
          <div className="big">▶</div>
          <div>preview: {state}</div>
          <div className="mono" style={{ fontSize: 11 }}>
            montash preview build
          </div>
        </div>
      )}
      {state === "building" || state === "stale" || preview?.error ? (
        <span role="status" className="badge warn" style={{ position: "absolute", top: 8, right: 8 }}>
          {preview?.error
            ? `プレビュー生成失敗: ${preview.error}`
            : state === "building"
              ? "プレビュー生成中"
              : "プレビューの更新が必要です"}
        </span>
      ) : null}
    </div>
  );
}
