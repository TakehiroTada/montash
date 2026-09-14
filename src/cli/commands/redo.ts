/**
 * `montash redo [<n>]` — HEAD を子へ n 段進める（docs/03 W-10, docs/11 §3.4, §4.3）
 *
 * 子が複数あれば「最後に HEAD だった系列」を選び W_MULTIPLE_CHILDREN と候補を返す。
 */
import { History } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { applyMove } from "./history-util.ts";
import { parseCount } from "./undo.ts";

interface Args extends Record<string, unknown> {
  n?: number;
}

export const redo = defineCommand<Args>({
  path: "redo",
  summary: "move HEAD forward n ops (default 1) along the most recently used branch",
  workflows: ["W-10", "W-16"],
  mutates: true,
  positionals: [{ name: "n", describe: "number of ops to go forward", type: "number" }],
  examples: [{ cmd: "montash redo" }, { cmd: "montash redo 2 --json" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const n = parseCount(args.n, "redo");
    const history = await History.open(dir);
    const move = await history.redo(n, ctx.actor, ctx.actorDetail);
    return applyMove(dir, move, `redo ${n}`);
  },
});
