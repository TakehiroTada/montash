/**
 * ヘッダー（docs/06 §2.1）: プロジェクト名・解像度・fps・尺・クリップ数・HEAD・接続／プレビュー状態
 */
import { clipCount, formatTc, fpsOf, timelineDuration, useStore } from "../store.ts";

export function Header() {
  const project = useStore((s) => s.project);
  const status = useStore((s) => s.status);
  const connection = useStore((s) => s.connection);
  const setTab = useStore((s) => s.setTab);

  const fps = fpsOf(project);
  const res = project?.settings?.resolution;
  const dur = timelineDuration(project);
  const head = status?.head;
  const fpsLabel = fps.den === 1 ? `${fps.num}` : (fps.num / fps.den).toFixed(2);

  return (
    <header className="header">
      <span className="brand">montash</span>
      {project ? (
        <>
          <span>{project.name ?? "(unnamed)"}</span>
          <span className="dim">
            {res ? `${res.width}x${res.height}` : "—"} {fpsLabel}fps ·{" "}
            <span className="mono">{formatTc(dur, fps)}</span> · {clipCount(project)} clips
          </span>
        </>
      ) : (
        <span className="dim">project.json not found</span>
      )}
      <span className="spacer" />
      <button
        type="button"
        className={`badge ${head?.detached ? "warn" : ""}`}
        onClick={() => setTab("history")}
        title="History"
      >
        HEAD <span className="mono">{head?.op ?? "—"}</span>
        {head?.commit ? (
          <span className="dim mono">
            ({head.commit}
            {head.pending ? ` +${head.pending} pending` : ""})
          </span>
        ) : null}
      </button>
      <span
        className={`badge ${status?.preview.state === "ready" ? "ok" : status?.preview.state === "building" ? "warn" : ""}`}
      >
        <span className="dot" /> preview: {status?.preview.state ?? "—"}
      </span>
      <span className={`badge ${connection === "open" ? "ok" : connection === "connecting" ? "warn" : "err"}`}>
        <span className="dot" /> {connection}
      </span>
      {status?.server.read_only ? (
        <span className="badge warn">
          <span className="dot" /> read-only
        </span>
      ) : null}
    </header>
  );
}
