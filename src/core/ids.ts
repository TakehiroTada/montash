/**
 * 要素 ID の採番（docs/05 §2.3, docs/04 §1.4, ADR-13）。
 *
 * カウンタは `.montash/ids.json` に置き、`project.json`（履歴対象）には含めない。
 * `counters[prefix]` は「次に発行する番号」。`rebuildIds()` は現在の project と履歴 object から
 * 各プレフィックスの最大値 +1 に復元する。
 *
 * プレフィックスは 1 文字固定ではなく **登録制**（D-17）。組み込みの 5 種に加えて
 * `registerIdPrefix()` で多文字プレフィックス（`fx` など）を登録でき、登録されたものだけが
 * 収集・再構築の対象になる。登録されていない文字列（アセット slug の `clip_a` など）は
 * カウンタを汚さない。将来 `src/registry/` からプラグイン由来のプレフィックスを流し込めるよう、
 * 収集系の関数は明示的なプレフィックス集合も受け取れる。
 *
 * 並行呼び出し: 同一プロセス内はディレクトリごとの Promise チェーンで直列化し、
 * プロセス間は `ids.json.lock`（O_EXCL）で排他する。
 */
import { open, readFile, rm } from "node:fs/promises";
import { basename, extname } from "node:path";
import { MontashError } from "../cli/errors.ts";
import { atomicWrite, loadProject, projectPaths } from "./project.ts";
import type { Project } from "./schema.ts";

/** 組み込みの採番プレフィックス（クリップ / トランジション / テキスト / 字幕 / ダッキング） */
export const ID_PREFIXES = ["c", "t", "x", "s", "d"] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export interface IdsFile {
  counters: Record<string, number>;
}

/**
 * 採番 ID の形。英小文字で始まる多文字プレフィックス + 連番。
 * 数字列は最短一致でプレフィックスと分離するため、`c1` → `c`/`1`、`fx12` → `fx`/`12` になる。
 */
const ID_PATTERN = /^([a-z][a-z0-9]*?)(\d+)$/;

/** プレフィックスとして妥当な形（英小文字始まり・英小文字と数字・末尾は数字にできない） */
const PREFIX_PATTERN = /^[a-z]([a-z0-9]*[a-z])?$/;

/** 組み込み以外の登録済みプレフィックス（モジュールレベル。プロセス内で共有） */
const extraPrefixes = new Set<string>();

/** プレフィックスとして使える文字列か（末尾が数字だと連番と区別できないので不可） */
export function isValidIdPrefix(prefix: string): boolean {
  return PREFIX_PATTERN.test(prefix);
}

/**
 * 採番プレフィックスを登録する。登録したものは `collectNumberedIds` / `rebuildIds` の走査対象になる。
 * 冪等。組み込みの 5 種は常に登録済み。
 */
export function registerIdPrefix(prefix: string): void {
  if (!isValidIdPrefix(prefix)) {
    throw new MontashError("E_USAGE", `invalid id prefix "${prefix}"`, {
      hint: "A prefix must start with a lowercase letter, contain only [a-z0-9] and not end with a digit.",
      detail: { prefix },
    });
  }
  if ((ID_PREFIXES as readonly string[]).includes(prefix)) return;
  extraPrefixes.add(prefix);
}

/** まとめて登録する（将来 registry から渡す口） */
export function registerIdPrefixes(prefixes: Iterable<string>): void {
  for (const p of prefixes) registerIdPrefix(p);
}

/** 登録済みプレフィックスの一覧（組み込み → 登録順） */
export function idPrefixes(): readonly string[] {
  return [...ID_PREFIXES, ...extraPrefixes];
}

/** 登録済みか */
export function isKnownIdPrefix(prefix: string): boolean {
  return (ID_PREFIXES as readonly string[]).includes(prefix) || extraPrefixes.has(prefix);
}

/** 登録を組み込みだけに戻す（テスト用） */
export function resetIdPrefixes(): void {
  extraPrefixes.clear();
}

