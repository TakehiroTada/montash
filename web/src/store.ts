/**
 * zustand 単一ストア（docs/06 §4）。
 * canvas 側は React の再レンダーを経由せず `useStore.getState()` / `subscribe` で読む。
 *
 * project.json の構造は別担当が実装中のため、ここでは描画に必要な最小限のフィールドだけを
 * 緩い型で扱う（unknown を許容）。
 */
import { create } from "zustand";
import type { AssetSort, AssetTypeFilter, AssetView } from "./lib/assets.ts";
import type { Specs } from "./lib/specs.ts";
import type { Fps, ProjectLike } from "./lib/timeline.ts";

// 派生値（純関数）は lib/timeline.ts が本体。既存の import 元を変えずに済むよう再エクスポートする
export type {
  ClipKind,
  ClipLike,
  ClipSpan,
  Computed,
  ComputedClip,
  Fps,
  ProjectLike,
  TrackLike,
} from "./lib/timeline.ts";
export {
  clipCount,
  clipDuration,
  clipEnd,
  clipKindOf,
  clipLabel,
  clipSpan,
  computedIndex,
  DEFAULT_FPS,
  displayTracks,
  EMPTY_SCALE_SECONDS,
  formatTc,
  fpsOf,
  framesToSeconds,
  LABEL_MAX_CHARS,
  secondsToFrames,
  TAIL_MARGIN_SECONDS,
  timelineDuration,
  timelineScaleFrames,
  timelineSpan,
  truncateLabel,
} from "./lib/timeline.ts";

export interface StatusLike {
  watching: boolean;
  watch_mode?: string | null;
  head: {
    op: string | null;
    commit?: string | null;
    pending?: number;
    detached?: boolean;
    /** 現在の系列の最新 op（`montash checkout tip` の移動先） */
    tip?: string | null;
  } | null;
  preview: {
    state: "missing" | "building" | "ready" | "stale";
    url?: string;
    duration_f?: number;
    fps?: Fps;
    progress?: number;
    error?: string;
  };
  server: { version: string; read_only: boolean; dev?: boolean };
}

export interface OpLike {
  id: string;
  parent?: string | null;
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
  tags: Record<string, { target: string; message?: string }>;
  moves: unknown[];
}

export type Connection = "connecting" | "open" | "closed";

export interface LogLine {
  at: number;
  level: "info" | "warn" | "error";
  actor?: string;
  message: string;
}

/** トーストに 1 つだけ付けられる操作（例: checkout の「元に戻す」。docs/13 D-8） */
export interface ToastAction {
  label: string;
  run(): void | Promise<void>;
}

export interface Toast {
  id: number;
  level: "info" | "error";
  text: string;
  action?: ToastAction;
}

export interface ToastOptions {
  action?: ToastAction;
  /** 自動で消えるまでの ms。既定は info 3000 / error 6000 */
  ttlMs?: number;
}

export type SideTab = "inspector" | "assets" | "history";

export interface Selection {
  kind: "clip";
  id: string;
  trackId: string;
}

/** 実行中のジョブ（WS の job.progress / job.done。docs/06 §3.4） */
export interface Job {
  id: string;
  kind: string;
  percent: number;
  message?: string;
  done?: boolean;
  ok?: boolean;
}

/** Assets タブの表示状態（docs/06 §2.6） */
export interface AssetsUi {
  view: "grid" | "list";
  type: AssetTypeFilter;
  query: string;
  sort: AssetSort;
}

export const DEFAULT_ASSETS_UI: AssetsUi = { view: "list", type: "all", query: "", sort: "name" };

export interface State {
  project: ProjectLike | null;
  projectHash: string | null;
  status: StatusLike | null;
  history: HistoryLike | null;
  connection: Connection;
  playhead_f: number;
  isPlaying: boolean;
  selection: Selection | null;
  hoverClipId: string | null;
  tab: SideTab;
  logs: LogLine[];
  toasts: Toast[];
  allowlist: string[];
  /** `GET /api/specs`: コマンド定義 + エフェクトのパラメータ定義（docs/06 §3.2） */
  specs: Specs | null;
  assets: AssetView[] | null;
  selectedAssetId: string | null;
  assetsUi: AssetsUi;
  jobs: Job[];

  setProject(p: ProjectLike | null, hash?: string | null): void;
  setAssets(a: AssetView[] | null): void;
  selectAsset(id: string | null): void;
  patchAssetsUi(patch: Partial<AssetsUi>): void;
  upsertJob(job: Job): void;
  setStatus(s: StatusLike | null): void;
  setHistory(h: HistoryLike | null): void;
  setConnection(c: Connection): void;
  setPlayhead(f: number): void;
  setPlaying(playing: boolean): void;
  setSelection(s: Selection | null): void;
  setHover(id: string | null): void;
  setTab(t: SideTab): void;
  setAllowlist(a: string[]): void;
  setSpecs(s: Specs | null): void;
  log(level: LogLine["level"], message: string, actor?: string): void;
  toast(level: Toast["level"], text: string, opts?: ToastOptions): void;
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
  isPlaying: false,
  selection: null,
  hoverClipId: null,
  tab: "inspector",
  logs: [],
  toasts: [],
  allowlist: [],
  specs: null,
  assets: null,
  selectedAssetId: null,
  assetsUi: DEFAULT_ASSETS_UI,
  jobs: [],

  setProject: (project, hash = null) => set({ project, projectHash: hash }),
  setAssets: (assets) =>
    set((s) => ({
      assets,
      // 消えた素材を選択したままにしない
      selectedAssetId:
        s.selectedAssetId && assets && !assets.some((a) => a.id === s.selectedAssetId) ? null : s.selectedAssetId,
    })),
  selectAsset: (selectedAssetId) => set({ selectedAssetId }),
  patchAssetsUi: (patch) => set((s) => ({ assetsUi: { ...s.assetsUi, ...patch } })),
  upsertJob: (job) =>
    set((s) => {
      const jobs = s.jobs.some((j) => j.id === job.id)
        ? s.jobs.map((j) => (j.id === job.id ? { ...j, ...job } : j))
        : [...s.jobs, job];
      // 完了したジョブは 1 件だけ残して畳む（ログには別途出ている）
      return { jobs: jobs.filter((j) => !j.done).concat(jobs.filter((j) => j.done).slice(-1)) };
    }),
  setStatus: (status) => set({ status }),
  setHistory: (history) => set({ history }),
  setConnection: (connection) => set({ connection }),
  setPlayhead: (playhead_f) => set({ playhead_f: Math.max(0, Math.floor(playhead_f)) }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setSelection: (selection) => set({ selection }),
  setHover: (hoverClipId) => set({ hoverClipId }),
  setTab: (tab) => set({ tab }),
  setAllowlist: (allowlist) => set({ allowlist }),
  setSpecs: (specs) => set({ specs }),
  log: (level, message, actor) =>
    set((s) => ({ logs: [...s.logs.slice(-499), { at: Date.now(), level, message, actor }] })),
  toast: (level, text, opts = {}) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, level, text, action: opts.action }] }));
    setTimeout(() => useStore.getState().dismissToast(id), opts.ttlMs ?? (level === "error" ? 6000 : 3000));
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
