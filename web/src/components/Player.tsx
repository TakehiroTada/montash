/**
 * プレビューペイン（docs/06 §2.2）。プレビューが無い間はプレースホルダを表示する。
 * `/preview/timeline.mp4` の配信は後続（preview build 実装後）。
 */
import { useStore } from "../store.ts";

export function Player() {
  const state = useStore((s) => s.status?.preview.state ?? "missing");
  const hash = useStore((s) => s.projectHash);
  if (state === "ready" || state === "stale") {
    return (
      <div className="player">
        <video src={`/preview/timeline.mp4${hash ? `?v=${encodeURIComponent(hash)}` : ""}`} controls playsInline />
        {state === "stale" ? (
          <span className="badge warn" style={{ position: "absolute", top: 8, right: 8 }}>
            プレビュー再生成中
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="player">
      <div className="placeholder">
        <div className="big">▶</div>
        <div>preview: {state}</div>
        <div className="mono" style={{ fontSize: 11 }}>
          montash preview build
        </div>
      </div>
    </div>
  );
}
