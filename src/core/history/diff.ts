/**
 * JSON の再帰差分（JSON Patch 風）と適用・逆変換（docs/11 §3.2 `changes`、§4.3 revert）。
 *
 * 配列は index ベース。削除は末尾側から（降順）、追加は昇順に並べるので、
 * 順に適用すれば index がずれない。`invertChanges` は順序も反転する。
 */

import { MontashError } from "../../cli/errors.ts";
import type { Affects, Change } from "./types.ts";

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.hasOwn(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

// ---- JSON Pointer ----

export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new MontashError("E_PATCH_FAILED", `invalid JSON pointer: ${path}`);
  return path.slice(1).split("/").map(unescapeToken);
}

/** ポインタが指す値を返す。無ければ `undefined`（`found: false`） */
export function getAt(value: unknown, path: string): { found: boolean; value: unknown } {
  let cur = value;
  for (const token of parsePointer(path)) {
    if (Array.isArray(cur)) {
      const idx = arrayIndex(token, cur.length, false);
      if (idx === null) return { found: false, value: undefined };
      cur = cur[idx];
    } else if (isObject(cur)) {
      if (!Object.hasOwn(cur, token)) return { found: false, value: undefined };
      cur = cur[token];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number | null {
  if (token === "-") return allowEnd ? length : null;
  if (!/^\d+$/.test(token)) return null;
  const idx = Number(token);
  if (idx < 0 || idx > length || (idx === length && !allowEnd)) return null;
  return idx;
}

// ---- diff ----

/** before → after の差分を JSON Patch 風に列挙する */
export function diffJson(before: unknown, after: unknown, basePath = ""): Change[] {
  const out: Change[] = [];
  walk(before, after, basePath, out);
  return out;
}

function walk(before: unknown, after: unknown, path: string, out: Change[]): void {
  if (deepEqual(before, after)) return;
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const p = `${path}/${escapeToken(key)}`;
      const inB = Object.hasOwn(before, key);
      const inA = Object.hasOwn(after, key);
      if (inB && !inA) out.push({ op: "remove", path: p, from: before[key] });
      else if (!inB && inA) out.push({ op: "add", path: p, value: after[key] });
      else walk(before[key], after[key], p, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const min = Math.min(before.length, after.length);
    for (let i = 0; i < min; i++) walk(before[i], after[i], `${path}/${i}`, out);
    // 削除は末尾から（降順）: 順に適用しても index がずれない
    for (let i = before.length - 1; i >= min; i--) out.push({ op: "remove", path: `${path}/${i}`, from: before[i] });
    for (let i = min; i < after.length; i++) out.push({ op: "add", path: `${path}/${i}`, value: after[i] });
    return;
  }
  out.push({ op: "replace", path, from: before, value: after });
}

// ---- apply ----

/** 差分を適用した新しい値を返す（入力は変更しない）。適用できなければ E_PATCH_FAILED */
export function applyChanges(value: unknown, changes: Change[]): unknown {
  const root: { v: unknown } = { v: structuredClone(value) };
  for (const change of changes) {
    if (change.path === "") {
      if (change.op === "remove") {
        root.v = undefined;
      } else {
        root.v = structuredClone(change.value);
      }
      continue;
    }
    const tokens = parsePointer(change.path);
    const last = tokens[tokens.length - 1] as string;
    const parentPath = `/${tokens.slice(0, -1).map(escapeToken).join("/")}`.replace(/^\/$/, "");
    const parent = getAt(root.v, parentPath);
    if (!parent.found) throw patchError(change, "parent does not exist");
    const target = parent.value;
    if (Array.isArray(target)) {
      const idx = arrayIndex(last, target.length, change.op === "add");
      if (idx === null) throw patchError(change, "array index out of range");
      if (change.op === "add") target.splice(idx, 0, structuredClone(change.value));
      else if (change.op === "remove") target.splice(idx, 1);
      else {
        if (idx >= target.length) throw patchError(change, "array index out of range");
        target[idx] = structuredClone(change.value);
      }
    } else if (isObject(target)) {
      if (change.op === "add") target[last] = structuredClone(change.value);
      else if (!Object.hasOwn(target, last)) throw patchError(change, "path does not exist");
      else if (change.op === "remove") delete target[last];
      else target[last] = structuredClone(change.value);
    } else {
      throw patchError(change, "parent is not a container");
    }
  }
  return root.v;
}

function patchError(change: Change, why: string): MontashError {
  return new MontashError("E_PATCH_FAILED", `cannot ${change.op} ${change.path}: ${why}`, { detail: { change: change as unknown as Record<string, unknown> } });
}

/**
 * 差分を適用できない箇所（対象パスが無い等）を列挙する。
 * 適用をシミュレートするので、途中で失敗した以降の変更も評価対象になる。
 */
export function findConflicts(value: unknown, changes: Change[]): string[] {
  const conflicts: string[] = [];
  let cur: unknown = structuredClone(value);
  for (const change of changes) {
    try {
      cur = applyChanges(cur, [change]);
    } catch (err) {
      if (err instanceof MontashError && err.code === "E_PATCH_FAILED") conflicts.push(change.path);
      else throw err;
    }
  }
  return conflicts;
}

/** revert 用の逆差分。順序も反転する: `apply(invert(diff(a,b)), b) == a` */
export function invertChanges(changes: Change[]): Change[] {
  const out: Change[] = [];
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i] as Change;
    switch (c.op) {
      case "add":
        out.push({ op: "remove", path: c.path, from: c.value });
        break;
      case "remove":
        out.push({ op: "add", path: c.path, value: c.from });
        break;
      case "replace":
        out.push({ op: "replace", path: c.path, from: c.value, value: c.from });
        break;
    }
  }
  return out;
}

// ---- 要約・影響範囲 ----

function short(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return "undefined";
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

/** 人間向けの 1 行要約 */
export function summarizeChanges(changes: Change[], max = 5): string {
  if (changes.length === 0) return "no changes";
  const parts = changes.slice(0, max).map((c) => {
    switch (c.op) {
      case "add":
        return `+ ${c.path} = ${short(c.value)}`;
      case "remove":
        return `- ${c.path} (was ${short(c.from)})`;
      case "replace":
        return `~ ${c.path}: ${short(c.from)} -> ${short(c.value)}`;
    }
  });
  const rest = changes.length - parts.length;
  return `${changes.length} change${changes.length === 1 ? "" : "s"}: ${parts.join("; ")}${rest > 0 ? `; ... (+${rest} more)` : ""}`;
}

const CLIP_PATH = /^\/tracks\/([^/]+)\/clips\/([^/]+)/;

/**
 * 変更からクリップ ID と影響フレーム範囲を推定する。
 * `/tracks/<i>/clips/<j>` を含むパスについて、after（無ければ before、無ければ value/from）の
 * 該当要素の `id` / `start_f` / `duration_f` を見る。取れなければ `clips: []`。
 */
export function extractAffects(changes: Change[], after?: unknown, before?: unknown): Affects {
  const clips = new Set<string>();
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;

  const consider = (clip: unknown): void => {
    if (!isObject(clip)) return;
    if (typeof clip.id === "string") clips.add(clip.id);
    const start = clip.start_f;
    const dur = clip.duration_f;
    if (typeof start === "number" && Number.isFinite(start)) {
      lo = Math.min(lo, start);
      hi = Math.max(hi, typeof dur === "number" && Number.isFinite(dur) ? start + dur : start);
    }
  };

  for (const change of changes) {
    const m = CLIP_PATH.exec(change.path);
    if (!m) continue;
    const clipPath = m[0];
    const inAfter = after === undefined ? { found: false, value: undefined } : getAt(after, clipPath);
    const inBefore = before === undefined ? { found: false, value: undefined } : getAt(before, clipPath);
    if (inAfter.found) consider(inAfter.value);
    if (inBefore.found) consider(inBefore.value);
    if (!inAfter.found && !inBefore.found && change.path === clipPath) {
      consider(change.value);
      consider(change.from);
    }
  }

  return {
    clips: [...clips],
    range_f: Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null,
  };
}
