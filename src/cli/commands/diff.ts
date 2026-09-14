/**
 * `montash diff [<a>] [<b>]` — 2 時点の差分（docs/03 W-15, docs/04 §15, docs/11 §4.1）
 *
 * 省略時は a = 最終コミット（pending の先頭 op の before）、b = HEAD、つまり pending 全体の差分。
 * pending が無ければ `changes: []`。
 */
import { diffJson, History, summarizeChanges } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { currentHead } from "../mutate.ts";
import { refView } from "./history-util.ts";

interface Args extends Record<string, unknown> {
  a?: string;
  b?: string;
}

export const diff = defineCommand<Args>({
  path: "diff",
  summary: "diff two points of the history (default: last commit → HEAD, i.e. the pending ops)",
  workflows: ["W-11", "W-15"],
  positionals: [
    { name: "a", describe: "from: o_xxxx | k_xxxx | <tag> | HEAD | tip | <ref>~n (default: last commit)" },
    { name: "b", describe: "to (default: HEAD)" },
  ],
  examples: [{ cmd: "montash diff --json" }, { cmd: "montash diff k_0005 k_0007" }, { cmd: "montash diff HEAD~3" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const history = await History.open(dir);
    const head = await currentHead(dir);

    let fromHash: string | null;
    let toHash: string | null;
    let from: Record<string, unknown>;
    let to: Record<string, unknown>;

    if (args.a === undefined && args.b === undefined) {
      const state = await history.status();
      if (state.head === null || state.headOp === null) {
        return emptyResult(head, { ref: null, op: null }, { ref: null, op: null });
      }
      const firstPending = state.pending[0];
      toHash = state.headOp.after;
      to = { ref: "HEAD", op: state.head, hash: toHash };
      if (!firstPending) {
        return emptyResult(head, { ref: state.commit, op: state.head, hash: toHash }, to);
      }
      // 最終コミットの状態 = pending 先頭 op の before（親 op の after）
      fromHash = firstPending.before;
      from = { ref: firstPending.parent, op: firstPending.parent, hash: fromHash };
    } else {
      const aRef = String(args.a ?? "HEAD");
      const bRef = String(args.b ?? "HEAD");
      const [ra, rb] = await Promise.all([history.resolve(aRef), history.resolve(bRef)]);
      const ops = await history.ops();
      const byId = new Map(ops.map((o) => [o.id, o]));
      fromHash = byId.get(ra.op)?.after ?? null;
      toHash = byId.get(rb.op)?.after ?? null;
      from = { ref: aRef, ...refView(ra), hash: fromHash };
      to = { ref: bRef, ...refView(rb), hash: toHash };
    }

    if (fromHash === null || toHash === null) return emptyResult(head, from, to);
    const changes =
      fromHash === toHash
        ? []
        : diffJson(await history.store.getObject(fromHash), await history.store.getObject(toHash));
    const result = { from, to, change_count: changes.length, summary: summarizeChanges(changes), changes };
    const human = () => {
      const lines = [
        `diff ${String(from.op ?? "(root)")} → ${String(to.op ?? "(root)")}: ${summarizeChanges(changes)}`,
      ];
      for (const c of changes) {
        const f = c.from !== undefined ? ` from ${JSON.stringify(c.from)}` : "";
        const v = c.value !== undefined ? ` to ${JSON.stringify(c.value)}` : "";
        lines.push(`  ${c.op.padEnd(7)} ${c.path}${f}${v}`);
      }
      return lines.join("\n");
    };
    return { result, op: null, commit: null, head, human };
  },
});

function emptyResult(
  head: Awaited<ReturnType<typeof currentHead>>,
  from: Record<string, unknown>,
  to: Record<string, unknown>,
) {
  return {
    result: { from, to, change_count: 0, summary: "no changes", changes: [] },
    op: null,
    commit: null,
    head,
    human: "no changes",
  };
}
