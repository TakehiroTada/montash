/**
 * `montash show <ref> [--patch]` — op / commit / tag の詳細（docs/03 W-15, docs/04 §15, docs/11 §4.1）
 *
 * `k_xxxx`（またはコミットを指すタグ）はコミット全体の差分、それ以外は op の差分。
 * `--patch` で JSON Patch 風の changes 全件を含める（省略時は要約と件数のみ）。
 */
import { History, summarizeChanges } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors } from "../errors.ts";
import { currentHead } from "../mutate.ts";
import { commitView, firstLine, opView, projectFps, refView, shortTime } from "./history-util.ts";

interface Args extends Record<string, unknown> {
  ref: string;
  patch: boolean;
}

export const show = defineCommand<Args>({
  path: "show",
  summary: "show an op, commit or tag in detail (--patch includes the full JSON Patch)",
  workflows: ["W-15"],
  positionals: [{ name: "ref", describe: "o_xxxx | k_xxxx | <tag> | HEAD | tip | <ref>~n", required: true }],
  options: {
    patch: { type: "boolean", describe: "include every change (JSON Patch style)", default: false },
  },
  examples: [{ cmd: "montash show k_0002 --patch --json" }, { cmd: "montash show HEAD~1" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.ref) throw errors.usage("missing <ref>", "montash show <op|commit|tag> [--patch]");
    const history = await History.open(dir);
    const res = await history.show(String(args.ref));
    const fps = await projectFps(dir);
    const head = await currentHead(dir);
    const commitMode = res.ref.commit !== undefined && res.ref.back === 0;

    const result = {
      ref: refView(res.ref),
      kind: commitMode ? "commit" : "op",
      op: opView(res.op, fps),
      commit: res.commit ? commitView(res.commit) : null,
      change_count: res.changes.length,
      changed_paths: res.changes.map((c) => c.path),
      summary: summarizeChanges(res.changes),
      ...(args.patch ? { changes: res.changes } : {}),
    };

    const human = () => {
      const lines: string[] = [];
      if (commitMode && res.commit) {
        const c = res.commit;
        lines.push(`commit ${c.id}${c.tags.length ? `  (tag: ${c.tags.join(", ")})` : ""}`);
        lines.push(`Author: ${c.author}${c.author_detail ? ` (${c.author_detail})` : ""}`);
        lines.push(`Date:   ${c.at}`);
        lines.push(`Ops:    ${c.ops.length ? `${c.ops[0]}..${c.ops[c.ops.length - 1]}` : "(empty)"}  head ${c.head}`);
        lines.push("", `    ${c.message.split("\n").join("\n    ")}`);
        if (c.body) lines.push("", `    ${c.body.split("\n").join("\n    ")}`);
      } else {
        const o = res.op;
        lines.push(`op ${o.id}${o.commit ? `  (commit ${o.commit})` : "  (pending)"}`);
        lines.push(`Actor:   ${o.actor}${o.actor_detail ? ` (${o.actor_detail})` : ""}`);
        lines.push(`Date:    ${o.at}  (${shortTime(o.at)})`);
        lines.push(`Parent:  ${o.parent ?? "(root)"}`);
        lines.push(`Command: ${o.command.join(" ")}`);
        lines.push("", `    ${o.summary}`);
        if (res.commit) lines.push("", `    in commit ${res.commit.id}: ${firstLine(res.commit.message)}`);
      }
      lines.push("", summarizeChanges(res.changes));
      if (args.patch) {
        for (const c of res.changes) {
          const from = c.from !== undefined ? ` from ${JSON.stringify(c.from)}` : "";
          const value = c.value !== undefined ? ` to ${JSON.stringify(c.value)}` : "";
          lines.push(`  ${c.op.padEnd(7)} ${c.path}${from}${value}`);
        }
      }
      return lines.join("\n");
    };

    return { result, op: null, commit: null, head, human };
  },
});
