/**
 * `montash status` — HEAD の位置、tip / detached、pending op の一覧、直近コミット、タグ、dirty 判定
 * （docs/03 W-10, docs/04 §15, docs/11 §4.1）
 */
import { History, type Op } from "../../core/history/index.ts";
import { loadProject } from "../../core/project.ts";
import { defineCommand } from "../define-command.ts";
import { type Warning, warning } from "../errors.ts";
import { headSummary } from "../mutate.ts";
import { firstLine, opBrief, projectFps, rangeView, shortTime } from "./history-util.ts";
import { timelineSummary } from "./project.ts";

export const status = defineCommand<Record<string, unknown>>({
  path: "status",
  summary: "show HEAD, pending (uncommitted) ops, the last commit and tags",
  workflows: ["W-10", "W-15", "W-16"],
  examples: [{ cmd: "montash status --json" }],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const history = await History.open(dir);
    const state = await history.status({ project });
    const [ops, commits, tags] = await Promise.all([history.ops(), history.commits(), history.listTags()]);
    const byId = new Map(ops.map((o) => [o.id, o]));

    // 直近コミット: HEAD から遡って最初に見つかるコミット済み op の所属コミット
    let lastCommitId: string | null = null;
    for (let cur: Op | null = state.headOp; cur; cur = cur.parent ? (byId.get(cur.parent) ?? null) : null) {
      if (cur.commit) {
        lastCommitId = cur.commit;
        break;
      }
    }
    const lastCommit = lastCommitId ? (commits.find((c) => c.id === lastCommitId) ?? null) : null;
    const tagsAtHead = tags.filter((t) => t.op !== null && t.op === state.head).map((t) => t.name);
    const fps = await projectFps(dir);

    const result = {
      head: state.head,
      head_op: state.headOp
        ? {
            ...opBrief(state.headOp),
            command: state.headOp.command,
            affects: { clips: state.headOp.affects.clips, ...rangeView(state.headOp.affects.range_f, fps) },
          }
        : null,
      commit: state.commit,
      last_commit: lastCommit
        ? { id: lastCommit.id, message: lastCommit.message, at: lastCommit.at, author: lastCommit.author }
        : null,
      pending: state.pending.map(opBrief),
      detached: state.detached,
      tip: state.tip,
      dirty: state.dirty ?? false,
      tags: tagsAtHead,
      commit_count: commits.length,
      op_count: ops.length,
    };

    const warnings: Warning[] = [];
    if (state.dirty) {
      warnings.push(
        warning(
          "W_DIRTY_WORKTREE",
          `project.json does not match HEAD (${state.head}); it may have been edited by hand`,
          {
            hint: "Use `montash checkout HEAD` to discard the manual edits, or record them with a normal montash command.",
            detail: { head: state.head },
          },
        ),
      );
    }

    const human = () => {
      const lines: string[] = [];
      if (state.head === null) {
        lines.push("HEAD: (empty history)");
      } else {
        lines.push(`HEAD: ${state.head}${state.detached ? `  (detached; tip is ${state.tip})` : "  (tip)"}`);
        if (state.headOp) lines.push(`  ${shortTime(state.headOp.at)}  ${state.headOp.actor}  ${state.headOp.summary}`);
      }
      if (state.commit)
        lines.push(`On commit ${state.commit}${lastCommit ? `  "${firstLine(lastCommit.message)}"` : ""}`);
      else if (lastCommit) lines.push(`Last commit ${lastCommit.id}  "${firstLine(lastCommit.message)}"`);
      else lines.push("No commits yet");
      if (tagsAtHead.length) lines.push(`Tags at HEAD: ${tagsAtHead.join(", ")}`);
      if (state.pending.length === 0) {
        lines.push("Nothing to commit (no pending ops)");
      } else {
        lines.push(`Pending ops (${state.pending.length}), commit with \`montash commit -m <msg>\`:`);
        for (const op of state.pending)
          lines.push(`  ${op.id}  ${shortTime(op.at)}  ${op.actor.padEnd(6)}  ${op.summary}`);
      }
      if (state.dirty) lines.push("project.json is DIRTY (does not match HEAD)");
      return lines.join("\n");
    };

    return {
      result,
      warnings,
      op: null,
      commit: null,
      head: headSummary(state),
      timeline: timelineSummary(project),
      human,
    };
  },
});
