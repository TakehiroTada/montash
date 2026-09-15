/**
 * `.montash/history/` の物理レイヤ（docs/05 §1, docs/11 §3.1）。
 *
 * - ops.jsonl / commits.jsonl / moves.jsonl は追記専用（appendFile）
 * - objects/<sha1>.json は内容アドレスで重複排除（既にあれば書かない）
 * - HEAD / tags.json は tmp → rename で置き換える
 *
 * ここでは DAG の解釈はせず、ファイルの読み書きと採番だけを行う。
 */

import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ExitCode, MontashError } from "../../cli/errors.ts";
import { canonicalHash, type HashFn } from "./hash.ts";
import type { Commit, Move, Op, ResetState, TagMap } from "./types.ts";

export const HISTORY_DIR = join(".montash", "history");

export interface HistoryStoreOptions {
  /** スナップショットの内容ハッシュ。既定は canonicalHash */
  hash?: HashFn;
  /** 現在時刻（テストで差し替え可能） */
  now?: () => string;
}

/** ID を `o_0001` のように 4 桁以上ゼロ埋めで採番する */
export function formatId(prefix: "o_" | "k_", n: number): string {
  return `${prefix}${String(n).padStart(4, "0")}`;
}

export class HistoryStore {
  readonly projectDir: string;
  readonly dir: string;
  readonly hash: HashFn;
  readonly now: () => string;

  private constructor(projectDir: string, opts: HistoryStoreOptions) {
    this.projectDir = projectDir;
    this.dir = join(projectDir, HISTORY_DIR);
    this.hash = opts.hash ?? canonicalHash;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** 開く。無ければディレクトリと空ファイルを作る */
  static async open(projectDir: string, opts: HistoryStoreOptions = {}): Promise<HistoryStore> {
    const store = new HistoryStore(projectDir, opts);
    await mkdir(join(store.dir, "objects"), { recursive: true });
    await Promise.all([
      ensureFile(store.path("HEAD"), ""),
      ensureFile(store.path("ops.jsonl"), ""),
      ensureFile(store.path("commits.jsonl"), ""),
      ensureFile(store.path("moves.jsonl"), ""),
      ensureFile(store.path("tags.json"), "{}\n"),
      ensureFile(store.path("reset.json"), `${JSON.stringify(EMPTY_RESET, null, 2)}\n`),
    ]);
    return store;
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  // ---- objects ----

  objectPath(hash: string): string {
    const hex = hash.includes(":") ? hash.slice(hash.indexOf(":") + 1) : hash;
    if (!/^[A-Za-z0-9_-]+$/.test(hex)) {
      throw new MontashError("E_HISTORY_CORRUPT", `invalid object hash: ${hash}`);
    }
    return join(this.dir, "objects", `${hex}.json`);
  }

  async hasObject(hash: string): Promise<boolean> {
    return exists(this.objectPath(hash));
  }

  /** 内容アドレスで保存し、ハッシュを返す。既にあれば書かない */
  async putObject(value: unknown): Promise<string> {
    const hash = this.hash(value);
    const path = this.objectPath(hash);
    if (await exists(path)) return hash;
    await atomicWrite(path, JSON.stringify(value));
    return hash;
  }

  async getObject(hash: string): Promise<unknown> {
    const path = this.objectPath(hash);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      throw new MontashError("E_HISTORY_OBJECT_NOT_FOUND", `history object ${hash} is missing`, {
        hint: "Run `montash history verify` to inspect the history. The object may have been pruned or deleted manually.",
        detail: { hash, path },
        exitCode: ExitCode.IO,
        cause: err,
      });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new MontashError("E_HISTORY_CORRUPT", `history object ${hash} is not valid JSON`, {
        detail: { hash, path },
        cause: err,
      });
    }
  }

  /** objects/ にあるハッシュ一覧（`sha1:...` 形式で返す） */
  async listObjects(): Promise<string[]> {
    const dir = join(this.dir, "objects");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith(".json")).map((n) => `sha1:${n.slice(0, -".json".length)}`);
  }

  /** object を物理削除する（`history prune` のみが使う。docs/11 §4.5） */
  async removeObject(hash: string): Promise<void> {
    await rm(this.objectPath(hash), { force: true });
  }

  // ---- 追記専用ログ ----

  async readOps(): Promise<Op[]> {
    return readJsonl<Op>(this.path("ops.jsonl"));
  }

  async readCommits(): Promise<Commit[]> {
    return readJsonl<Commit>(this.path("commits.jsonl"));
  }

  async readMoves(): Promise<Move[]> {
    return readJsonl<Move>(this.path("moves.jsonl"));
  }

  /**
   * op を追記する。`id` は既存 ID の最大値 + 1（`o_0001`...）。
   * `history prune` で行が減っても ID を再利用しないよう、行数ではなく最大値で採番する。
   */
  async appendOp(op: Omit<Op, "id">): Promise<Op> {
    const [ops, counters] = await Promise.all([this.readOps(), this.readCounters()]);
    const next = Math.max(maxIdNumber(ops.map((o) => o.id)), counters.op) + 1;
    const full: Op = { id: formatId("o_", next), ...op };
    await appendFile(this.path("ops.jsonl"), `${JSON.stringify(full)}\n`);
    return full;
  }

