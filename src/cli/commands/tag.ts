/**
 * `montash tag <name> [<ref>] [-m <msg>]` / `montash tag list` / `montash tag delete <name>`
 * （docs/03 W-10, W-15, docs/11 §4.4。旧 snapshot save/restore/list/delete の後継）
 *
 * `-m` はグローバルオプションなので `ctx.globals.message` をタグの message に使う。
 */
import { History } from "../../core/history/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors } from "../errors.ts";
import { currentHead } from "../mutate.ts";
import { formatTable } from "../output.ts";
import { shortTime } from "./history-util.ts";

interface TagArgs extends Record<string, unknown> {
  name: string;
  ref?: string;
}

export const tag = defineCommand<TagArgs>({
  path: "tag",
  summary: "name the current HEAD (or a given op / commit) so it can be checked out later",
  workflows: ["W-10", "W-15", "W-16"],
  mutates: true,
  positionals: [
    {
      name: "name",
      describe: "tag name (not HEAD/tip, not an id like o_0001/k_0001, no ~ / or spaces)",
      required: true,
    },
    { name: "ref", describe: "target: o_xxxx | k_xxxx | HEAD | tip | <ref>~n (default HEAD)" },
  ],
  examples: [
    { cmd: 'montash tag rough-cut -m "粗編集完了"' },
    { cmd: "montash tag before-bgm k_0006" },
    { cmd: "montash checkout rough-cut", note: "restore" },
  ],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.name) throw errors.usage("missing <name>", "montash tag <name> [<ref>] [-m <msg>]");
    const history = await History.open(dir);
    const entry = await history.tag(
      String(args.name),
      args.ref !== undefined ? String(args.ref) : "HEAD",
      ctx.globals.message,
    );
    const head = await currentHead(dir);
    return {
      result: { tag: entry },
      op: null,
      commit: null,
      head,
      human: `tag '${entry.name}' -> ${entry.target}${entry.target !== entry.op ? ` (${entry.op})` : ""}${
        entry.message ? `  "${entry.message}"` : ""
      }`,
    };
  },
});

export const tagList = defineCommand<Record<string, unknown>>({
  path: "tag list",
  summary: "list tags",
  workflows: ["W-10", "W-15"],
  examples: [{ cmd: "montash tag list --json" }],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const history = await History.open(dir);
    const tags = await history.listTags();
    const head = await currentHead(dir);
    const human = () =>
      formatTable(
        tags.map((t) => ({
          name: t.name,
          target: t.target,
          op: t.op ?? "(unresolved)",
          at: shortTime(t.at),
          message: t.message ?? "",
        })),
        ["name", "target", "op", "at", "message"],
      );
    return { result: { tags }, op: null, commit: null, head, human };
  },
});

interface DeleteArgs extends Record<string, unknown> {
  name: string;
}

export const tagDelete = defineCommand<DeleteArgs>({
  path: "tag delete",
  summary: "delete a tag (the history it points to is kept)",
  workflows: ["W-10"],
  mutates: true,
  positionals: [{ name: "name", describe: "tag name", required: true }],
  examples: [{ cmd: "montash tag delete rough-cut" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    if (!args.name) throw errors.usage("missing <name>", "montash tag delete <name>");
    const history = await History.open(dir);
    await history.deleteTag(String(args.name));
    const head = await currentHead(dir);
    return {
      result: { deleted: String(args.name) },
      op: null,
      commit: null,
      head,
      human: `deleted tag '${args.name}'`,
    };
  },
});
