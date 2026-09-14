/**
 * ログペイン（docs/06 §2.8）。op 追記・WS イベント・Web 発行コマンドの結果を時系列表示。
 */
import { useEffect, useRef } from "react";
import { useStore } from "../store.ts";

const fmt = (t: number): string => new Date(t).toTimeString().slice(0, 8);

export function LogPane() {
  const logs = useStore((s) => s.logs);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);
  return (
    <div className="log" ref={ref}>
      {logs.length === 0 ? <div className="line t">Log: (empty)</div> : null}
      {logs.map((l, i) => (
        <div key={i} className={`line ${l.level}`}>
          <span className="t">{fmt(l.at)}</span> {l.actor ? <span className="actor">[{l.actor}]</span> : null} {l.message}
        </div>
      ))}
    </div>
  );
}
