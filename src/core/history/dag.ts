/**
 * op DAG の純関数（docs/11 §3.4）。ファイル I/O はしない。
 *
 * - `buildIndex`: id → op、parent → children
 * - `tipOf`: 系列の先端。分岐は「最後に HEAD だった子」を優先（moves.jsonl と ops の並びから判断）
 * - `resolveRef`: `o_xxxx` / `k_xxxx` / タグ名 / `HEAD` / `tip` / `<ref>~n`
 */

import { MontashError } from "../../cli/errors.ts";
import type { Commit, Move, Op, TagMap } from "./types.ts";

export interface OpIndex {
  byId: Map<string, Op>;
  /** parent id → 子 id（ops.jsonl の出現順） */
  children: Map<string, string[]>;
  /** parent が null の op */
  roots: string[];
  /** ops.jsonl 上の順番（0 始まり） */
  order: Map<string, number>;
}

export function buildIndex(ops: Op[]): OpIndex {
  const byId = new Map<string, Op>();
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const order = new Map<string, number>();
  ops.forEach((op, i) => {
    byId.set(op.id, op);
    order.set(op.id, i);
    if (op.parent === null) {
      roots.push(op.id);
    } else {
      const list = children.get(op.parent);
      if (list) list.push(op.id);
      else children.set(op.parent, [op.id]);
    }
  });
  return { byId, children, roots, order };
}

export function childrenOf(index: OpIndex, opId: string): string[] {
  return index.children.get(opId) ?? [];
}

/** opId から根まで（自身を含む）。存在しない id を含むと途中で止まる */
export function pathToRoot(index: OpIndex, opId: string): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = opId;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    const op = index.byId.get(cur);
    cur = op ? op.parent : null;
  }
  return path;
}

/** 祖先（自身を含まない）。近い順 */
export function ancestors(index: OpIndex, opId: string): string[] {
  return pathToRoot(index, opId).slice(1);
}

/** a が b の真の祖先か */
export function isAncestor(index: OpIndex, a: string, b: string): boolean {
  if (a === b) return false;
  return ancestors(index, b).includes(a);
}

/** opId 以下の部分木（自身を含む） */
export function descendants(index: OpIndex, opId: string): Set<string> {
  const out = new Set<string>();
  const stack = [opId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const c of childrenOf(index, cur)) stack.push(c);
  }
  return out;
}

/**
 * HEAD がどの op にいたかの履歴を時系列に並べる。
 * op の作成（HEAD = その op）と moves（HEAD = move.to）を、
 * move.last_op（移動時点で最後に存在した op）を使って時計に依存せず並べる。
 */
export function headEvents(index: OpIndex, moves: Move[]): string[] {
  type Ev = { id: string; key: number; seq: number };
  const events: Ev[] = [];
  let seq = 0;
  for (const [id, i] of index.order) events.push({ id, key: i * 2, seq: seq++ });
  for (const m of moves) {
    // last_op の直後（同じ last_op の move 同士はファイル順）
    const i = m.last_op === null ? -1 : (index.order.get(m.last_op) ?? -1);
    events.push({ id: m.to, key: i * 2 + 1, seq: seq++ });
  }
  events.sort((a, b) => a.key - b.key || a.seq - b.seq);
  return events.map((e) => e.id);
}

export interface ChildChoice {
  chosen: string | null;
  candidates: string[];
}

/**
 * 子が複数あるときに進む先を決める。「最後に HEAD だった系列」の子を優先し、
 * 判断材料が無ければ最後に作られた子。
 */
export function preferredChild(index: OpIndex, opId: string, moves: Move[]): ChildChoice {
  const candidates = childrenOf(index, opId);
  if (candidates.length === 0) return { chosen: null, candidates };
  if (candidates.length === 1) return { chosen: candidates[0] as string, candidates };
  const events = headEvents(index, moves);
  let best: { id: string; at: number } | null = null;
  for (const child of candidates) {
    const subtree = descendants(index, child);
    for (let i = events.length - 1; i >= 0; i--) {
      if (subtree.has(events[i] as string)) {
        if (best === null || i > best.at) best = { id: child, at: i };
        break;
      }
    }
  }
  return { chosen: best ? best.id : (candidates[candidates.length - 1] as string), candidates };
}

/** 系列の先端。子を辿り、分岐は preferredChild で選ぶ */
export function tipOf(index: OpIndex, opId: string, moves: Move[]): string {
  let cur = opId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const next = preferredChild(index, cur, moves).chosen;
    if (next === null) return cur;
    cur = next;
  }
  return cur;
}

// ---- 参照解決 ----

export interface RefContext {
  ops: Op[];
  commits: Commit[];
  tags: TagMap;
  head: string | null;
  moves?: Move[];
  index?: OpIndex;
}

export interface ResolvedRef {
  /** 解決先の op id */
  op: string;
  via: "op" | "commit" | "tag" | "HEAD" | "tip";
  /** `k_xxxx` を経由した場合のコミット id */
  commit?: string;
  /** タグ名を経由した場合 */
  tag?: string;
  /** `~n` で遡った数 */
  back: number;
}

