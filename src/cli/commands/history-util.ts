/**
 * 履歴コマンド群（status / log / show / diff / commit / checkout / undo / redo / tag）共通のヘルパ。
 *
 * - op / commit を JSON 出力向けに整える（フレームは `_f` と秒・tc を併記。docs/04 §1.3a）
 * - checkout / undo / redo の結果（MoveResult）を project.json に展開する
 */
import type { Commit, MoveResult, Op, ResolvedRef } from "../../core/history/index.ts";
import { atomicWrite, loadProject, parseProject, projectPaths, serializeProject } from "../../core/project.ts";
import type { Fps } from "../../core/schema.ts";
import { framesToSeconds, framesToTimecode } from "../../core/time.ts";
import type { CommandResult } from "../define-command.ts";
import { headSummary } from "../mutate.ts";
import { timelineSummary } from "./project.ts";

/** `affects.range_f` を秒・tc 併記に */
export function rangeView(range_f: [number, number] | null, fps: Fps | undefined) {
  if (range_f === null || fps === undefined) return { range_f };
  const [from, to] = range_f;
  return {
    range_f,
    range: [framesToSeconds(from, fps), framesToSeconds(to, fps)] as [number, number],
    range_tc: [framesToTimecode(from, fps), framesToTimecode(to, fps)] as [string, string],
  };
}

/** op の JSON 表現（before/after のハッシュと changes 件数。changes 本体は show --patch で） */
export function opView(op: Op, fps?: Fps) {
  return {
    id: op.id,
    parent: op.parent,
    at: op.at,
    actor: op.actor,
    ...(op.actor_detail !== undefined ? { actor_detail: op.actor_detail } : {}),
    command: op.command,
    summary: op.summary,
    commit: op.commit,
    before: op.before,
    after: op.after,
    change_count: op.changes.length,
    affects: { clips: op.affects.clips, ...rangeView(op.affects.range_f, fps) },
    ...(op.duration_ms !== undefined ? { duration_ms: op.duration_ms } : {}),
  };
}

/** status / log の pending 行など、短い op 表現 */
export function opBrief(op: Op) {
  return { id: op.id, summary: op.summary, actor: op.actor, at: op.at };
}

export function commitView(c: Commit) {
  return { ...c };
}

export function refView(r: ResolvedRef) {
  return {
    op: r.op,
    via: r.via,
    ...(r.commit !== undefined ? { commit: r.commit } : {}),
    ...(r.tag !== undefined ? { tag: r.tag } : {}),
    back: r.back,
  };
}

/** `2026-09-14T02:05:00.000Z` → `2026-09-14 02:05`（人間向け表示） */
export function shortTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/** コミットの 1 行目 */
export function firstLine(message: string): string {
  return message.split("\n")[0] ?? "";
}

/**
 * checkout / undo / redo の共通後処理: スナップショットを project.json に展開し、CommandResult を作る。
 *
 * `saveProject` は `updated_at` を更新してしまい、内容ハッシュが HEAD.after と食い違って
 * W_DIRTY_WORKTREE の誤検知になるため、スナップショットをそのまま（原子的に）書く。
 */
export async function applyMove(dir: string, move: MoveResult, verb: string): Promise<CommandResult> {
  const project = parseProject(move.project, `history object ${move.target.after}`);
  await atomicWrite(projectPaths(dir).projectFile, serializeProject(project));
  const head = headSummary(move.head);
  const t = move.target;
  const result = {
    target: { id: t.id, summary: t.summary, at: t.at, actor: t.actor, commit: t.commit },
    head: { ...head, tip: move.head.tip, commit: move.head.commit },
  };
  const human = [
    `${verb}: HEAD is now at ${t.id}${move.head.detached ? ` (detached; tip is ${move.head.tip})` : ""}`,
    `  ${shortTime(t.at)}  ${t.actor}  ${t.summary}`,
    `  pending ops: ${head.pending}${move.head.commit ? `  (on commit ${move.head.commit})` : ""}`,
  ].join("\n");
  return {
    result,
    warnings: move.warnings,
    op: null,
    commit: null,
    head,
    timeline: timelineSummary(project),
    human,
  };
}

/** 現在のプロジェクト fps（表示用。読めなければ undefined） */
export async function projectFps(dir: string): Promise<Fps | undefined> {
  try {
    return (await loadProject(dir)).settings.fps;
  } catch {
    return undefined;
  }
}
