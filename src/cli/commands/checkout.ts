/**
 * `montash checkout <ref>` — HEAD を移動し project.json に展開する（docs/03 W-10, W-16, docs/11 §4.3）
 *
 * op は作らず moves.jsonl に記録される。pending は失われない（W_LEAVING_PENDING）。
 * tip 以外へ移動すると W_DETACHED_HEAD。
 */
import { History } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors } from "../errors.ts";
import { applyMove } from "./history-util.ts";

interface Args extends Record<string, unknown> {
  ref: string;
}

export const checkout = defineCommand<Args>({
  path: "checkout",
  summary: "move HEAD to an op / commit / tag and expand that state into project.json",
  description: "Does not create an op (recorded in moves.jsonl). Pending ops are kept; use `checkout tip` to return.",
  workflows: ["W-10", "W-16"],
  mutates: true,
  positionals: [{ name: "ref", describe: "o_xxxx | k_xxxx | <tag> | HEAD | tip | <ref>~n", required: true }],
  examples: [
    { cmd: "montash checkout k_0006~1", note: "the state just before commit k_0006" },
    { cmd: "montash checkout before-bgm" },
    { cmd: "montash checkout tip", note: "back to the newest state of the current branch" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.ref) throw errors.usage("missing <ref>", "montash checkout <op|commit|tag|tip|HEAD~n>");
    const history = await History.open(dir);
    const move = await history.checkout(String(args.ref), ctx.actor, ctx.actorDetail);
    return applyMove(dir, move, `checkout ${args.ref}`);
  },
});
