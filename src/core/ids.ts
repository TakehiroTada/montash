/**
 * 要素 ID の採番（docs/05 §2.3, docs/04 §1.4, ADR-13）。
 *
 * カウンタは `.montash/ids.json` に置き、`project.json`（履歴対象）には含めない。
 * `counters[prefix]` は「次に発行する番号」。`rebuildIds()` は現在の project と履歴 object から
 * 各プレフィックスの最大値 +1 に復元する。
 *
 * 並行呼び出し: 同一プロセス内はディレクトリごとの Promise チェーンで直列化し、
 * プロセス間は `ids.json.lock`（O_EXCL）で排他する。
 */
import { open, readFile, rm } from "node:fs/promises";
import { basename, extname } from "node:path";
import { MontashError } from "../cli/errors.ts";
import { atomicWrite, loadProject, projectPaths } from "./project.ts";
import type { Project } from "./schema.ts";

/** 採番対象のプレフィックス（クリップ / トランジション / テキスト / 字幕 / ダッキング） */
export const ID_PREFIXES = ["c", "t", "x", "s", "d"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export interface IdsFile {
  counters: Record<string, number>;
}

const ID_PATTERN = /^([a-z])(\d+)$/;

function isKnownPrefix(p: string): p is IdPrefix {
  return (ID_PREFIXES as readonly string[]).includes(p);
}

// ---------------------------------------------------------------------------
// 読み書き
// ---------------------------------------------------------------------------

/** ids.json を読む。無い・壊れている場合は null */
export async function readIds(dir: string): Promise<IdsFile | null> {
  const { idsFile } = projectPaths(dir);
  let text: string;
  try {
    text = await readFile(idsFile, "utf8");
  } catch {
    return null;
  }
  try {
    const raw = JSON.parse(text) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const counters = (raw as { counters?: unknown }).counters;
    if (typeof counters !== "object" || counters === null) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(counters as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isSafeInteger(v) && v >= 1) out[k] = v;
    }
    return { counters: out };
  } catch {
    return null;
  }
}

export async function writeIds(dir: string, ids: IdsFile): Promise<void> {
  const { idsFile } = projectPaths(dir);
  const counters: Record<string, number> = {};
  for (const k of Object.keys(ids.counters).sort()) counters[k] = ids.counters[k]!;
  await atomicWrite(idsFile, JSON.stringify({ counters }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// ID の収集
// ---------------------------------------------------------------------------

/** 任意の JSON 値を走査し、`id` フィールドのうち採番対象パターン（c7, t3 ...）に合うものを集める */
export function collectNumberedIds(value: unknown, out: Map<string, number> = new Map()): Map<string, number> {
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const v of value) collectNumberedIds(v, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  const id = obj.id;
  if (typeof id === "string") {
    const m = ID_PATTERN.exec(id);
    if (m && isKnownPrefix(m[1]!)) {
      const n = Number.parseInt(m[2]!, 10);
      const cur = out.get(m[1]!) ?? 0;
      if (n > cur) out.set(m[1]!, n);
    }
  }
  for (const v of Object.values(obj)) collectNumberedIds(v, out);
  return out;
}

/** 現在の project に存在する全要素 ID（クリップ・トランジション・ダッキング・アセット・トラック） */
export function existingIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const t of project.tracks) {
    ids.add(t.id);
    for (const c of t.clips) ids.add(c.id);
  }
  for (const tr of project.transitions) ids.add(tr.id);
  for (const d of project.audio.ducking) ids.add(d.id);
  for (const a of Object.keys(project.assets)) ids.add(a);
  return ids;
}

/** `--id` で明示指定された ID が現在の project に存在すれば E_ID_EXISTS */
export function assertIdAvailable(project: Project, id: string): void {
  if (existingIds(project).has(id)) {
    throw new MontashError("E_ID_EXISTS", `id "${id}" already exists in project.json`, {
      hint: "Choose another --id, or omit --id to let montash assign one.",
      detail: { id },
    });
  }
}

// ---------------------------------------------------------------------------
// 採番
// ---------------------------------------------------------------------------

/**
 * ids.json を現在の project と履歴 object 群から再構築する（各プレフィックスの最大値 +1）。
 * 既存の ids.json の値がそれより大きければそちらを維持する（巻き戻さない）。
 */
export async function rebuildIds(dir: string, project: Project, historyObjects: Iterable<unknown> = []): Promise<IdsFile> {
  const max = collectNumberedIds(project);
  for (const obj of historyObjects) collectNumberedIds(obj, max);
  const existing = await readIds(dir);
  const counters: Record<string, number> = {};
  for (const p of ID_PREFIXES) counters[p] = Math.max(existing?.counters[p] ?? 1, (max.get(p) ?? 0) + 1);
  for (const [p, n] of max) if (!(p in counters)) counters[p] = n + 1;
  const ids = { counters };
  await writeIds(dir, ids);
  return ids;
}

/** ディレクトリごとの直列化キュー（同一プロセス内） */
const queues = new Map<string, Promise<unknown>>();

async function withIdsLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const paths = projectPaths(dir);
  const prev = queues.get(paths.root) ?? Promise.resolve();
  const run = prev.then(
    () => withFileLock(`${paths.idsFile}.lock`, fn),
    () => withFileLock(`${paths.idsFile}.lock`, fn),
  );
  queues.set(paths.root, run);
  try {
    return await run;
  } finally {
    if (queues.get(paths.root) === run) queues.delete(paths.root);
  }
}

