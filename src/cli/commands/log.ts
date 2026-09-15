/**
 * `montash log [--ops] [--all] [--limit 20] [--grep <str>] [--author <a>] [--graph]`
 * （docs/03 W-10, docs/04 §15, docs/11 §4.1）
 *
 * 既定は HEAD 系列上のコミット（新しい順）。`--ops` で各コミットの op を展開、`--all` で全系列、
 * `--graph` は簡易 ASCII（コミット ●、op ○ を縦に並べる）。
 */
import { History, type LogEntry, type Op } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors } from "../errors.ts";
import { currentHead } from "../mutate.ts";
import { commitView, firstLine, opBrief, opView, projectFps, shortTime } from "./history-util.ts";

interface Args extends Record<string, unknown> {
  ops: boolean;
  all: boolean;
  limit: number;
  grep?: string;
  author?: string;
  graph: boolean;
}

export const log = defineCommand<Args>({
  path: "log",
  summary: "list commits (newest first); --ops expands the ops of each commit",
  workflows: ["W-10", "W-11", "W-15"],
  options: {
    ops: { type: "boolean", describe: "expand the ops of each commit", default: false },
    all: { type: "boolean", describe: "show all branches, not only the HEAD line", default: false },
    limit: { type: "number", describe: "maximum number of commits", default: 20 },
    grep: { type: "string", describe: "only commits whose message/body contains this text (case-insensitive)" },
    author: { type: "string", describe: "only commits by this author" },
    graph: { type: "boolean", describe: "draw a simple ASCII graph (● commit, ○ op)", default: false },
  },
  examples: [
    { cmd: "montash log --ops --json" },
    { cmd: "montash log --grep テロップ --json", note: "find the commit, then `montash checkout k_0006~1`" },
    { cmd: "montash log --all --graph" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const limit = Number(args.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 0)
      throw errors.usage(`--limit must be a non-negative integer (got ${args.limit})`);
    const history = await History.open(dir);
    const res = await history.log({
      ops: Boolean(args.ops) || Boolean(args.graph),
      all: Boolean(args.all),
      limit,
      ...(typeof args.grep === "string" ? { grep: args.grep } : {}),
      ...(typeof args.author === "string" ? { author: args.author } : {}),
    });
    const fps = await projectFps(dir);
    const head = await currentHead(dir);

    const result = {
      commits: res.entries.map((e) => ({
        ...commitView(e.commit),
        ...(args.ops && e.ops ? { ops: e.ops.map((o) => opView(o, fps)) } : {}),
      })),
      // pending は新しい順（コミット一覧と揃える）
      pending: [...res.pending].reverse().map(opBrief),
      // `reset --hard` で既定表示から外れている op（--all のときだけ入る。docs/11 §4.3）
      reset: res.reset,
      all: Boolean(args.all),
      limit,
    };

    const human = () =>
      args.graph ? formatGraph(res.entries, res.pending) : formatPlain(res.entries, res.pending, Boolean(args.ops));
    return { result, op: null, commit: null, head, human };
  },
});

function commitLine(e: LogEntry): string {
  const c = e.commit;
  const tags = c.tags.length ? `  (tag: ${c.tags.join(", ")})` : "";
  return `${c.id}  ${shortTime(c.at)}  ${c.author.padEnd(6)}  ${firstLine(c.message)}${tags}`;
}

function opLine(op: Op): string {
  return `${op.id}  ${shortTime(op.at)}  ${op.actor.padEnd(6)}  ${op.summary}`;
}

function formatPlain(entries: LogEntry[], pending: Op[], withOps: boolean): string {
  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push(`(pending: ${pending.length} uncommitted op${pending.length === 1 ? "" : "s"})`);
    if (withOps) for (const op of [...pending].reverse()) lines.push(`    ${opLine(op)}`);
  }
  for (const e of entries) {
    lines.push(commitLine(e));
    if (withOps && e.ops) for (const op of [...e.ops].reverse()) lines.push(`    ${opLine(op)}`);
  }
  if (lines.length === 0) return "(no commits)";
  return lines.join("\n");
}

function formatGraph(entries: LogEntry[], pending: Op[]): string {
  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push("│ (pending)");
    for (const op of [...pending].reverse()) lines.push(`○ ${opLine(op)}`);
    lines.push("│");
  }
  for (const e of entries) {
    lines.push(`● ${commitLine(e)}`);
    for (const op of [...(e.ops ?? [])].reverse()) lines.push(`│ ○ ${opLine(op)}`);
    lines.push("│");
  }
  if (lines.length === 0) return "(no commits)";
  if (lines[lines.length - 1] === "│") lines.pop();
  return lines.join("\n");
}
