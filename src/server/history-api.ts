/**
 * 履歴の読み取り API（docs/06 §3.2、docs/13 D-10）。
 *
 * - `GET /api/history/:id?patch=1`    `montash show <ref> [--patch]` 相当
 * - `GET /api/history/diff?a=&b=`     `montash diff [<a>] [<b>]` 相当
 * - `GET /api/blame/:elementId?all=1` `montash blame <element> [--all]` 相当
 *
 * 判定そのものは `src/core/history/`（`History.show` / `History.blame` / `diffJson`）に任せ、
 * ここは CLI と同じ形に整えるだけにする。JSON は CLI の `--json` の `result` と同一なので、
 * Web で見えるものと `montash show|diff|blame --json` の出力が食い違わない。
 *
 * 読み取り専用。履歴が無いディレクトリでは `.montash/history/` を作らない（`history.ts` と同じ約束）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commitView, opView, projectFps, refView } from "../cli/commands/history-util.ts";
import { MontashError } from "../cli/errors.ts";
import { type Change, diffJson, HISTORY_DIR, History, suggest, summarizeChanges } from "../core/history/index.ts";

export interface HistoryHttpDeps {
  projectDir: string;
  json(body: unknown, status?: number, headers?: Record<string, string>): Response;
  jsonError(status: number, code: string, message: string, hint?: string): Response;
}

/** URL 由来の ref / element id の上限（DAG 上の照合しかしないが、明らかなゴミは先に弾く） */
const MAX_REF_LENGTH = 200;

/** 制御文字（C0 と DEL）を含むか。正規表現に生の制御文字を書かずに済ませる */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function badRef(deps: HistoryHttpDeps, what: string, value: string): Response | null {
  if (value === "") return deps.jsonError(400, "E_USAGE", `missing ${what}`);
  if (value.length > MAX_REF_LENGTH || hasControlChar(value)) return deps.jsonError(400, "E_USAGE", `invalid ${what}`);
  return null;
}

/**
 * 履歴を開く。`ops.jsonl` がまだ無ければ `null`（`History.open` は空ファイルを作ってしまうので、
 * 読み取り API からは呼ばない）。
 */
async function openHistory(projectDir: string): Promise<History | null> {
  if (!existsSync(join(projectDir, HISTORY_DIR, "ops.jsonl"))) return null;
  return History.open(projectDir);
}

/** MontashError を HTTP に写す。参照が見つからないのは 404、引数不正は 400、それ以外は 500 */
function errorResponse(deps: HistoryHttpDeps, e: unknown): Response {
  if (e instanceof MontashError) {
    const status = e.code === "E_HISTORY_REF_NOT_FOUND" ? 404 : e.code === "E_USAGE" ? 400 : 500;
    return deps.jsonError(status, e.code, e.message, e.hint);
  }
  return deps.jsonError(500, "E_IO", `cannot read the history: ${(e as Error).message}`);
}

/** `?patch=1` / `?patch=true` / `?patch`（値なし）を真とする */
function flag(url: URL, name: string): boolean {
  const value = url.searchParams.get(name);
  return value !== null && value !== "0" && value !== "false";
}

const emptyHistory = (deps: HistoryHttpDeps, ref: string): Response =>
  deps.jsonError(
    404,
    "E_HISTORY_REF_NOT_FOUND",
    `cannot resolve '${ref}': the history is empty`,
    "Edit the project once (or run `montash commit`) so that the history has an op.",
  );

// ---------------------------------------------------------------------------
// GET /api/history/:id （`montash show` 相当）
// ---------------------------------------------------------------------------

export async function handleHistoryShow(deps: HistoryHttpDeps, ref: string, url: URL): Promise<Response> {
  const bad = badRef(deps, "<ref>", ref);
  if (bad) return bad;
  try {
    const history = await openHistory(deps.projectDir);
    if (history === null) return emptyHistory(deps, ref);
    const res = await history.show(ref);
    const fps = await projectFps(deps.projectDir);
    // `k_xxxx`（や commit を指すタグ）そのものはコミット全体、それ以外は op の差分（show.ts と同じ判定）
    const commitMode = res.ref.commit !== undefined && res.ref.back === 0;
    return deps.json({
      ref: refView(res.ref),
      kind: commitMode ? "commit" : "op",
      op: opView(res.op, fps),
      commit: res.commit ? commitView(res.commit) : null,
      change_count: res.changes.length,
      changed_paths: res.changes.map((c) => c.path),
      summary: summarizeChanges(res.changes),
      ...(flag(url, "patch") ? { changes: res.changes } : {}),
    });
  } catch (e) {
    return errorResponse(deps, e);
  }
}

