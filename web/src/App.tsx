/**
 * アプリのレイアウト（docs/06 §2）。
 * ヘッダー / プレビュー / トランスポート / 編集タイムライン / 右ペインタブ / History strip / ログ。
 * `[` / `]` で undo / redo を `POST /api/cli` に発行する（§2.2）。
 */
import { useEffect } from "react";
import { redo, undo } from "./cli-client.ts";
import { AssetsPanel } from "./components/Assets/AssetsPanel.tsx";
import { Header } from "./components/Header.tsx";
import { HistoryStrip } from "./components/History/HistoryStrip.tsx";
import { HistoryTab, Inspector } from "./components/Inspector.tsx";
import { LogPane } from "./components/LogPane.tsx";
import { Player } from "./components/Player.tsx";
import { TimelineView } from "./components/Timeline/TimelineView.tsx";
import { Transport } from "./components/Transport.tsx";
import { type SideTab, useStore } from "./store.ts";

const TABS: Array<{ id: SideTab; label: string }> = [
  { id: "inspector", label: "Inspector" },
  { id: "assets", label: "Assets" },
  { id: "history", label: "History" },
];

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

export function App() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useStore.getState();
      if (
        e.key === " " &&
        st.status?.preview.url &&
        !(e.target instanceof HTMLElement && e.target.closest("button, video, select, a"))
      ) {
        e.preventDefault();
        if (!e.repeat) st.setPlaying(!st.isPlaying);
      } else if (e.key === "[" && !st.status?.server.read_only) {
        e.preventDefault();
        void undo();
      } else if (e.key === "]" && !st.status?.server.read_only) {
        e.preventDefault();
        void redo();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        st.setPlayhead(st.playhead_f - (e.shiftKey ? 30 : 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        st.setPlayhead(st.playhead_f + (e.shiftKey ? 30 : 1));
      } else if (e.key === "Home") {
        st.setPlayhead(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <Header />
      <div className="main">
        <Player />
        <Transport />
        <TimelineView />
      </div>
      <aside className="side">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              type="button"
              key={t.id}
              role="tab"
              className={t.id === tab ? "active" : ""}
              aria-selected={t.id === tab}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="content">
          {tab === "inspector" && <Inspector />}
          {tab === "assets" && <AssetsPanel />}
          {tab === "history" && <HistoryTab />}
        </div>
      </aside>
      <HistoryStrip />
      <LogPane />
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            <div onClick={() => dismiss(t.id)}>
              {t.text.split("\n").map((line, i) => (
                <div key={i} className={i > 0 ? "code" : ""}>
                  {line}
                </div>
              ))}
            </div>
            {t.action ? (
              <button
                type="button"
                className="toast-action"
                onClick={() => {
                  dismiss(t.id);
                  void t.action?.run();
                }}
              >
                {t.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
