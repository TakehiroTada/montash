/**
 * `montash commit -m <msg> [--body] [--last <n>] [--ops <a>..<b>] [--tag <name>] [--author] [--allow-empty] [--auto-message]`
 * （docs/03 W-15, docs/04 §15, docs/11 §4.2, §5）
 *
 * `-m` / `--body` はグローバルオプション（任意の状態変更コマンドで即コミットに使う）なので
 * `ctx.globals.message` / `ctx.globals.body` から読む。project.json は変更しないので runMutation は通さない。
 * メッセージ規約（docs/11 §5: 1 行目に `MM:SS` 形式の範囲、50 文字前後）から外れても失敗にはせず
 * `W_COMMIT_MESSAGE_STYLE` を警告する。
 */
import { autoMessage, History, type Op } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning, warning } from "../errors.ts";
import { headSummary } from "../mutate.ts";
import { commitView, firstLine } from "./history-util.ts";

interface Args extends Record<string, unknown> {
  last?: number;
  ops?: string;
  tag?: string;
  author?: string;
  allowEmpty: boolean;
  autoMessage: boolean;
}

/** 1 行目に `MM:SS`（`H:MM:SS` も可）の時刻があるか */
const RANGE_RE = /\d{1,2}:\d{2}/;
const MAX_FIRST_LINE = 80;

/** docs/11 §5 の規約チェック。問題が無ければ null */
export function commitMessageStyleWarning(message: string): Warning | null {
  const first = firstLine(message);
  const problems: string[] = [];
  if (!RANGE_RE.test(first)) problems.push("the first line has no MM:SS.s〜MM:SS.s timeline range");
  if ([...first].length > MAX_FIRST_LINE) problems.push(`the first line is longer than ${MAX_FIRST_LINE} characters`);
  if (problems.length === 0) return null;
  return warning("W_COMMIT_MESSAGE_STYLE", `commit message: ${problems.join("; ")}`, {
    hint: 'Start with the affected timeline range, e.g. "00:12.0〜00:15.0 の言い間違いをカット" (docs/11 §5). The commit was created anyway.',
    detail: { first_line: first, problems },
  });
}

/** `--ops o_0040..o_0042` / `o_0040,o_0041` を pending 上で展開する */
export function expandOpsRange(spec: string, pending: Op[]): string[] {
  const ids = pending.map((o) => o.id);
  const m = /^\s*(o_\d{4,})\s*\.\.\s*(o_\d{4,})\s*$/.exec(spec);
  if (m) {
    const a = ids.indexOf(m[1] as string);
    const b = ids.indexOf(m[2] as string);
    if (a === -1 || b === -1) {
      throw errors.usage(
        `--ops ${spec}: ${a === -1 ? m[1] : m[2]} is not a pending op`,
        ids.length ? `Pending ops: ${ids.join(", ")}.` : "There are no pending ops.",
      );
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return ids.slice(lo, hi + 1);
  }
  const list = spec
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (list.length === 0 || list.some((id) => !/^o_\d{4,}$/.test(id))) {
    throw errors.usage(`--ops must be "o_XXXX..o_YYYY" or a comma-separated list of op ids (got "${spec}")`);
  }
  return list;
}

export const commit = defineCommand<Args>({
  path: "commit",
  summary: "group the pending ops into a commit with a human-readable message (-m)",
  description:
    "Commits all pending ops by default; --last <n> / --ops <a>..<b> select a contiguous tail. " +
    "Messages should start with the affected timeline range (MM:SS.s〜MM:SS.s); otherwise W_COMMIT_MESSAGE_STYLE is warned.",
  workflows: ["W-15"],
  options: {
    last: { type: "number", describe: "commit only the last n pending ops" },
    ops: { type: "string", describe: "commit only these pending ops, e.g. o_0040..o_0042 (must end at HEAD)" },
    tag: { type: "string", describe: "also tag the new commit" },
    author: { type: "string", describe: "commit author (default: MONTASH_AUTHOR or the actor)" },
    "allow-empty": { type: "boolean", describe: "create a commit without ops (milestone)", default: false },
    "auto-message": {
      type: "boolean",
      describe: "generate a rule-based message from the op summaries when -m is omitted",
      default: false,
    },
  },
  examples: [
    {
      cmd: 'montash commit -m "00:12.0〜00:15.0 の言い間違いをカット" --body "指示: 「12秒あたりの噛んだところ消して」"',
    },
    { cmd: 'montash commit --last 2 -m "00:00.0〜00:03.0 にタイトルを追加"' },
    { cmd: "montash commit --auto-message --json", note: "draft message; edit and re-run with -m" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const history = await History.open(dir);
    const state = await history.status();

    if (args.last !== undefined && args.ops !== undefined)
      throw errors.usage("--last and --ops are mutually exclusive");
    // pending が無いことを -m の有無より先に伝える（AI が「何をすべきか」を誤解しないように）
    if (state.pending.length === 0 && !args.allowEmpty) {
      throw new MontashError("E_NOTHING_TO_COMMIT", "no pending ops to commit", {
        hint: "Use --allow-empty to create a milestone commit without ops.",
        detail: { head: state.head },
      });
    }
    let ops: string[] | undefined;
    if (typeof args.ops === "string") ops = expandOpsRange(args.ops, state.pending);
    const last = args.last !== undefined ? Number(args.last) : undefined;

    // メッセージ: -m が無ければ --auto-message、それも無ければ使用法エラー
    let message = ctx.globals.message;
    let auto = false;
    if (message === undefined || message.trim() === "") {
      if (!args.autoMessage) {
        throw errors.usage(
          "commit requires -m <message> (or --auto-message)",
          'Write the affected range first, e.g. montash commit -m "00:12.0〜00:15.0 の言い間違いをカット".',
        );
      }
      const selected =
        ops !== undefined
          ? state.pending.filter((o) => ops?.includes(o.id))
          : last !== undefined
            ? state.pending.slice(-last)
            : state.pending;
      message = autoMessage(selected);
      auto = true;
    }

    const warnings: Warning[] = [];
    const style = commitMessageStyleWarning(message);
    if (style) warnings.push(style);

    const created = await history.commit({
      message,
      ...(ctx.globals.body !== undefined ? { body: ctx.globals.body } : {}),
      author:
        typeof args.author === "string" && args.author !== "" ? args.author : (ctx.env.MONTASH_AUTHOR ?? ctx.actor),
      ...(ctx.actorDetail !== undefined ? { authorDetail: ctx.actorDetail } : {}),
      ...(ops !== undefined ? { ops } : {}),
      ...(last !== undefined ? { last } : {}),
      allowEmpty: Boolean(args.allowEmpty),
      ...(typeof args.tag === "string" && args.tag !== "" ? { tags: [args.tag] } : {}),
    });
    const after = await history.status();

    const result = { commit: commitView(created), auto_message: auto, remaining_pending: after.pending.length };
    const human = [
      `[${created.id}] ${firstLine(created.message)}`,
      `  ${created.ops.length} op${created.ops.length === 1 ? "" : "s"}${
        created.ops.length ? ` (${created.ops[0]}..${created.ops[created.ops.length - 1]})` : ""
      }, author ${created.author}${created.tags.length ? `, tag ${created.tags.join(", ")}` : ""}`,
      ...(after.pending.length ? [`  ${after.pending.length} op(s) still pending`] : []),
    ].join("\n");
    return { result, warnings, op: null, commit: created.id, head: headSummary(after), human };
  },
});
