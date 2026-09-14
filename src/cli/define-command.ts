/**
 * defineCommand(): コマンド定義を 1 か所に書き、そこから
 *   - yargs への登録（実行）
 *   - `montash schema` / `montash help --json`（機械可読な定義、LLM ツール定義）
 *   - Web の CLI 例テンプレート（server/cli-examples）
 * を導出する（docs/08 §5, docs/12 ADR-04）。
 *
 * 引数の型は素朴な DSL（string / number / boolean / array）で表す。時間表記（12.5 / f:375 / +0.5）は
 * すべて string で受け、cli/time-input.ts で解釈する（yargs の数値変換に任せない。docs/12 ADR-04）。
 */
import type { Argv } from "yargs";
import type { CommandContext } from "./context.ts";
import type { Warning } from "./errors.ts";

export type OptionType = "string" | "number" | "boolean" | "array";

export interface OptionSpec {
  type: OptionType;
  describe: string;
  alias?: string | string[];
  default?: string | number | boolean | readonly string[];
  choices?: readonly string[];
  /** 必須オプション（yargs の demandOption） */
  required?: boolean;
  /** 時間表記を受け取るオプション（schema 出力で "time" と注記する） */
  time?: boolean;
  /** schema 出力で隠す（内部用） */
  hidden?: boolean;
}

export interface PositionalSpec {
  name: string;
  describe: string;
  type?: "string" | "number";
  required?: boolean;
  variadic?: boolean;
  time?: boolean;
}

export interface CommandExample {
  cmd: string;
  note?: string;
}

/** ハンドラの戻り値。cli/output.ts が JSON / テキストに整形する（docs/04 §1.5） */
export interface CommandResult {
  /** コマンド固有の結果 */
  result?: unknown;
  /** 状態変更の一覧（JSON Patch 風）。読み取り系は省略 */
  changes?: unknown[];
  warnings?: Warning[];
  /** 記録された op / commit（状態変更コマンドのみ） */
  op?: string | null;
  commit?: string | null;
  head?: { op: string | null; pending: number; detached: boolean } | null;
  /** タイムライン要約 */
  timeline?: unknown;
  /** 人間向け表示。省略時は result を整形して出す */
  human?: string | (() => string);
}

export interface CommandSpec<A extends Record<string, unknown> = Record<string, unknown>> {
  /** "doctor" / "clip trim" のような空白区切りパス */
  path: string;
  summary: string;
  description?: string;
  /** 由来する作業手順（docs/03） */
  workflows?: string[];
  positionals?: PositionalSpec[];
  options?: Record<string, OptionSpec>;
  examples?: CommandExample[];
  /** 状態を変更するコマンド（op 記録・-m 即コミットの対象） */
  mutates?: boolean;
  /** プロジェクトを必要としない（doctor / init / schema など） */
  noProject?: boolean;
  handler: (ctx: CommandContext, args: A) => Promise<CommandResult> | CommandResult;
}

