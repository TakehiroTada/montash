/** Read-only history view: GET requests never initialize or rewrite history files. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, canonicalHash, pathToRoot, tipOf } from "../core/history/index.ts";
import type { Commit, Move, Op, TagMap } from "../core/history/types.ts";
import { HISTORY_DIR } from "./watcher.ts";

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

function readLines<T>(path: string): T[] {
  const result: T[] = [];
  for (const line of readText(path).split("\n")) {
    if (!line.trim()) continue;
    try {
      result.push(JSON.parse(line) as T);
    } catch {
      /* A writer may still be appending its final line. */
    }
  }
  return result;
}

export function readHistoryView(dir: string, project?: unknown) {
  const historyDir = join(dir, HISTORY_DIR);
  const commits = readLines<Commit>(join(historyDir, "commits.jsonl"));
  const moves = readLines<Move>(join(historyDir, "moves.jsonl"));
  const commitOf = new Map<string, string>();
  for (const c of commits) for (const id of c.ops ?? []) commitOf.set(id, c.id);
  const ops = readLines<Op>(join(historyDir, "ops.jsonl")).map((op) => ({
    ...op,
    commit: commitOf.get(op.id) ?? null,
  }));
  const head = readText(join(historyDir, "HEAD")).trim() || null;
  let tags: TagMap = {};
  try {
    const value: unknown = JSON.parse(readText(join(historyDir, "tags.json")) || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) tags = value as TagMap;
  } catch {
    /* Keep the timeline visible if the tag file is temporarily unreadable. */
  }
  const index = buildIndex(ops);
  const headOp = head ? index.byId.get(head) : undefined;
  const pending: string[] = [];
  if (headOp) {
    for (const id of pathToRoot(index, headOp.id)) {
      if (commitOf.has(id)) break;
      pending.unshift(id);
    }
  }
  const tip = headOp ? tipOf(index, headOp.id, moves) : null;
  const state = headOp
    ? {
        op: headOp.id,
        commit: headOp.commit,
        pending: pending.length,
        detached: tip !== headOp.id,
        tip,
        ...(project === undefined ? {} : { dirty: canonicalHash(project) !== headOp.after }),
      }
    : null;
  return { history: { head, ops, commits, tags, moves }, state };
}
