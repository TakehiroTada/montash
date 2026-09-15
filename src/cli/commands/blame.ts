/**
 * `montash blame <element-id> [--json]` — 要素を最後に変更した op / commit / actor
 * （docs/04 §15, docs/11 §4.1, W-11）。
 *
 * クリップだけでなく、テキスト・トランジション・アセットなど `id` を持つ要素すべてを対象にする。
 * 判定は op.affects.clips → changes の path（`/assets/x1/...`）→ スナップショット上の `id` の順。
 */
import { History, suggest, summarizeChanges } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError } from "../errors.ts";
import { currentHead } from "../mutate.ts";
import { commitView, firstLine, opView, projectFps, shortTime } from "./history-util.ts";

interface Args extends Record<string, unknown> {
  element: string;
  all: boolean;
}

export const blame = defineCommand<Args>({
  path: "blame",
  summary: "show the op / commit / actor that last changed an element (clip, text, transition, asset)",
  workflows: ["W-11"],
  positionals: [{ name: "element", describe: "element id (c3, x1, t2, an asset id, ...)", required: true }],
  options: {
    all: { type: "boolean", describe: "search every branch, not only the HEAD line", default: false },
  },
  examples: [{ cmd: "montash blame c3 --json" }, { cmd: "montash blame x1" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.element) throw errors.usage("missing <element-id>", "montash blame <element-id> [--json]");
    const element = String(args.element);
    const history = await History.open(dir);
    const hit = await history.blame(element, { all: Boolean(args.all) });
    const head = await currentHead(dir);

    if (!hit) {
      const known = await history.elementIds();
      throw new MontashError("E_HISTORY_REF_NOT_FOUND", `no op in the history has changed element '${element}'`, {
        hint:
          known.length > 0
            ? `Known element ids include: ${suggest(element, known).join(", ") || known.slice(0, 5).join(", ")}. Use \`montash blame --all\` to search every branch.`
            : "The history has no elements yet. Use `montash clip list` / `montash text list` to find an id.",
        detail: { element, candidates: suggest(element, known) },
      });
    }

    const fps = await projectFps(dir);
    const result = {
      element,
      op: opView(hit.op, fps),
      commit: hit.commit ? commitView(hit.commit) : null,
      actor: hit.op.actor,
      ...(hit.op.actor_detail !== undefined ? { actor_detail: hit.op.actor_detail } : {}),
      at: hit.op.at,
      command: hit.op.command,
      change_count: hit.changes.length,
      changes: hit.changes,
    };
    const human = () =>
      [
        `${element} last changed by ${hit.op.id}  ${shortTime(hit.op.at)}  ${hit.op.actor}`,
        `  ${hit.op.summary}`,
        `  command: montash ${hit.op.command.join(" ")}`,
        hit.commit
          ? `  commit ${hit.commit.id}  ${firstLine(hit.commit.message)}  (${hit.commit.author})`
          : "  commit: (pending)",
        `  ${summarizeChanges(hit.changes)}`,
      ].join("\n");
    return { result, op: null, commit: null, head, human };
  },
});
