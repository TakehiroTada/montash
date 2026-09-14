/**
 * ファイル監視（docs/08 §2 watcher.ts, docs/12 ADR-05）。
 *
 * 監視対象は `project.json` と `.montash/history/{ops,moves}.jsonl` の 3 ファイル。
 * バックエンドは 2 つ:
 *   - chokidar 4（既定。`awaitWriteFinish` で tmp → rename の原子的保存も検知）
 *   - poll（`Bun.file(path).lastModified` / size / 内容ハッシュを 500ms 間隔で比較。WSL の /mnt/ 配下では自動選択）
 */
import chokidar from "chokidar";
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, join, resolve } from "node:path";

export type WatchMode = "chokidar" | "poll" | "auto";

export type WatchTarget = "project" | "ops" | "moves";

export interface WatchEvent {
  target: WatchTarget;
  path: string;
}

export interface Watcher {
  readonly mode: Exclude<WatchMode, "auto">;
  close(): Promise<void>;
}

export interface WatcherOptions {
  projectDir: string;
  mode?: WatchMode;
  onEvent: (ev: WatchEvent) => void;
  /** poll の間隔（ms） */
  pollIntervalMs?: number;
}

export const HISTORY_DIR = join(".montash", "history");

export function watchTargets(projectDir: string): Record<WatchTarget, string> {
  return {
    project: join(projectDir, "project.json"),
    ops: join(projectDir, HISTORY_DIR, "ops.jsonl"),
    moves: join(projectDir, HISTORY_DIR, "moves.jsonl"),
  };
}

/** project.json 内容の sha1（WS `project.changed.hash`）。読めなければ null */
export function hashProjectFile(path: string): string | null {
  try {
    const buf = readFileSync(path);
    return "sha1:" + new Bun.CryptoHasher("sha1").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export function isWsl(): boolean {
  if (platform() !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** WSL の /mnt/ 配下（Windows ファイルシステム）は inotify が効かないためポーリング */
export function chooseMode(projectDir: string, requested: WatchMode = "auto"): Exclude<WatchMode, "auto"> {
  if (requested !== "auto") return requested;
  if (isWsl() && resolve(projectDir).startsWith("/mnt/")) return "poll";
  return "chokidar";
}

export async function createWatcher(opts: WatcherOptions): Promise<Watcher> {
  const mode = chooseMode(opts.projectDir, opts.mode);
  return mode === "poll" ? createPollWatcher(opts) : createChokidarWatcher(opts);
}

function targetOf(targets: Record<WatchTarget, string>, path: string): WatchTarget | null {
  const abs = resolve(path);
  for (const [k, v] of Object.entries(targets) as Array<[WatchTarget, string]>) {
    if (resolve(v) === abs) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// chokidar 4
// ---------------------------------------------------------------------------

async function createChokidarWatcher(opts: WatcherOptions): Promise<Watcher> {
  const targets = watchTargets(opts.projectDir);
  // project.json はファイル単位、履歴は .montash ディレクトリを depth 1 で監視する（history/ が後から作られても拾える）。
  // 派生物（cache / preview / objects）は監視しない。
  const montashDir = join(opts.projectDir, ".montash");
  const w = chokidar.watch([targets.project, montashDir], {
    ignoreInitial: true,
    depth: 1,
    ignored: (p, stats) => {
      if (stats?.isFile()) return targetOf(targets, p) === null;
      const name = basename(p);
      return name === "cache" || name === "preview" || name === "objects" || name === "tmp" || name === "logs" || name === "render";
    },
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  });
  w.on("all", (ev, p) => {
    if (ev !== "add" && ev !== "change") return;
    const target = targetOf(targets, p);
    if (target) opts.onEvent({ target, path: p });
  });
  await new Promise<void>((res, rej) => {
    w.once("ready", () => res());
    w.once("error", (e) => rej(e));
  });
  return { mode: "chokidar", close: () => w.close() };
}

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

interface Stamp {
  exists: boolean;
  mtime: number;
  size: number;
  hash: string | null;
}

async function stamp(path: string, withHash: boolean): Promise<Stamp> {
  const f = Bun.file(path);
  if (!(await f.exists())) return { exists: false, mtime: 0, size: 0, hash: null };
  return { exists: true, mtime: f.lastModified, size: f.size, hash: withHash ? hashProjectFile(path) : null };
}

function changed(a: Stamp, b: Stamp): boolean {
  return a.exists !== b.exists || a.mtime !== b.mtime || a.size !== b.size || a.hash !== b.hash;
}

async function createPollWatcher(opts: WatcherOptions): Promise<Watcher> {
  const targets = watchTargets(opts.projectDir);
  const entries = Object.entries(targets) as Array<[WatchTarget, string]>;
  const last = new Map<WatchTarget, Stamp>();
  for (const [k, p] of entries) last.set(k, await stamp(p, k === "project"));
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      for (const [k, p] of entries) {
        const now = await stamp(p, k === "project");
        const prev = last.get(k);
        if (prev && changed(prev, now)) {
          last.set(k, now);
          if (now.exists) opts.onEvent({ target: k, path: p });
        }
      }
    } finally {
      busy = false;
    }
  }, opts.pollIntervalMs ?? 500);
  return {
    mode: "poll",
    async close() {
      clearInterval(timer);
    },
  };
}
