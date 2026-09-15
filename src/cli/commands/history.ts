/**
 * `montash history verify|prune|export|import` — 履歴の保守と監査（docs/04 §15, docs/11 §4.5, §7）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { History } from "../../core/history/index.ts";
import { atomicWrite } from "../../core/project.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError } from "../errors.ts";
import { currentHead } from "../mutate.ts";
import { formatTable } from "../output.ts";

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
  summary: "delete old uncommitted ops and objects that nothing references",
  description:
    "Committed ops, HEAD and its ancestors, commit heads and tag targets are never deleted. " +
    "Use --dry-run first: it lists exactly what would go.",
  workflows: ["W-10"],
  options: {
    "keep-commits": { type: "number", describe: "keep every op from the last n commits onwards", default: 100 },
    "keep-days": { type: "number", describe: "keep ops newer than n days", default: 30 },
  },
  examples: [
    { cmd: "montash history prune --dry-run --json" },
    { cmd: "montash history prune --keep-commits 20 --keep-days 7" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const history = await History.open(dir);
    const keepCommits = Number(args.keepCommits ?? 100);
    const keepDays = Number(args.keepDays ?? 30);
    if (!Number.isInteger(keepCommits) || keepCommits < 0)
      throw errors.usage(`--keep-commits must be a non-negative integer (got ${String(args.keepCommits)})`);
    if (!Number.isFinite(keepDays) || keepDays < 0)
      throw errors.usage(`--keep-days must be a non-negative number (got ${String(args.keepDays)})`);
    const res = await history.prune({ keepCommits, keepDays, dryRun: ctx.globals.dryRun });
    const head = await currentHead(dir);
    const verb = res.dry_run ? "would delete" : "deleted";
    const human = [
      `history prune (${res.dry_run ? "dry run" : "applied"}): ${verb} ${res.ops.length} op(s), ${res.objects.length} object(s), ${res.moves} move(s)`,
      res.ops.length > 0 ? `  ops: ${res.ops.join(", ")}` : "  ops: (none)",
      `  kept: ${res.kept.ops} ops, ${res.kept.commits} commits, ${res.kept.objects} objects`,
    ].join("\n");
    return { result: res, op: null, commit: null, head, human };
  },
});

interface ExportArgs extends Record<string, unknown> {
  out?: string;
}

export const historyExport = defineCommand<ExportArgs>({
  path: "history export",
  summary: "export ops, commits, moves, tags and objects as one JSONL file (audit / backup)",
  workflows: ["W-10"],
  options: { out: { type: "string", alias: "o", describe: "output file (.jsonl); '-' for stdout" } },
  examples: [{ cmd: "montash history export -o history.jsonl" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.out) throw errors.usage("missing -o <file.jsonl>", "montash history export -o <file.jsonl>");
    const history = await History.open(dir);
    const { lines, counts } = await history.exportLines();
    const text = `${lines.join("\n")}\n`;
    const target = String(args.out);
    let path = "-";
    if (target === "-") {
      ctx.stdout(text);
    } else {
      path = resolve(ctx.cwd, target);
      await mkdir(dirname(path), { recursive: true });
      await atomicWrite(path, text);
    }
    const head = await currentHead(dir);
    return {
      result: { path, lines: lines.length, counts },
      op: null,
      commit: null,
      head,
      human: `exported ${lines.length} record(s) to ${path} (${counts.ops} ops, ${counts.commits} commits, ${counts.objects} objects)`,
    };
  },
});

interface ImportArgs extends Record<string, unknown> {
  file?: string;
}

export const historyImport = defineCommand<ImportArgs>({
  path: "history import",
  summary: "import a history exported with `history export` (restores ops, commits, tags and objects)",
  description:
    "Ids must not collide with the ones already present: import into a project whose .montash/history is empty.",
  workflows: ["W-10"],
  mutates: true,
  positionals: [{ name: "file", describe: "exported .jsonl file", required: true }],
  examples: [{ cmd: "montash history import history.jsonl --json" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.file) throw errors.usage("missing <file>", "montash history import <file.jsonl>");
    const path = resolve(ctx.cwd, String(args.file));
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (err) {
      throw new MontashError("E_IO", `cannot read ${path}`, {
        hint: "Pass the file produced by `montash history export -o <file.jsonl>`.",
        cause: err,
      });
    }
    const history = await History.open(dir);
    const res = await history.importLines(text.split("\n"));
    const head = await currentHead(dir);
    const table = formatTable(
      [
        { what: "ops", added: res.added.ops, total: res.counts.ops },
        { what: "commits", added: res.added.commits, total: res.counts.commits },
        { what: "tags", added: res.added.tags, total: res.counts.tags },
      ],
      ["what", "added", "total"],
    );
    return {
      result: { path, ...res },
      op: null,
      commit: null,
      head,
      human: `imported ${res.added.ops} op(s), ${res.added.commits} commit(s), ${res.added.objects} object(s) from ${path}\n${table}`,
    };
  },
});
