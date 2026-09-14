/**
 * WebSocket クライアント（docs/06 §3.4）。サーバ → クライアントの push のみ。
 * 切断時は指数バックオフで再接続する（docs/06 §5「切断バッジと自動再接続」）。
 */
import { refreshAll, refreshHistory, refreshProject, refreshStatus } from "./api.ts";
import { useStore } from "./store.ts";

export interface WsMessage {
  type: string;
  [k: string]: unknown;
}

let socket: WebSocket | null = null;
let retryMs = 500;
let stopped = false;

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

export function handleMessage(msg: WsMessage): void {
  const st = useStore.getState();
  switch (msg.type) {
    case "hello":
      st.setConnection("open");
      void refreshAll();
      st.log("info", `connected (server ${String(msg.version ?? "?")}${msg.read_only ? ", read-only" : ""})`, "ws");
      break;
    case "project.changed":
      st.log("info", `project.changed (${String(msg.cause ?? "?")})`, "ws");
      void refreshProject();
      void refreshStatus();
      break;
    case "history.moved":
      void refreshProject();
      void refreshHistory();
      void refreshStatus();
      break;
    case "history.appended":
      void refreshHistory();
      void refreshStatus();
      break;
    case "preview.state":
      void refreshStatus();
      break;
    case "log": {
      const level = msg.level === "error" ? "error" : msg.level === "warn" ? "warn" : "info";
      st.log(level, String(msg.message ?? ""), typeof msg.actor === "string" ? msg.actor : undefined);
      break;
    }
    default:
      st.log("info", `${msg.type}: ${JSON.stringify(msg)}`, "ws");
  }
}

export function connectWs(): void {
  stopped = false;
  const st = useStore.getState();
  st.setConnection("connecting");
  const ws = new WebSocket(wsUrl());
  socket = ws;
  ws.onopen = () => {
    retryMs = 500;
  };
  ws.onmessage = (ev) => {
    try {
      handleMessage(JSON.parse(String(ev.data)) as WsMessage);
    } catch {
      useStore.getState().log("warn", `unparsable ws message: ${String(ev.data).slice(0, 80)}`, "ws");
    }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    useStore.getState().setConnection("closed");
    if (stopped) return;
    setTimeout(connectWs, retryMs);
    retryMs = Math.min(retryMs * 2, 5000);
  };
  ws.onerror = () => {
    /* onclose が続くので何もしない */
  };
}

export function disconnectWs(): void {
  stopped = true;
  socket?.close();
}
