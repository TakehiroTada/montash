/**
 * `montash help [<command>...] [--json]`（docs/04 §2, docs/13 D-11）
 *
 * `schema` と同じ定義データ（defineCommand が単一の真実の源）を、人間が読む形に整形する。
 * yargs の `--help` との違いは次の 3 点で、いずれも `--help` には出せない情報:
 *   - そのコマンドが状態を変えるか（= op として履歴に残るか、`-m` で即コミットできるか）
 *   - どの作業手順（docs/03 の W-xx）に由来するか
 *   - どのオプションが時間表記（`12.5` / `00:00:12.500` / `f:375`）を受け取るか
 * 逆に全コマンド共通のグローバルオプションは並べない（`--help` で見られるため）。
 */
import { getCommands } from "../../registry/commands.ts";
import { type CommandSpec, defineCommand, type OptionSpec, type PositionalSpec, toSchema } from "../define-command.ts";
import { errors } from "../errors.ts";

type AnySpec = CommandSpec<Record<string, unknown>>;

interface Args extends Record<string, unknown> {
  command?: string[];
}

const GLOBAL_HINT =
  "Global options (every command): -C/--project, --json, -q/--quiet, -v/--verbose, --dry-run, -y/--yes, --time-format, --no-color";

/** `--in <time>` のように、時間表記を受け取るオプションは型を time と表示する */
function typeLabel(o: OptionSpec | PositionalSpec): string {
  if ("time" in o && o.time) return "time";
  if (o.type === "boolean") return "";
  return o.type ?? "string";
}

function optionLine(name: string, o: OptionSpec): string {
  const t = typeLabel(o);
  const alias = o.alias ? (Array.isArray(o.alias) ? o.alias : [o.alias]) : [];
  const flags = [...alias.map((a) => (a.length === 1 ? `-${a}` : `--${a}`)), `--${name}`].join(", ");
  const head = t ? `${flags} <${t}>` : flags;
  const notes: string[] = [];
  if (o.required) notes.push("required");
  if (o.choices) notes.push(`one of: ${o.choices.join(" | ")}`);
  if (o.default !== undefined && o.default !== false) notes.push(`default: ${String(o.default)}`);
  const tail = notes.length > 0 ? `  [${notes.join("; ")}]` : "";
  return `  ${head.padEnd(30)} ${o.describe}${tail}`;
}

function positionalLine(p: PositionalSpec): string {
  const t = typeLabel(p);
  const name = `<${p.name}${p.variadic ? "..." : ""}>`;
  return `  ${`${name} ${t ? `<${t}>` : ""}`.trim().padEnd(30)} ${p.describe}${p.required ? "  [required]" : ""}`;
}

function usageLine(spec: AnySpec): string {
  const parts = [`montash ${spec.path}`];
  for (const p of spec.positionals ?? []) {
    const name = `${p.name}${p.variadic ? "..." : ""}`;
    parts.push(p.required ? `<${name}>` : `[<${name}>]`);
  }
  const required = Object.entries(spec.options ?? {}).filter(([, o]) => o.required && !o.hidden);
  for (const [name, o] of required) {
    const t = typeLabel(o);
    parts.push(t ? `--${name} <${t}>` : `--${name}`);
  }
  if (Object.values(spec.options ?? {}).some((o) => !o.required && !o.hidden)) parts.push("[options]");
  return parts.join(" ");
}

/** 1 コマンドの詳細 */
function detail(spec: AnySpec, all: readonly AnySpec[] = []): string {
  const out: string[] = [];
  out.push(`montash ${spec.path} — ${spec.summary}`);
  if (spec.description) out.push("", spec.description);

  const facts: string[] = [];
  facts.push(
    spec.mutates
      ? 'changes the project (recorded as an op; commit it right away with -m "...")'
      : "read-only (nothing is recorded in the history)",
  );
  if (spec.workflows && spec.workflows.length > 0) facts.push(`workflow: ${spec.workflows.join(", ")}`);
  if (spec.noProject) facts.push("runs outside a project directory");
  out.push("", ...facts.map((f) => `  ${f}`));

  out.push("", "Usage", `  ${usageLine(spec)}`);

  const positionals = spec.positionals ?? [];
  if (positionals.length > 0) out.push("", "Arguments", ...positionals.map(positionalLine));

  const options = Object.entries(spec.options ?? {}).filter(([, o]) => !o.hidden);
  if (options.length > 0) out.push("", "Options", ...options.map(([n, o]) => optionLine(n, o)));

  const examples = spec.examples ?? [];
  if (examples.length > 0) {
    out.push("", "Examples");
    for (const e of examples) {
      out.push(`  ${e.cmd}`);
      if (e.note) out.push(`      ${e.note}`);
    }
  }

  // `render` のようにグループ名と同じパスのコマンドは、配下のサブコマンドも案内する
  const subs = all.filter((s) => s.path.startsWith(`${spec.path} `)).map((s) => s.path.slice(spec.path.length + 1));
  if (subs.length > 0)
    out.push("", "Subcommands", `  ${subs.join(", ")}`, `  (montash help "${spec.path} ${subs[0]}")`);

  out.push("", GLOBAL_HINT, `Machine-readable definition: montash schema "${spec.path}" --json`);
  return out.join("\n");
}