  /** commit を追記する（`k_0001`...）。採番規則は appendOp と同じ */
  async appendCommit(commit: Omit<Commit, "id">): Promise<Commit> {
    const [commits, counters] = await Promise.all([this.readCommits(), this.readCounters()]);
    const next = Math.max(maxIdNumber(commits.map((c) => c.id)), counters.commit) + 1;
    const full: Commit = { id: formatId("k_", next), ...commit };
    await appendFile(this.path("commits.jsonl"), `${JSON.stringify(full)}\n`);
    return full;
  }

  /** ops.jsonl / moves.jsonl を書き直す（`history prune` と `history import` のみが使う） */
  async writeOps(ops: readonly Op[]): Promise<void> {
    await atomicWrite(this.path("ops.jsonl"), ops.map((o) => `${JSON.stringify(o)}\n`).join(""));
  }

  async writeCommits(commits: readonly Commit[]): Promise<void> {
    await atomicWrite(this.path("commits.jsonl"), commits.map((c) => `${JSON.stringify(c)}\n`).join(""));
  }

  async writeMoves(moves: readonly Move[]): Promise<void> {
    await atomicWrite(this.path("moves.jsonl"), moves.map((m) => `${JSON.stringify(m)}\n`).join(""));
  }

  async appendMove(move: Move): Promise<Move> {
    await appendFile(this.path("moves.jsonl"), `${JSON.stringify(move)}\n`);
    return move;
  }

  // ---- tags ----

  async readTags(): Promise<TagMap> {
    const path = this.path("tags.json");
    const text = await readFile(path, "utf8");
    if (text.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new MontashError("E_HISTORY_CORRUPT", "tags.json is not valid JSON", { detail: { path }, cause: err });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MontashError("E_HISTORY_CORRUPT", "tags.json must be an object", { detail: { path } });
    }
    return parsed as TagMap;
  }

  async writeTags(tags: TagMap): Promise<void> {
    await atomicWrite(this.path("tags.json"), `${JSON.stringify(tags, null, 2)}\n`);
  }

  // ---- counters（prune で行が減っても ID を再利用しないための高水位。docs/11 §4.5） ----

  async readCounters(): Promise<{ op: number; commit: number }> {
    try {
      const raw = JSON.parse(await readFile(this.path("counters.json"), "utf8")) as Record<string, unknown>;
      return { op: Number(raw.op) || 0, commit: Number(raw.commit) || 0 };
    } catch {
      return { op: 0, commit: 0 };
    }
  }

  async writeCounters(counters: { op: number; commit: number }): Promise<void> {
    await atomicWrite(this.path("counters.json"), `${JSON.stringify(counters, null, 2)}\n`);
  }

  // ---- reset（`reset --hard` で log の既定表示から外す op 集合。docs/11 §4.3） ----

  async readReset(): Promise<ResetState> {
    const path = this.path("reset.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return { ...EMPTY_RESET };
    }
    if (text.trim() === "") return { ...EMPTY_RESET };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new MontashError("E_HISTORY_CORRUPT", "reset.json is not valid JSON", { detail: { path }, cause: err });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MontashError("E_HISTORY_CORRUPT", "reset.json must be an object", { detail: { path } });
    }
    const raw = parsed as Partial<ResetState>;
    return {
      ignored: Array.isArray(raw.ignored) ? raw.ignored.filter((x): x is string => typeof x === "string") : [],
      entries: Array.isArray(raw.entries) ? raw.entries : [],
    };
  }

  async writeReset(state: ResetState): Promise<void> {
    await atomicWrite(this.path("reset.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  // ---- HEAD ----

  async getHead(): Promise<string | null> {
    const text = (await readFile(this.path("HEAD"), "utf8")).trim();
    return text === "" ? null : text;
  }

  async setHead(opId: string): Promise<void> {
    await atomicWrite(this.path("HEAD"), `${opId}\n`);
  }
}

// ---- ヘルパ ----

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureFile(path: string, initial: string): Promise<void> {
  if (!(await exists(path))) await writeFile(path, initial, { flag: "wx" }).catch(() => undefined);
}

let tmpSeq = 0;

/** tmp に書いてから rename（途中で落ちても壊れたファイルを残さない）。tmp 名はプロセス内で一意 */
async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

const EMPTY_RESET: ResetState = { ignored: [], entries: [] };

/** `o_0042` 形式の ID 列から最大の数値を返す（空なら 0） */
function maxIdNumber(ids: readonly string[]): number {
  let max = 0;
  for (const id of ids) {
    const n = Number.parseInt(id.slice(2), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** JSONL を読む。壊れた行は E_HISTORY_CORRUPT（ファイルと行番号を detail に） */
async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  const out: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch (err) {
      throw new MontashError("E_HISTORY_CORRUPT", `${path}:${i + 1} is not valid JSON`, {
        hint: "The history log is append-only and should not be edited by hand. Restore the file from a backup or remove the broken line.",
        detail: { path, line: i + 1 },
        cause: err,
      });
    }
  }
  return out;
}
