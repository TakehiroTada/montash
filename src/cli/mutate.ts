/**
 * 状態変更コマンド共通のミドルウェア（docs/08 §3.1）。
 *
 *   load project → ハンドラが複製を変更 → validate → save（tmp→rename）
 *   → History.recordOp(before, after) → `-m` なら即コミット → 出力に op / commit / head を付与
 *
 * すべての状態変更コマンド（clip / track / text / import / project set ...）はこれを通す。
 * `--dry-run` は書き込み・op 記録を行わず、差分（changes）だけを返す。
 */
import { type Affects, diffJson, type HeadState, History } from "../core/history/index.ts";
import { loadProject, saveProject } from "../core/project.ts";
import type { Fps, Project } from "../core/schema.ts";
import { validateProject } from "../core/validate.ts";
import { timelineSummary } from "./commands/project.ts";
import type { CommandContext } from "./context.ts";
import type { CommandResult } from "./define-command.ts";
import { MontashError, type Warning, warning } from "./errors.ts";

export interface MutationTools {
  /** プロジェクトディレクトリ */
  dir: string;
  /** 変更対象（load した project の複製。ハンドラはこれを直接書き換える） */
  project: Project;
  /** 変更前のスナップショット（読み取り専用） */
  before: Readonly<Project>;
  fps: Fps;
  ctx: CommandContext;
}

export interface MutationOutcome<R = unknown> {
  /** コマンド固有の結果 */
  result?: R;
  /** op の 1 行要約（人間向け。History に記録される） */
  summary: string;
  /** Web でハイライトする影響範囲 */
  affects?: Affects;
  warnings?: Warning[];
  human?: string | (() => string);
  /** false なら「変更なし」として op を記録しない（冪等な再実行など） */
  changed?: boolean;
}

export interface HeadSummary {
  op: string | null;
  pending: number;
  detached: boolean;
}

/** 記録を横取りされた 1 回の状態変更（`montash batch --atomic` が集める） */
export interface MutationRecord {
  /** 実行された引数（ctx.argv） */
  command: string[];
  /** op の 1 行要約 */
  summary: string;
  affects?: Affects;
  changes: unknown[];
  warnings: Warning[];
}

/**
 * op の記録だけを横取りする受け皿（`cli/commands/batch.ts` が渡す）。
 *
 * これが `ctx` に付いていると `runMutation` は **project.json は通常どおり書く**が op を記録しない。
 * batch はこうして集めた変更をまとめて 1 op にする（docs/11 §3.2「batch --atomic は 1 op」）。
 * 途中で失敗したときは op が 1 つも積まれていないので、`checkout HEAD`（既存の履歴機構）で
 * 開始前の状態に戻せる。
 */
export interface MutationRecorder {
  record(entry: MutationRecord): void;
}

export function headSummary(state: HeadState): HeadSummary {
  return { op: state.head, pending: state.pending.length, detached: state.detached };
}

/** validate の issue を CLI の warning 形式に */
function issuesToWarnings(issues: Array<{ code: string; message: string; hint?: string; path?: string }>): Warning[] {
  return issues.map((i) =>
    warning(i.code, i.message, {
      ...(i.hint !== undefined ? { hint: i.hint } : {}),
      ...(i.path !== undefined ? { detail: { path: i.path } } : {}),
    }),
  );
}

/**
 * 状態変更を実行する。
 *
 * @param ctx コマンドコンテキスト（argv / actor / globals を使う）
 * @param fn  `tools.project` を書き換えて MutationOutcome を返す
 */
