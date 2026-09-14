/**
 * `montash schema [<command>] [--format json|anthropic-tools|openai-tools]`（docs/04 §2）
 * コマンド定義を機械可読に出力する。AI のツール定義として使える。
 */
import { defineCommand, toSchema, toToolDefinition, type CommandSpec } from "../define-command.ts";
import { errors } from "../errors.ts";

interface Args extends Record<string, unknown> {
  command?: string;
  format: "json" | "anthropic-tools" | "openai-tools";
}

export const schema = defineCommand<Args>({
  path: "schema",
  summary: "print machine-readable command definitions (for AI tool use)",
  workflows: [],
  noProject: true,
  positionals: [{ name: "command", describe: 'command path, e.g. "clip trim" (default: all)' }],
  options: {
    format: { type: "string", describe: "output format", choices: ["json", "anthropic-tools", "openai-tools"], default: "json" },
  },
  examples: [
    { cmd: "montash schema --json", note: "all commands as JSON" },
    { cmd: "montash schema --format anthropic-tools > tools.json", note: "LLM tool definitions" },
    { cmd: 'montash schema "clip trim" --json' },
  ],
  async handler(_ctx, args) {
    // 循環 import を避けるため遅延 import
    const { commands } = await import("./registry.ts");
    let specs: ReadonlyArray<CommandSpec<Record<string, unknown>>> = commands;
    if (args.command) {
      const wanted = args.command.trim();
      specs = commands.filter((c) => c.path === wanted || c.path.startsWith(wanted + " "));
      if (specs.length === 0) {
        throw errors.usage(`unknown command "${wanted}"`, `Available: ${commands.map((c) => c.path).join(", ")}`);
      }
    }
    const format = args.format;
    const result = format === "json" ? specs.map(toSchema) : specs.map((s) => toToolDefinition(s, format));
    return {
      result,
      human: () => (args.format === "json" ? specs.map((s) => `${s.path.padEnd(24)} ${s.summary}`).join("\n") : JSON.stringify(result, null, 2)),
    };
  },
});