/** "clip" のようなグループ配下の一覧 */
function groupList(prefix: string, specs: readonly AnySpec[]): string {
  const out = [`montash ${prefix} — ${specs.length} commands`, ""];
  const width = Math.max(...specs.map((s) => s.path.length));
  for (const s of specs) out.push(`  ${s.path.padEnd(width)}  ${s.summary}`);
  const first = specs[0];
  if (first) out.push("", `Run \`montash help "${first.path}"\` for details.`);
  return out.join("\n");
}

/** 引数なし: グループごとの俯瞰 */
function overview(specs: readonly AnySpec[]): string {
  const groups = new Map<string, AnySpec[]>();
  for (const s of specs) {
    const head = s.path.split(" ")[0] ?? s.path;
    const list = groups.get(head);
    if (list) list.push(s);
    else groups.set(head, [s]);
  }
  const width = Math.max(...[...groups.keys()].map((k) => k.length));
  const out = [`montash — ${specs.length} commands`, ""];
  for (const [head, list] of groups) {
    // グループ名と同じパスのコマンド（`render` など）は summary を、配下は名前だけを並べる
    const self = list.find((s) => s.path === head);
    const subs = list.filter((s) => s.path !== head).map((s) => s.path.slice(head.length + 1));
    if (self) out.push(`  ${head.padEnd(width)}  ${self.summary}`);
    if (subs.length > 0) out.push(`  ${(self ? "" : head).padEnd(width)}  ${self ? "+ " : ""}${subs.join(", ")}`);
  }
  out.push("", "Run `montash help <command>` for details, e.g. `montash help clip add`.");
  return out.join("\n");
}

/** 打ち間違い救済: 同じ語で始まる／その語を含むコマンドを挙げる */
function suggest(wanted: string, specs: readonly AnySpec[]): string {
  const head = wanted.split(" ")[0] ?? wanted;
  const near = specs.filter((s) => s.path.includes(head) || (head.length > 2 && s.path.startsWith(head.slice(0, 3))));
  const names = (near.length > 0 ? near : specs).slice(0, 8).map((s) => `"${s.path}"`);
  return `Did you mean ${names.join(", ")}? Run \`montash help\` for the full list.`;
}

export const help = defineCommand<Args>({
  path: "help",
  summary: "explain a command in human-readable form (see also: schema)",
  workflows: [],
  noProject: true,
  positionals: [
    {
      name: "command",
      describe: 'command path, e.g. "clip add" (default: list every command)',
      variadic: true,
    },
  ],
  examples: [
    { cmd: "montash help", note: "list every command by group" },
    { cmd: "montash help clip", note: "list the clip subcommands" },
    { cmd: "montash help clip add", note: "explain one command" },
    { cmd: "montash help clip add --json", note: "same content as `montash schema`" },
  ],
  async handler(_ctx, args) {
    // 組み込み + 実行時登録の合成（docs/13 D-18）。schema.ts と同じ経路を通る
    const commands = await getCommands();
    const wanted = (args.command ?? []).join(" ").trim();

    if (wanted === "") {
      return { result: commands.map(toSchema), human: () => overview(commands) };
    }

    const exact = commands.find((c) => c.path === wanted);
    if (exact) {
      return { result: [toSchema(exact)], human: () => detail(exact, commands) };
    }

    const group = commands.filter((c) => c.path.startsWith(`${wanted} `));
    if (group.length > 0) {
      return { result: group.map(toSchema), human: () => groupList(wanted, group) };
    }

    throw errors.usage(`unknown command "${wanted}"`, suggest(wanted, commands));
  },
});