export async function runMutation<R>(
  ctx: CommandContext,
  fn: (tools: MutationTools) => Promise<MutationOutcome<R>> | MutationOutcome<R>,
): Promise<CommandResult> {
  const startedAt = Date.now();
  const dir = ctx.requireProjectDir();
  const before = await loadProject(dir);
  const working = structuredClone(before) as Project;

  const out = await fn({ dir, project: working, before, fps: working.settings.fps, ctx });
  const warnings: Warning[] = [...(out.warnings ?? [])];

  if (out.changed === false) {
    const history = await History.open(dir);
    const state = await history.status();
    return {
      result: out.result,
      warnings,
      op: null,
      commit: null,
      head: headSummary(state),
      timeline: timelineSummary(before),
      human: out.human,
    };
  }

  // 不変条件（docs/05 §14）。error があれば何も書かずに失敗する
  const validation = validateProject(working, { dir });
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new MontashError(
      first?.code ?? "E_VALIDATION_FAILED",
      first ? `${first.message}${first.path ? ` (${first.path})` : ""}` : "validation failed",
      {
        hint: first?.hint ?? "Fix the reported issue and retry; nothing was written.",
        detail: { errors: validation.errors, warnings: validation.warnings },
      },
    );
  }
  warnings.push(...issuesToWarnings(validation.warnings));

  if (ctx.globals.dryRun) {
    const changes = diffJson(before, working);
    return {
      result: { ...(out.result as object), dry_run: true },
      changes,
      warnings,
      op: null,
      commit: null,
      head: null,
      timeline: timelineSummary(working),
      human: out.human,
    };
  }

  // batch --atomic の最中は op を積まず、変更内容だけを batch に渡す（docs/11 §3.2）。
  // project.json は書くので、後続の行は前の行の結果を見られる。
  if (ctx.mutationRecorder) {
    await saveProject(dir, working);
    const changes = diffJson(before, working);
    ctx.mutationRecorder.record({
      command: ctx.argv,
      summary: out.summary,
      ...(out.affects !== undefined ? { affects: out.affects } : {}),
      changes,
      warnings,
    });
    return {
      result: out.result,
      changes,
      warnings,
      op: null,
      commit: null,
      head: null,
      timeline: timelineSummary(working),
      human: out.human,
    };
  }

  const history = await History.open(dir);
  await saveProject(dir, working); // updated_at を更新し tmp→rename で書く
  const rec = await history.recordOp({
    before,
    after: working,
    command: ctx.argv,
    actor: ctx.actor,
    ...(ctx.actorDetail !== undefined ? { actorDetail: ctx.actorDetail } : {}),
    summary: out.summary,
    ...(out.affects !== undefined ? { affects: out.affects } : {}),
    durationMs: Date.now() - startedAt,
  });
  warnings.push(...rec.warnings);

  let commitId: string | null = null;
  let head = rec.head;
  if (ctx.globals.message !== undefined) {
    const commit = await history.commit({
      message: ctx.globals.message,
      ...(ctx.globals.body !== undefined ? { body: ctx.globals.body } : {}),
      author: ctx.env.MONTASH_AUTHOR ?? ctx.actor,
      ...(ctx.actorDetail !== undefined ? { authorDetail: ctx.actorDetail } : {}),
    });
    commitId = commit.id;
    head = await history.status();
  }

  return {
    result: out.result,
    changes: rec.op.changes,
    warnings,
    op: rec.op.id,
    commit: commitId,
    head: headSummary(head),
    timeline: timelineSummary(working),
    human: out.human,
  };
}

/** `init` 直後の初期 op（before は空オブジェクト）。以後の op がこれを parent にする */
export async function recordInitialOp(
  dir: string,
  project: Project,
  ctx: CommandContext,
): Promise<{ op: string; head: HeadSummary }> {
  const history = await History.open(dir);
  const rec = await history.recordOp({
    before: {},
    after: project,
    command: ctx.argv,
    actor: ctx.actor,
    ...(ctx.actorDetail !== undefined ? { actorDetail: ctx.actorDetail } : {}),
    summary: `init project "${project.name}"`,
    affects: { clips: [], range_f: null },
  });
  return { op: rec.op.id, head: headSummary(rec.head) };
}

/** 読み取り系コマンドが head を出力に付ける際のヘルパ */
export async function currentHead(dir: string): Promise<HeadSummary> {
  const history = await History.open(dir);
  return headSummary(await history.status());
}
