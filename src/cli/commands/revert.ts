/**
 * `montash revert <commit|op> [-m <msg>]` — 逆差分を新しい op として適用する（docs/04 §15, docs/11 §4.3）。
 *
 * `History.revertChanges()` が逆差分と衝突の有無を返すので、
 * 衝突があれば `E_REVERT_CONFLICT`、無ければ現在の project に適用して `runMutation` で op にする。
 * `-m` はグローバルオプションなので、付いていれば runMutation がそのまま即コミットする。
 */
import { applyChanges, History, summarizeChanges } from "../../core/history/index.ts";
import { parseProject } from "../../core/project.ts";
import type { Project } from "../../core/schema.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError } from "../errors.ts";
import { runMutation } from "../mutate.ts";

interface Args extends Record<string, unknown> {
  ref: string;
}

export const revert = defineCommand<Args>({
  path: "revert",
  summary: "apply the inverse of a commit or op as a new op (does not rewrite history)",
  description:
    "The original op stays in the history; reverting twice returns to the original state. " +
    "If the target of the inverse diff no longer exists, the command fails with E_REVERT_CONFLICT.",
  workflows: ["W-10", "W-11"],
  mutates: true,
  positionals: [{ name: "ref", describe: "o_xxxx | k_xxxx | <tag> | HEAD | <ref>~n", required: true }],
  examples: [
    { cmd: 'montash revert k_0006 -m "テロップ追加を取り消し"' },
    { cmd: "montash revert HEAD", note: "undo the last op as a new op (history keeps both)" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.ref) throw errors.usage("missing <ref>", "montash revert <commit|op> [-m <msg>]");
    const ref = String(args.ref);
    const history = await History.open(dir);
    const revert = await history.revertChanges(ref);

    if (revert.conflicts.length > 0) {
      const [ops, commits] = await Promise.all([history.ops(), history.commits()]);
      const target = describeTarget(ref, revert.ref.op, ops, commits, revert.ref.commit);
      throw new MontashError(
        "E_REVERT_CONFLICT",
        `cannot revert ${ref}: ${revert.conflicts.length} of ${revert.changes.length} change(s) no longer apply`,
        {
          hint:
            `The timeline has moved on since ${revert.ref.op}. ` +
            `Inspect it with \`montash show ${ref} --patch\`, or go back to that state with \`montash checkout ${ref}\` ` +
            "(which keeps the newer ops reachable via `montash log --all`).",
          detail: { ref, op: revert.ref.op, target, conflicts: revert.conflicts, change_count: revert.changes.length },
        },
      );
    }

    if (revert.changes.length === 0) {
      throw new MontashError("E_NOTHING_TO_REVERT", `${ref} changed nothing; there is nothing to revert`, {
        hint: "Pick another op or commit (see `montash log --ops`).",
        detail: { ref, op: revert.ref.op },
      });
    }

    const [ops, commits] = await Promise.all([history.ops(), history.commits()]);
    const original = describeTarget(ref, revert.ref.op, ops, commits, revert.ref.commit);

    return runMutation(ctx, (tools) => {
      const applied = applyChanges(tools.before, revert.changes);
      let next: Project;
      try {
        next = parseProject(applied, `revert ${ref}`);
      } catch (cause) {
        // 例: 初期化コミットの revert（すべてを消してしまう）
        throw new MontashError("E_REVERT_CONFLICT", `reverting ${ref} would not leave a valid project`, {
          hint: `Revert a later commit, or go back with \`montash checkout ${ref}~1\` instead.`,
          detail: { ref, op: revert.ref.op, change_count: revert.changes.length },
          cause,
        });
      }
      // runMutation は tools.project を書き換える前提なので、中身を差し替える
      const target = tools.project as unknown as Record<string, unknown>;
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, next);
      const summary = `revert ${ref}: ${original}`;
      return {
        result: {
          reverted: { ref, op: revert.ref.op, commit: revert.ref.commit ?? null, message: original },
          change_count: revert.changes.length,
          summary: summarizeChanges(revert.changes),
        },
        summary,
        human: `${summary}\n  ${summarizeChanges(revert.changes)}`,
      };
    });
  },
});

/** 逆転する対象の人間向けメッセージ（コミットなら message、op なら summary） */
function describeTarget(
  ref: string,
  opId: string,
  ops: ReadonlyArray<{ id: string; summary: string }>,
  commits: ReadonlyArray<{ id: string; message: string }>,
  commitId?: string,
): string {
  if (commitId) {
    const commit = commits.find((c) => c.id === commitId);
    if (commit) return commit.message.split("\n")[0] ?? commit.id;
  }
  const op = ops.find((o) => o.id === opId);
  return op?.summary ?? ref;
}