/** 採番 ID を `{ prefix, n }` に分解する。形が合わなければ null（登録の有無は見ない） */
export function parseNumberedId(id: string): { prefix: string; n: number } | null {
  const m = ID_PATTERN.exec(id);
  if (!m) return null;
  const n = Number.parseInt(m[2]!, 10);
  if (!Number.isSafeInteger(n)) return null;
  return { prefix: m[1]!, n };
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
  await atomicWrite(idsFile, `${JSON.stringify({ counters }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// ID の収集
// ---------------------------------------------------------------------------

/**
 * 任意の JSON 値を走査し、`id` フィールドのうち **登録済みプレフィックス**の採番 ID
 * （`c7`, `t3`, `fx12` ...）について最大番号を集める。
 * `prefixes` を渡すと登録状態の代わりにその集合を使う（レジストリから明示的に渡す用）。
 */
export function collectNumberedIds(
  value: unknown,
  out: Map<string, number> = new Map(),
  prefixes: Iterable<string> = idPrefixes(),
): Map<string, number> {
  walkNumberedIds(value, out, prefixes instanceof Set ? prefixes : new Set(prefixes));
  return out;
}

function walkNumberedIds(value: unknown, out: Map<string, number>, known: ReadonlySet<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) walkNumberedIds(v, out, known);
    return;
  }
  const obj = value as Record<string, unknown>;
  const id = obj.id;
  if (typeof id === "string") {
    const parsed = parseNumberedId(id);
    if (parsed && known.has(parsed.prefix)) {
      const cur = out.get(parsed.prefix) ?? 0;
      if (parsed.n > cur) out.set(parsed.prefix, parsed.n);
    }
  }
  for (const v of Object.values(obj)) walkNumberedIds(v, out, known);
}

/**
 * 現在の project に存在する全要素 ID。
 * 既知のサブツリー（tracks / clips / transitions / ducking / assets）に限らず、
 * project.json の任意のサブツリー（プラグイン領域など）の `id` フィールドを再帰的に集める。
 * 履歴側の `collectIds`（core/history/history.ts）と同じ「`id` キーを汎用に探す」方針。
 */
export function existingIds(project: Project): Set<string> {
  const ids = new Set<string>();
  collectIdFields(project, ids);
  for (const a of Object.keys(project.assets)) ids.add(a);
  return ids;
}

function collectIdFields(value: unknown, out: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectIdFields(v, out);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "id") {
      if (typeof v === "string") out.add(v);
    } else {
      collectIdFields(v, out);
    }
  }
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
export async function rebuildIds(
  dir: string,
  project: Project,
  historyObjects: Iterable<unknown> = [],
  prefixes: Iterable<string> = idPrefixes(),
): Promise<IdsFile> {
  const existing = await readIds(dir);
  // 走査対象は「渡された／登録済みのプレフィックス」+「既存 ids.json に載っているプレフィックス」。
  // 後者を含めることで、未登録のプラグイン由来カウンタも巻き戻さずに済む。
  const known = new Set(prefixes);
  for (const p of Object.keys(existing?.counters ?? {})) if (isValidIdPrefix(p)) known.add(p);
  const max = collectNumberedIds(project, new Map(), known);
  for (const obj of historyObjects) collectNumberedIds(obj, max, known);
  const counters: Record<string, number> = {};
  for (const p of known) counters[p] = Math.max(existing?.counters[p] ?? 1, (max.get(p) ?? 0) + 1);
  for (const [p, n] of Object.entries(existing?.counters ?? {})) if (!(p in counters)) counters[p] = n;
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
        throw new MontashError("E_IO", `timed out waiting for ${lockPath}`, {
          hint: "Remove the stale lock file if no other montash process is running.",
        });
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
 * 次の ID を発行する（`c7` / `fx3` など）。ids.json が無い／壊れている場合は project.json から自動再構築する。
 * 発行したプレフィックスは自動的に登録され、以後の収集・再構築の対象になる。
 */
export async function nextId(dir: string, prefix: IdPrefix | string): Promise<string> {
  registerIdPrefix(prefix);
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
  registerIdPrefix(prefix);
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
