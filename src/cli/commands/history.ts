/**
 * `montash history verify` — object ハッシュと DAG の整合性検証（docs/11 §4.5, §7）。
 * `history prune / export / import` は未実装（E_NOT_IMPLEMENTED）。
 */
import { History } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError } from "../errors.ts";
import { currentHead } from "../mutate.ts";

export const historyVerify = defineCommand<Record<string, unknown>>({
  path: "history verify",
  summary: "verify history integrity (object hashes, op DAG continuity, commits, tags, moves)",
  workflows: ["W-10"],
  examples: [{ cmd: "montash history verify --json" }],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const history = await History.open(dir);
    const res = await history.verify();
    const [ops, commits, moves, tags] = await Promise.all([
      history.store.readOps(),
      history.commits(),
      history.moves(),
      history.store.readTags(),
    ]);
    const counts = { ops: ops.length, commits: commits.length, moves: moves.length, tags: Object.keys(tags).length };
    if (!res.ok) {
      if (!ctx.globals.json && !ctx.globals.quiet) {
        ctx.stderr(
          `history verify — FAILED: ${res.problems.length} problem(s)\n${res.problems.map((p) => `  - ${p}`).join("\n")}\n`,
        );
      }
      throw new MontashError("E_HISTORY_CORRUPT", `history has ${res.problems.length} problem(s): ${res.problems[0]}`, {
        hint: "Do not edit .montash/history by hand. Restore it from a backup, or re-create the project with `montash init --force` (history is lost).",
        detail: { problems: res.problems, counts },
      });
    }
    const head = await currentHead(dir);
    return {
      result: { ok: true, problems: [], counts },
      op: null,
      commit: null,
      head,
      human: `history verify — OK (${counts.ops} ops, ${counts.commits} commits, ${counts.tags} tags, ${counts.moves} moves)`,
    };
  },
});

interface PruneArgs extends Record<string, unknown> {
  keepCommits: number;
  keepDays: number;
}

export const historyPrune = defineCommand<PruneArgs>({
  path: "history prune",
  summary: "delete old uncommitted ops and unreferenced objects (not implemented yet)",
  options: {
    "keep-commits": { type: "number", describe: "keep ops of the last n commits", default: 100 },
    "keep-days": { type: "number", describe: "keep ops newer than n days", default: 30 },
  },
  async handler() {
    throw errors.notImplemented("history prune");
  },
});

interface ExportArgs extends Record<string, unknown> {
  out?: string;
}

export const historyExport = defineCommand<ExportArgs>({
  path: "history export",
  summary: "export the history as one JSONL file (not implemented yet)",
  options: { out: { type: "string", alias: "o", describe: "output file (.jsonl)" } },
  async handler() {
    throw errors.notImplemented("history export");
  },
});

interface ImportArgs extends Record<string, unknown> {
  file?: string;
}

export const historyImport = defineCommand<ImportArgs>({
  path: "history import",
  summary: "import a history exported with `history export` (not implemented yet)",
  positionals: [{ name: "file", describe: "exported .jsonl file" }],
  async handler() {
    throw errors.notImplemented("history import");
  },
});
