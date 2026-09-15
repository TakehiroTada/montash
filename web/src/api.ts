/**
 * 読み取り API クライアント（docs/06 §3.2）。取得結果はストアに入れる。
 */
import type { AssetView } from "./lib/assets.ts";
import type { Specs } from "./lib/specs.ts";
import { type HistoryLike, type ProjectLike, type StatusLike, useStore } from "./store.ts";

const versions = new Map<string, number>();

async function getJson<T>(
  path: string,
): Promise<{ ok: true; data: T; etag: string | null } | { ok: false; status: number; error: unknown } | null> {
  const version = (versions.get(path) ?? 0) + 1;
  versions.set(path, version);
  try {
    const res = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
    const data: unknown = await res.json().catch(() => null);
    // A newer refresh may have started while this request was in flight.
    if (versions.get(path) !== version) return null;
    if (!res.ok) return { ok: false, status: res.status, error: data };
    if (data === null) throw new Error("empty JSON response");
    return { ok: true, data: data as T, etag: res.headers.get("etag") };
  } catch (error) {
    if (versions.get(path) === version) useStore.getState().log("error", `GET ${path} failed: ${String(error)}`);
    return null;
  }
}

export async function refreshProject(): Promise<void> {
  const r = await getJson<ProjectLike>("/api/project");
  if (!r) return;
  const st = useStore.getState();
  if (r.ok) st.setProject(r.data, r.etag);
  else if (r.status === 404) st.setProject(null, null);
  else st.log("error", `GET /api/project failed (${r.status})`);
}

export async function refreshStatus(): Promise<void> {
  const r = await getJson<StatusLike>("/api/status");
  if (r?.ok) useStore.getState().setStatus(r.data);
}

export async function refreshHistory(): Promise<void> {
  const r = await getJson<HistoryLike>("/api/history");
  if (r?.ok) useStore.getState().setHistory(r.data);
}

export async function refreshAllowlist(): Promise<void> {
  const r = await getJson<{ allowlist: string[] }>("/api/cli/allowlist");
  if (r?.ok) useStore.getState().setAllowlist(r.data.allowlist);
}

/**
 * コマンド・エフェクトの定義（docs/06 §3.2）。Inspector のフォームはこれで組む。
 * 起動中は変わらないので、`refreshAll()` の 1 回だけ取りに行く（プロジェクト変更では再取得しない）。
 */
export async function refreshSpecs(): Promise<void> {
  const r = await getJson<Specs>("/api/specs");
  if (r?.ok) useStore.getState().setSpecs(r.data);
}

/** 素材一覧（usage / missing / derived 付き。docs/06 §3.2） */
export async function refreshAssets(): Promise<void> {
  const r = await getJson<{ assets: AssetView[] }>("/api/assets");
  if (!r) return;
  const st = useStore.getState();
  if (r.ok) st.setAssets(r.data.assets);
  else if (r.status === 404) st.setAssets([]);
}

export async function refreshAll(): Promise<void> {
  await Promise.all([
    refreshProject(),
    refreshStatus(),
    refreshHistory(),
    refreshAllowlist(),
    refreshSpecs(),
    refreshAssets(),
  ]);
}