export function defineCommand<A extends Record<string, unknown>>(spec: CommandSpec<A>): CommandSpec<A> {
  if (!/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(spec.path)) {
    throw new Error(`invalid command path: "${spec.path}"`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// yargs への登録
// ---------------------------------------------------------------------------

type AnyCommandSpec = CommandSpec<Record<string, unknown>>;

interface GroupNode {
  name: string;
  children: Map<string, GroupNode>;
  leaf?: AnyCommandSpec;
}

/** "clip trim" のようなパスから木を作る */
export function buildCommandTree(specs: readonly AnyCommandSpec[]): GroupNode {
  const root: GroupNode = { name: "", children: new Map() };
  for (const spec of specs) {
    const parts = spec.path.split(" ");
    let node = root;
    for (const part of parts) {
      let next = node.children.get(part);
      if (!next) {
        next = { name: part, children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    }
    if (node.leaf) throw new Error(`duplicate command path: "${spec.path}"`);
    node.leaf = spec;
  }
  return root;
}

/** yargs のコマンド文字列（"trim <id>" / "import <paths..>"） */
export function commandSignature(spec: AnyCommandSpec): string {
  const last = spec.path.split(" ").at(-1) ?? spec.path;
  const pos = (spec.positionals ?? []).map((p) => {
    const inner = p.variadic ? `${p.name}..` : p.name;
    return p.required ? `<${inner}>` : `[${inner}]`;
  });
  return [last, ...pos].join(" ");
}

export type LeafRunner = (spec: AnyCommandSpec, argv: Record<string, unknown>) => Promise<void>;

/**
 * 木を再帰的に yargs に登録する。leaf の実行は runner に委譲（cli/index.ts が
 * グローバルオプション・出力整形・エラー処理を行う）。
 */
export function registerCommands(y: Argv, specs: readonly AnyCommandSpec[], runner: LeafRunner): Argv {
  const root = buildCommandTree(specs);
  for (const child of root.children.values()) registerNode(y, child, runner);
  return y;
}

function registerNode(y: Argv, node: GroupNode, runner: LeafRunner): void {
  if (node.leaf && node.children.size === 0) {
    registerLeaf(y, node.leaf, runner);
    return;
  }
  const groupSummary = node.leaf?.summary ?? `${node.name} commands`;
  y.command(
    node.name,
    groupSummary,
    (yy) => {
      if (node.leaf) {
        // グループ名そのものがコマンドでもある場合（例: "render" と "render verify"）は
        // "$0" として登録する
        registerLeaf(yy, node.leaf, runner, true);
      }
      for (const child of node.children.values()) registerNode(yy, child, runner);
      if (!node.leaf) yy.demandCommand(1, `specify a subcommand of "${node.name}"`);
      return yy;
    },
    () => {
      /* グループ自体は何もしない（leaf 側で処理） */
    },
  );
}

function registerLeaf(y: Argv, spec: AnyCommandSpec, runner: LeafRunner, asDefault = false): void {
  const sig = asDefault ? ["$0", ...commandSignature(spec).split(" ").slice(1)].join(" ") : commandSignature(spec);
  y.command(
    sig,
    spec.summary,
    (yy) => {
      for (const p of spec.positionals ?? []) {
        yy.positional(p.name, {
          describe: p.describe,
          type: p.type ?? "string",
          ...(p.variadic ? { array: true } : {}),
        });
      }
      for (const [name, o] of Object.entries(spec.options ?? {})) {
        yy.option(name, {
          type: o.type,
          describe: o.describe,
          ...(o.alias !== undefined ? { alias: o.alias } : {}),
          ...(o.default !== undefined ? { default: o.default } : {}),
          ...(o.choices !== undefined ? { choices: o.choices as string[] } : {}),
          ...(o.required ? { demandOption: true } : {}),
          ...(o.hidden ? { hidden: true } : {}),
        });
      }
      for (const ex of spec.examples ?? []) yy.example(ex.cmd, ex.note ?? "");
      return yy;
    },
    async (argv) => {
      await runner(spec, argv as Record<string, unknown>);
    },
  );
}

// ---------------------------------------------------------------------------
// schema 出力（docs/04 §2 `montash schema`）
// ---------------------------------------------------------------------------

export interface CommandSchema {
  path: string;
  summary: string;
  description?: string;
  workflows: string[];
  mutates: boolean;
  positionals: Array<PositionalSpec & { type: "string" | "number" }>;
  options: Record<string, Omit<OptionSpec, "hidden">>;
  examples: CommandExample[];
}

export function toSchema(spec: AnyCommandSpec): CommandSchema {
  const options: Record<string, Omit<OptionSpec, "hidden">> = {};
  for (const [k, v] of Object.entries(spec.options ?? {})) {
    if (v.hidden) continue;
    const { hidden: _hidden, ...rest } = v;
    options[k] = rest;
  }
  return {
    path: spec.path,
    summary: spec.summary,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    workflows: spec.workflows ?? [],
    mutates: spec.mutates ?? false,
    positionals: (spec.positionals ?? []).map((p) => ({
      ...p,
      type: p.type ?? "string",
    })),
    options,
    examples: spec.examples ?? [],
  };
}

/** LLM ツール定義（Anthropic / OpenAI 形式）に変換する */
export function toToolDefinition(spec: AnyCommandSpec, format: "anthropic-tools" | "openai-tools"): unknown {
  const s = toSchema(spec);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of s.positionals) {
    properties[p.name] = {
      type: p.variadic ? "array" : p.type === "number" ? "number" : "string",
      description: p.describe + (p.time ? " (time: seconds, HH:MM:SS.mmm, or f:<frames>)" : ""),
      ...(p.variadic ? { items: { type: "string" } } : {}),
    };
    if (p.required) required.push(p.name);
  }
  for (const [name, o] of Object.entries(s.options)) {
    properties[name] = {
      type: o.type === "array" ? "array" : o.type,
      description: o.describe + (o.time ? " (time: seconds, HH:MM:SS.mmm, or f:<frames>)" : ""),
      ...(o.choices ? { enum: [...o.choices] } : {}),
      ...(o.type === "array" ? { items: { type: "string" } } : {}),
    };
    if (o.required) required.push(name);
  }
  const inputSchema = {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
  const name = `montash_${s.path.replace(/[ -]/g, "_")}`;
  const description = [s.summary, s.description].filter(Boolean).join("\n");
  if (format === "openai-tools") {
    return {
      type: "function",
      function: { name, description, parameters: inputSchema },
    };
  }
  return { name, description, input_schema: inputSchema };
}