/** O_EXCL でロックファイルを作る。取れなければ短い待機で再試行（最大 ~5 秒） */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.close();
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new MontashError("E_IO", `cannot create lock ${lockPath}: ${String(e)}`, { cause: e });
      }
      if (Date.now() > deadline) {
        throw new MontashError("E_IO", `timed out waiting for ${lockPath}`, { hint: "Remove the stale lock file if no other montash process is running." });
      }
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

/**
 * 次の ID を発行する（`c7` など）。ids.json が無い／壊れている場合は project.json から自動再構築する。
 */
export async function nextId(dir: string, prefix: IdPrefix | string): Promise<string> {
  return withIdsLock(dir, async () => {
    let ids = await readIds(dir);
    if (!ids) {
      const project = await loadProject(dir).catch(() => null);
      ids = project ? await rebuildIds(dir, project) : { counters: {} };
    }
    const n = ids.counters[prefix] ?? 1;
    ids.counters[prefix] = n + 1;
    await writeIds(dir, ids);
    return `${prefix}${n}`;
  });
}

/** 連続して複数発行する（1 回のロックで済ませる） */
export async function nextIds(dir: string, prefix: IdPrefix | string, count: number): Promise<string[]> {
  if (count <= 0) return [];
  return withIdsLock(dir, async () => {
    let ids = await readIds(dir);
    if (!ids) {
      const project = await loadProject(dir).catch(() => null);
      ids = project ? await rebuildIds(dir, project) : { counters: {} };
    }
    const start = ids.counters[prefix] ?? 1;
    ids.counters[prefix] = start + count;
    await writeIds(dir, ids);
    return Array.from({ length: count }, (_, i) => `${prefix}${start + i}`);
  });
}

// ---------------------------------------------------------------------------
// アセット ID（ファイル名 slug。カウンタ対象外）
// ---------------------------------------------------------------------------

/**
 * ファイル名から slug を作る: 拡張子除去・小文字・英数と `_` 以外は `_`・先頭が数字なら `a_` を付ける。
 * 既存と衝突すれば `_2`, `_3`, ...
 */
export function slugAssetId(filename: string, existing: Set<string> | ReadonlySet<string> = new Set()): string {
  const base = basename(filename);
  const stem = extname(base) ? base.slice(0, -extname(base).length) : base;
  let slug = stem
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  if (slug.length === 0) slug = "asset";
  if (/^[0-9]/.test(slug)) slug = `a_${slug}`;
  if (!existing.has(slug)) return slug;
  for (let i = 2; ; i++) {
    const cand = `${slug}_${i}`;
    if (!existing.has(cand)) return cand;
  }
}
