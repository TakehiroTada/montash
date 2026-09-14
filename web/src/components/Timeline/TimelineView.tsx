/**
 * 編集タイムラインの「枠」（docs/06 §2.4, §4）: トラック名の列は React、クリップ本体は TimelineCanvas（canvas）。
 * 行の高さは CSS（.row 28px）と TimelineCanvas の ROW_H を一致させる。
 */
import { displayTracks, useStore } from "../../store.ts";
import { TimelineCanvas } from "./TimelineCanvas.tsx";

export function TimelineView() {
  const project = useStore((s) => s.project);
  const tracks = displayTracks(project);
  return (
    <div className="timeline">
      <div className="names">
        {tracks.map((t) => (
          <div key={t.id} className={`row ${t.muted ? "muted" : ""}`} title={`${t.id} (${t.kind ?? "?"})`}>
            <span className={`kind ${t.kind ?? ""}`} />
            {t.name ?? t.id}
          </div>
        ))}
      </div>
      <div className="canvas-wrap">
        <TimelineCanvas />
        {tracks.length === 0 ? <div className="empty">{project ? "no tracks — `montash track add`" : "project.json not found"}</div> : null}
      </div>
    </div>
  );
}
