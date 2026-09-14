/**
 * zustand 単一ストア（docs/06 §4）。
 * canvas 側は React の再レンダーを経由せず `useStore.getState()` / `subscribe` で読む。
 *
 * project.json の構造は別担当が実装中のため、ここでは描画に必要な最小限のフィールドだけを
 * 緩い型で扱う（unknown を許容）。
 */
import { create } from "zustand";

export interface Fps {
  num: number;
  den: number;
}

export interface ClipLike {
  id: string;
  asset?: string;
  label?: string;
  start_f: number;
  in_f?: number;
  out_f?: number;
  speed?: number;
  [k: string]: unknown;
}

export interface TrackLike {
  id: string;
  kind?: "video" | "audio" | "text" | string;
  name?: string;
  muted?: boolean;
  clips?: ClipLike[];
  [k: string]: unknown;
}

export interface ProjectLike {
  name?: string;
  settings?: { fps?: Fps; resolution?: { width: number; height: number }; [k: string]: unknown };
  assets?: Record<string, unknown>;
  tracks?: TrackLike[];
  [k: string]: unknown;
}

export interface StatusLike {
  watching: boolean;
  watch_mode?: string | null;
  head: { op: string | null; commit?: string | null; pending?: number; detached?: boolean } | null;
  preview: { state: "missing" | "building" | "ready" | "stale"; progress?: number };
  server: { version: string; read_only: boolean; dev?: boolean };
}

export interface OpLike {
  id: string;
  at?: string;
  actor?: string;
  command?: string[];
  summary?: string;
  commit?: string | null;
  [k: string]: unknown;
}

export interface HistoryLike {
  head: string | null;
  ops: OpLike[];
  commits: Array<{ id: string; message?: string; at?: string; [k: string]: unknown }>;
  tags: Record<string, unknown>;
  moves: unknown[];
}

export type Connection = "connecting" | "open" | "closed";

export interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  actor?: string;
  message: string;
}

export interface Toast {
  id: number;
  level: "info" | "error";
  text: string;
}

export type SideTab = "inspector" | "assets" | "history";

export interface Selection {
  kind: "clip";
  id: string;
  trackId: string;
}

export interface State {
  project: ProjectLike | null;
  projectHash: string | null;
  status: StatusLike | null;
  history: HistoryLike | null;
  connection: Connection;
  playhead_f: number;
  selection: Selection | null;
  hoverClipId: string | null;
  tab: SideTab;
  logs: LogLine[];
  toasts: Toast[];
  allowlist: string[];

  setProject(p: ProjectLike | null, hash?: string | null): void;
  setStatus(s: StatusLike | null): void;
  setHistory(h: HistoryLike | null): void;
  setConnection(c: Connection): void;
  setPlayhead(f: number): void;
  setSelection(s: Selection | null): void;
  setHover(id: string | null): void;
  setTab(t: SideTab): void;
  setAllowlist(a: string[]): void;
  log(level: LogLine["level"], message: string, actor?: string): void;
  toast(level: Toast["level"], text: string): void;
  dismissToast(id: number): void;
}

let toastSeq = 0;

export const useStore = create<State>()((set) => ({
  project: null,
  projectHash: null,
  status: null,
  history: null,
  connection: "connecting",
  playhead_f: 0,
  selection: null,
  hoverClipId: null,
  tab: "inspector",
  logs: [],
  toasts: [],
  allowlist: [],

  setProject: (project, hash = null) => set({ project, projectHash: hash }),
  setStatus: (status) => set({ status }),
  setHistory: (history) => set({ history }),
  setConnection: (connection) => set({ connection }),
  setPlayhead: (playhead_f) => set({ playhead_f: Math.max(0, Math.floor(playhead_f)) }),
  setSelection: (selection) => set({ selection }),
  setHover: (hoverClipId) => set({ hoverClipId }),
  setTab: (tab) => set({ tab }),
  setAllowlist: (allowlist) => set({ allowlist }),
  log: (level, message, actor) =>
    set((s) => ({ logs: [...s.logs.slice(-499), { at: Date.now(), level, message, actor }] })),
  toast: (level, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, level, text }] }));
    setTimeout(() => useStore.getState().dismissToast(id), level === "error" ? 6000 : 3000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// ---- 派生値（純関数。canvas と React の両方から使う） ----

export const DEFAULT_FPS: Fps = { num: 30, den: 1 };

export function fpsOf(p: ProjectLike | null): Fps {
  const f = p?.settings?.fps;
  return f && f.num > 0 && f.den > 0 ? f : DEFAULT_FPS;
}

/** クリップの長さ（フレーム）。docs/05 §6.1: duration_f = max(1, round((out_f - in_f) / speed)) */
export function clipDuration(c: ClipLike): number {
  const inF = c.in_f ?? 0;
  const outF = c.out_f ?? inF;
  const speed = c.speed && c.speed > 0 ? c.speed : 1;
  return Math.max(1, Math.round((outF - inF) / speed));
}

export function clipEnd(c: ClipLike): number {
  return c.start_f + clipDuration(c);
}

/** タイムライン尺（全クリップの最大 end_f）。project.json 側の計算値が来るまでの暫定 */
export function timelineDuration(p: ProjectLike | null): number {
  let max = 0;
  for (const t of p?.tracks ?? []) for (const c of t.clips ?? []) max = Math.max(max, clipEnd(c));
  return max;
}

export function clipCount(p: ProjectLike | null): number {
  let n = 0;
  for (const t of p?.tracks ?? []) n += t.clips?.length ?? 0;
  return n;
}

/** 表示順: T*（上）→ V*（配列逆順）→ A*（下）。docs/06 §2.4 */
export function displayTracks(p: ProjectLike | null): TrackLike[] {
  const tracks = p?.tracks ?? [];
  const text = tracks.filter((t) => t.kind === "text");
  const video = tracks.filter((t) => t.kind === "video").reverse();
  const audio = tracks.filter((t) => t.kind === "audio");
  const other = tracks.filter((t) => t.kind !== "text" && t.kind !== "video" && t.kind !== "audio");
  return [...text, ...video, ...audio, ...other];
}

export function framesToSeconds(f: number, fps: Fps): number {
  return (f * fps.den) / fps.num;
}

/** HH:MM:SS.mmm */
export function formatTc(f: number, fps: Fps): string {
  const s = framesToSeconds(f, fps);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
}
