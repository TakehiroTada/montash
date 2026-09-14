/**
 * `montash undo [<n>]` — HEAD を親へ n 段戻す（= `checkout HEAD~n`。docs/03 W-10, docs/11 §4.3）
 */
import { History } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors } from "../errors.ts";
import { applyMove } from "./history-util.ts";

interface Args extends Record<string, unknown> {
  n?: number;
}

export function parseCount(raw: unknown, what: string): number {
  if (raw === undefined || raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw errors.usage(`${what} count must be a positive integer (got ${String(raw)})`);
  return n;
}

export const undo = defineCommand<Args>({
  path: "undo",
  summary: "move HEAD back n ops (default 1) and expand that state into project.json",
  workflows: ["W-10", "W-16"],
  mutates: true,
  positionals: [{ name: "n", describe: "number of ops to go back", type: "number" }],
  examples: [{ cmd: "montash undo" }, { cmd: "montash undo 3 --json" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const n = parseCount(args.n, "undo");
    const history = await History.open(dir);
    const move = await history.undo(n, ctx.actor, ctx.actorDetail);
    return applyMove(dir, move, `undo ${n}`);
  },
});
