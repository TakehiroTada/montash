/**
 * 読み取り API クライアント（docs/06 §3.2）。取得結果はストアに入れる。
 */
import { type HistoryLike, type ProjectLike, type StatusLike, useStore } from "./store.ts";

async function getJson<T>(
  path: string,
): Promise<{ ok: true; data: T; etag: string | null } | { ok: false; status: number; error: unknown }> {
  const res = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) {
    let error: unknown = null;
    try {
      error = await res.json();
    } catch {
      /* 本文無し */
    }
    return { ok: false, status: res.status, error };
  }
  return { ok: true, data: (await res.json()) as T, etag: res.headers.get("etag") };
}

export async function refreshProject(): Promise<void> {
  const r = await getJson<ProjectLike>("/api/project");
  const st = useStore.getState();
  if (r.ok) st.setProject(r.data, r.etag);
  else if (r.status === 404) st.setProject(null, null);
  else st.log("error", `GET /api/project failed (${r.status})`);
}

export async function refreshStatus(): Promise<void> {
  const r = await getJson<StatusLike>("/api/status");
  if (r.ok) useStore.getState().setStatus(r.data);
}

export async function refreshHistory(): Promise<void> {
  const r = await getJson<HistoryLike>("/api/history");
  if (r.ok) useStore.getState().setHistory(r.data);
}

export async function refreshAllowlist(): Promise<void> {
  const r = await getJson<{ allowlist: string[] }>("/api/cli/allowlist");
  if (r.ok) useStore.getState().setAllowlist(r.data.allowlist);
}

export async function refreshAll(): Promise<void> {
  await Promise.all([refreshProject(), refreshStatus(), refreshHistory(), refreshAllowlist()]);
}
