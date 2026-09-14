import { describe, expect, test } from "bun:test";
import yargs from "yargs";
import { buildCommandTree, commandSignature, defineCommand, registerCommands, toSchema, toToolDefinition, type CommandSpec } from "../../../src/cli/define-command.ts";

const trim = defineCommand<{ id: string; in?: string; ripple?: boolean }>({
  path: "clip trim",
  summary: "trim a clip",
  workflows: ["W-04"],
  mutates: true,
  positionals: [{ name: "id", describe: "clip id", required: true }],
  options: {
    in: { type: "string", describe: "new in point", time: true },
    ripple: { type: "boolean", describe: "ripple following clips", default: false },
  },
  handler: () => ({ result: {} }),
});

const add = defineCommand<{ asset: string }>({
  path: "clip add",
  summary: "add a clip",
  options: { asset: { type: "string", describe: "asset id", required: true } },
  handler: () => ({ result: {} }),
});

const doctor = defineCommand({ path: "doctor", summary: "check env", noProject: true, handler: () => ({ result: {} }) });

const specs = [trim, add, doctor] as unknown as CommandSpec<Record<string, unknown>>[];

describe("defineCommand", () => {
  test("rejects invalid paths", () => {
    expect(() => defineCommand({ path: "Clip Trim", summary: "", handler: () => ({}) })).toThrow();
    expect(() => defineCommand({ path: "clip  trim", summary: "", handler: () => ({}) })).toThrow();
  });

  test("builds a tree grouped by first token", () => {
    const tree = buildCommandTree(specs);
    expect([...tree.children.keys()].sort()).toEqual(["clip", "doctor"]);
    expect([...tree.children.get("clip")!.children.keys()].sort()).toEqual(["add", "trim"]);
    expect(tree.children.get("doctor")!.leaf?.path).toBe("doctor");
  });

  test("rejects duplicate paths", () => {
    expect(() => buildCommandTree([doctor, doctor] as never)).toThrow(/duplicate/);
  });

  test("signature includes positionals", () => {
    expect(commandSignature(trim as never)).toBe("trim <id>");
    expect(commandSignature(doctor as never)).toBe("doctor");
  });

  test("registers nested commands with yargs and parses args", async () => {
    let seen: { path: string; argv: Record<string, unknown> } | undefined;
    const y = yargs([]).strict().exitProcess(false);
    registerCommands(y, specs, async (spec, argv) => {
      seen = { path: spec.path, argv };
    });
    await y.parseAsync(["clip", "trim", "c2", "--in", "+0.5", "--ripple"]);
    expect(seen?.path).toBe("clip trim");
    expect(seen?.argv.id).toBe("c2");
    expect(seen?.argv.in).toBe("+0.5");
    expect(seen?.argv.ripple).toBe(true);
  });

  test("negative time values work with = form", async () => {
    let seen: Record<string, unknown> | undefined;
    const y = yargs([]).strict().exitProcess(false);
    registerCommands(y, specs, async (_spec, argv) => {
      seen = argv;
    });
    await y.parseAsync(["clip", "trim", "c2", "--in=-10"]);
    expect(seen?.in).toBe("-10");
  });

  test("toSchema exposes positionals/options/workflows", () => {
    const s = toSchema(trim as never);
    expect(s.path).toBe("clip trim");
    expect(s.workflows).toEqual(["W-04"]);
    expect(s.mutates).toBe(true);
    expect(s.positionals[0]).toMatchObject({ name: "id", required: true, type: "string" });
    expect(s.options.in).toMatchObject({ type: "string", time: true });
  });

  test("toToolDefinition (anthropic) produces JSON schema with required fields", () => {
    const t = toToolDefinition(add as never, "anthropic-tools") as { name: string; input_schema: { required: string[]; properties: Record<string, unknown> } };
    expect(t.name).toBe("montash_clip_add");
    expect(t.input_schema.required).toEqual(["asset"]);
    expect(Object.keys(t.input_schema.properties)).toEqual(["asset"]);
  });

  test("toToolDefinition (openai) wraps in function", () => {
    const t = toToolDefinition(trim as never, "openai-tools") as { type: string; function: { name: string; parameters: { required: string[] } } };
    expect(t.type).toBe("function");
    expect(t.function.name).toBe("montash_clip_trim");
    expect(t.function.parameters.required).toEqual(["id"]);
  });
});