// ---------------------------------------------------------------------------
// GET /api/history/diff （`montash diff` 相当）
// ---------------------------------------------------------------------------

const noChanges = (from: Record<string, unknown>, to: Record<string, unknown>) => ({
  from,
  to,
  change_count: 0,
  summary: "no changes",
  changes: [] as Change[],
});

export async function handleHistoryDiff(deps: HistoryHttpDeps, url: URL): Promise<Response> {
  const a = url.searchParams.get("a");
  const b = url.searchParams.get("b");
  for (const [name, value] of [
    ["a", a],
    ["b", b],
  ] as const) {
    if (value === null) continue;
    const bad = badRef(deps, `?${name}=<ref>`, value);
    if (bad) return bad;
  }
  try {
    const history = await openHistory(deps.projectDir);
    if (history === null) return deps.json(noChanges({ ref: null, op: null }, { ref: null, op: null }));

    let fromHash: string | null;
    let toHash: string | null;
    let from: Record<string, unknown>;
    let to: Record<string, unknown>;

    if (a === null && b === null) {
      // 既定は「最終コミット → HEAD」= pending 全体（diff.ts と同じ）
      const state = await history.status();
      if (state.head === null || state.headOp === null)
        return deps.json(noChanges({ ref: null, op: null }, { ref: null, op: null }));
      toHash = state.headOp.after;
      to = { ref: "HEAD", op: state.head, hash: toHash };
      const firstPending = state.pending[0];
      if (!firstPending) return deps.json(noChanges({ ref: state.commit, op: state.head, hash: toHash }, to));
      fromHash = firstPending.before;
      from = { ref: firstPending.parent, op: firstPending.parent, hash: fromHash };
    } else {
      const aRef = a ?? "HEAD";
      const bRef = b ?? "HEAD";
      const [ra, rb] = await Promise.all([history.resolve(aRef), history.resolve(bRef)]);
      const byId = new Map((await history.ops()).map((o) => [o.id, o]));
      fromHash = byId.get(ra.op)?.after ?? null;
      toHash = byId.get(rb.op)?.after ?? null;
      from = { ref: aRef, ...refView(ra), hash: fromHash };
      to = { ref: bRef, ...refView(rb), hash: toHash };
    }

    if (fromHash === null || toHash === null) return deps.json(noChanges(from, to));
    const changes =
      fromHash === toHash
        ? []
        : diffJson(await history.store.getObject(fromHash), await history.store.getObject(toHash));
    return deps.json({ from, to, change_count: changes.length, summary: summarizeChanges(changes), changes });
  } catch (e) {
    return errorResponse(deps, e);
  }
}

// ---------------------------------------------------------------------------
// GET /api/blame/:elementId （`montash blame` 相当）
// ---------------------------------------------------------------------------

export async function handleBlame(deps: HistoryHttpDeps, element: string, url: URL): Promise<Response> {
  const bad = badRef(deps, "<element-id>", element);
  if (bad) return bad;
  try {
    const history = await openHistory(deps.projectDir);
    const hit = history === null ? null : await history.blame(element, { all: flag(url, "all") });
    if (hit === null) {
      const known = history === null ? [] : await history.elementIds();
      return deps.jsonError(
        404,
        "E_HISTORY_REF_NOT_FOUND",
        `no op in the history has changed element '${element}'`,
        known.length > 0
          ? `Known element ids include: ${suggest(element, known).join(", ") || known.slice(0, 5).join(", ")}. Add ?all=1 to search every branch.`
          : "The history has no elements yet.",
      );
    }
    const fps = await projectFps(deps.projectDir);
    return deps.json({
      element,
      op: opView(hit.op, fps),
      commit: hit.commit ? commitView(hit.commit) : null,
      actor: hit.op.actor,
      ...(hit.op.actor_detail !== undefined ? { actor_detail: hit.op.actor_detail } : {}),
      at: hit.op.at,
      command: hit.op.command,
      change_count: hit.changes.length,
      changes: hit.changes,
    });
  } catch (e) {
    return errorResponse(deps, e);
  }
}