const OP_ID = /^o_\d{4,}$/;
const COMMIT_ID = /^k_\d{4,}$/;
export const RESERVED_REFS = new Set(["HEAD", "tip"]);

/** タグ名として使えるか（予約語・ID 形式・`~` を含まない） */
export function isValidTagName(name: string): boolean {
  return name.length > 0 && !RESERVED_REFS.has(name) && !OP_ID.test(name) && !COMMIT_ID.test(name) && !/[~\s/]/.test(name);
}

/**
 * 参照を op id に解決する。
 * `o_xxxx` / `k_xxxx`（→ commit.head）/ タグ名 / `HEAD` / `tip` / `<ref>~n`（`~` のみは 1）
 */
export function resolveRef(ref: string, ctx: RefContext): ResolvedRef {
  const index = ctx.index ?? buildIndex(ctx.ops);
  const moves = ctx.moves ?? [];
  const trimmed = ref.trim();

  // <ref>~n
  const m = /^(.*?)~(\d*)$/.exec(trimmed);
  if (m) {
    const base = m[1] ?? "";
    const n = m[2] === "" ? 1 : Number(m[2]);
    const resolved = resolveRef(base === "" ? "HEAD" : base, { ...ctx, index, moves });
    let cur = resolved.op;
    for (let i = 0; i < n; i++) {
      const op = index.byId.get(cur);
      if (!op || op.parent === null) {
        throw new MontashError("E_HISTORY_REF_NOT_FOUND", `${trimmed} goes past the root of the history (${base || "HEAD"} has only ${i} ancestor${i === 1 ? "" : "s"})`, {
          hint: `Use ${base || "HEAD"}~${i} or an explicit op id (see \`montash log --ops\`).`,
          detail: { ref: trimmed, available: i },
        });
      }
      cur = op.parent;
    }
    return { ...resolved, op: cur, back: resolved.back + n };
  }

  if (trimmed === "HEAD") {
    if (ctx.head === null) throw notFound(trimmed, ctx, "HEAD is not set (history is empty)");
    if (!index.byId.has(ctx.head)) throw notFound(trimmed, ctx, `HEAD points to unknown op ${ctx.head}`);
    return { op: ctx.head, via: "HEAD", back: 0 };
  }

  if (trimmed === "tip") {
    if (ctx.head === null) throw notFound(trimmed, ctx, "HEAD is not set (history is empty)");
    return { op: tipOf(index, ctx.head, moves), via: "tip", back: 0 };
  }

  if (OP_ID.test(trimmed)) {
    if (!index.byId.has(trimmed)) throw notFound(trimmed, ctx);
    return { op: trimmed, via: "op", back: 0 };
  }

  if (COMMIT_ID.test(trimmed)) {
    const commit = ctx.commits.find((c) => c.id === trimmed);
    if (!commit) throw notFound(trimmed, ctx);
    if (!index.byId.has(commit.head)) throw notFound(trimmed, ctx, `commit ${trimmed} points to unknown op ${commit.head}`);
    return { op: commit.head, via: "commit", commit: commit.id, back: 0 };
  }

  const tag = ctx.tags[trimmed];
  if (tag) {
    const target = resolveRef(tag.target, { ...ctx, index, moves, tags: {} });
    return { ...target, via: "tag", tag: trimmed };
  }

  throw notFound(trimmed, ctx);
}

function notFound(ref: string, ctx: RefContext, message?: string): MontashError {
  const candidates = suggest(ref, [
    ...ctx.ops.map((o) => o.id),
    ...ctx.commits.map((c) => c.id),
    ...Object.keys(ctx.tags),
    ...RESERVED_REFS,
  ]);
  return new MontashError("E_HISTORY_REF_NOT_FOUND", message ?? `unknown history ref '${ref}'`, {
    hint: candidates.length > 0 ? `Did you mean: ${candidates.join(", ")}? Refs: o_xxxx, k_xxxx, <tag>, HEAD, tip, <ref>~n.` : "Refs: o_xxxx, k_xxxx, <tag>, HEAD, tip, <ref>~n. See `montash log --ops` / `montash tag list`.",
    detail: { ref, candidates },
  });
}

/** 類似候補（前方一致・部分一致・編集距離 ≤ 2）を最大 5 件 */
export function suggest(input: string, names: Iterable<string>, max = 5): string[] {
  const lower = input.toLowerCase();
  const scored: { name: string; score: number }[] = [];
  for (const name of new Set(names)) {
    const n = name.toLowerCase();
    let score: number | null = null;
    if (n.startsWith(lower) || lower.startsWith(n)) score = 0;
    else if (n.includes(lower) || lower.includes(n)) score = 1;
    else {
      const d = levenshtein(lower, n);
      if (d <= 2) score = 2 + d;
    }
    if (score !== null) scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.slice(0, max).map((s) => s.name);
}

function levenshtein(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let left = i;
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(up + 1, left + 1, diag + cost);
      diag = up;
      prev[j] = val;
      left = val;
    }
  }
  return prev[b.length] as number;
}
