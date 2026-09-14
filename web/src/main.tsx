/**
 * フロントエンドのエントリ。React ルートを作り、WS 接続と初回取得を開始する。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { refreshAll } from "./api.ts";
import { connectWs } from "./ws.ts";

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void refreshAll();
connectWs();
