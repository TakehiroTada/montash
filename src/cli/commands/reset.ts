/**
 * `montash reset --hard <ref>` — HEAD を移動し、その先の op を参照上無視する（docs/04 §15, docs/11 §4.3）。
 *
 * `checkout` と同じく project.json を展開するが、対象より先の op を `.montash/history/reset.json` の
 * 「無視する op の集合」に加える。物理削除はしないので `log --all` では見えるし、
 * `montash checkout <op>` で明示的に戻れる。`tip` の解決と `redo` は無視集合を辿らない。
 *
 * 破壊的なので、対話端末では確認を取り、非対話（AI / CI）では `--yes` を必須にする。
 */
import { History } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError } from "../errors.ts";
import { applyMove } from "./history-util.ts";

interface Args extends Record<string, unknown> {
  ref: string;
  hard: boolean;
}

export const reset = defineCommand<Args>({
  path: "reset",
  summary: "move HEAD to a ref and drop the ops after it from the default `log` view (--hard)",
  description:
    "Nothing is deleted: the discarded ops stay in ops.jsonl and are listed by `montash log --all`. " +
    "Only --hard is supported (the working project.json is always rewritten to the target state).",
  workflows: ["W-10"],
  mutates: true,
  positionals: [{ name: "ref", describe: "o_xxxx | k_xxxx | <tag> | HEAD~n", required: true }],
  options: {
    hard: { type: "boolean", describe: "required: expand the target state into project.json", default: false },
  },
  examples: [
    { cmd: "montash reset --hard k_0006 --yes" },
    { cmd: "montash log --all", note: "the discarded ops are still there" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.ref) throw errors.usage("missing <ref>", "montash reset --hard <op|commit|tag|HEAD~n>");
    if (!args.hard)
      throw errors.usage(
        "montash reset requires --hard",
        "Soft resets are not part of the model (there is no staging area). Use `montash reset --hard <ref>`.",
      );
    const ref = String(args.ref);
    const history = await History.open(dir);

    // 何が捨てられるかを先に見せてから確認する
    const resolved = await history.resolve(ref);
    const ops = await history.ops();
    const willDiscard = ops.filter((o) => o.id !== resolved.op && isDescendantOf(ops, o.id, resolved.op));
    await confirm(ctx, ref, resolved.op, willDiscard.length);

    const result = await history.reset(ref, ctx.actor, ctx.actorDetail);
    const moved = await applyMove(dir, result, `reset --hard ${ref}`);
    const discarded = result.discarded;
    return {
      ...moved,
      result: {
        ...(moved.result as Record<string, unknown>),
        reset: { ref, to: result.target.id, discarded, ignored_total: result.ignored.length },
      },
      human:
        `${moved.human as string}\n` +
        `  dropped from the default log: ${discarded.length} op${discarded.length === 1 ? "" : "s"}` +
        `${discarded.length > 0 ? ` (${discarded.join(", ")})` : ""}\n` +
        "  they are kept on disk — see `montash log --all`",
    };
  },
});

/** ops.jsonl 上で child が ancestor の子孫か（parent リンクを遡る） */
function isDescendantOf(ops: ReadonlyArray<{ id: string; parent: string | null }>, child: string, ancestor: string) {
  const byId = new Map(ops.map((o) => [o.id, o] as const));
  const seen = new Set<string>();
  let cur: string | null = child;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const op = byId.get(cur);
    cur = op ? op.parent : null;
    if (cur === ancestor) return true;
  }
  return false;
}

/**
 * 確認。`--yes` があれば素通り。TTY なら y/N を尋ね、非対話なら `E_CONFIRM_REQUIRED`。
 */
async function confirm(
  ctx: { globals: { yes: boolean; json: boolean }; stderr: (t: string) => void },
  ref: string,
  to: string,
  count: number,
): Promise<void> {
  if (ctx.globals.yes) return;
  const interactive = Boolean(process.stdin.isTTY) && !ctx.globals.json;
  if (!interactive) {
    throw new MontashError(
      "E_CONFIRM_REQUIRED",
      `reset --hard ${ref} would drop ${count} op${count === 1 ? "" : "s"} from the default log view`,
      {
        hint: `Re-run with --yes to confirm, or use \`montash checkout ${ref}\` which keeps every op visible.`,
        detail: { ref, to, discards: count },
      },
    );
  }
  ctx.stderr(`reset --hard ${ref} -> ${to}: drop ${count} op(s) from the default log view? [y/N] `);
  const line = await readLine();
  if (!/^y(es)?$/i.test(line.trim())) {
    throw new MontashError("E_CONFIRM_REQUIRED", "aborted by the user", { detail: { ref, to, discards: count } });
  }
}

async function readLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value, done } = await reader.read();
    if (done || value === undefined) return "";
    const text = new TextDecoder().decode(value);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    reader.releaseLock();
  }
}
