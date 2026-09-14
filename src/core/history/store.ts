/**
 * `.montash/history/` の物理レイヤ（docs/05 §1, docs/11 §3.1）。
 *
 * - ops.jsonl / commits.jsonl / moves.jsonl は追記専用（appendFile）
 * - objects/<sha1>.json は内容アドレスで重複排除（既にあれば書かない）
 * - HEAD / tags.json は tmp → rename で置き換える
 *
 * ここでは DAG の解釈はせず、ファイルの読み書きと採番だけを行う。
 */

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MontashError, ExitCode } from "../../cli/errors.ts";
import { canonicalHash, type HashFn } from "./hash.ts";
import type { Commit, Move, Op, TagMap } from "./types.ts";

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
      throw new MontashError("E_HISTORY_CORRUPT", `history object ${hash} is not valid JSON`, { detail: { hash, path }, cause: err });
    }
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

  /** op を追記する。`id` は既存行数から採番（`o_0001`...） */
  async appendOp(op: Omit<Op, "id">): Promise<Op> {
    const count = await countLines(this.path("ops.jsonl"));
    const full: Op = { id: formatId("o_", count + 1), ...op };
    await appendFile(this.path("ops.jsonl"), `${JSON.stringify(full)}\n`);
    return full;
  }

  /** commit を追記する（`k_0001`...） */
  async appendCommit(commit: Omit<Commit, "id">): Promise<Commit> {
    const count = await countLines(this.path("commits.jsonl"));
    const full: Commit = { id: formatId("k_", count + 1), ...commit };
    await appendFile(this.path("commits.jsonl"), `${JSON.stringify(full)}\n`);
    return full;
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

async function countLines(path: string): Promise<number> {
  const text = await readFile(path, "utf8");
  let n = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") n++;
  return n;
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
