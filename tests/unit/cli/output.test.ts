import { describe, expect, test } from "bun:test";
import { createContext, findProjectDirFrom, detectActor, type GlobalOptions } from "../../../src/cli/context.ts";
import { ExitCode, MontashError, toMontashError } from "../../../src/cli/errors.ts";
import { failureEnvelope, formatTable, printFailure, printSuccess, successEnvelope } from "../../../src/cli/output.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: false, quiet: false, verbose: false, dryRun: false, yes: false, noColor: true, timeFormat: "seconds", ...over,
});

function captureCtx(over: Partial<GlobalOptions> = {}, cwd = process.cwd()) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = createContext(globals(over), { cwd, env: {}, isTTY: false });
  ctx.stdout = (t) => { out.push(t); };
  ctx.stderr = (t) => { err.push(t); };
  return { ctx, out, err };
}

describe("errors", () => {
  test("MontashError carries code/hint/detail and default exit code", () => {
    const e = new MontashError("E_FFMPEG_FAILED", "boom", { hint: "retry" });
    expect(e.exitCode).toBe(ExitCode.EXTERNAL);
    expect(e.toJSON()).toEqual({ code: "E_FFMPEG_FAILED", message: "boom", hint: "retry" });
    expect(new MontashError("E_USAGE", "x").exitCode).toBe(ExitCode.USAGE);
    expect(new MontashError("E_ASSET_MISSING", "x").exitCode).toBe(ExitCode.IO);
    expect(new MontashError("E_CLIP_OVERLAP", "x").exitCode).toBe(ExitCode.GENERAL);
  });
  test("toMontashError normalizes unknown errors", () => {
    expect(toMontashError(new TypeError("t")).code).toBe("E_INTERNAL");
    expect(toMontashError("s").message).toBe("s");
  });
});

describe("output envelopes", () => {
  test("success envelope shape (docs/04 §1.5)", () => {
    const env = successEnvelope({ path: "clip add" }, { result: { id: "c1" }, warnings: [{ code: "W_X", message: "m" }], op: "o_0001" });
    expect(env).toEqual({ ok: true, command: "clip add", result: { id: "c1" }, warnings: [{ code: "W_X", message: "m" }], op: "o_0001", commit: null, head: null });
  });
  test("failure envelope shape", () => {
    const env = failureEnvelope("clip add", new MontashError("E_X", "msg", { hint: "h", detail: { a: 1 } }));
    expect(env).toEqual({ ok: false, command: "clip add", error: { code: "E_X", message: "msg", hint: "h", detail: { a: 1 } } });
  });
  test("--json prints one JSON line to stdout", () => {
    const { ctx, out } = captureCtx({ json: true });
    printSuccess(ctx, { path: "doctor" }, { result: { ok: true } });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, command: "doctor", result: { ok: true } });
  });
  test("human mode prints human text and warnings to stderr", () => {
    const { ctx, out, err } = captureCtx();
    printSuccess(ctx, { path: "doctor" }, { human: "all good", warnings: [{ code: "W_A", message: "careful", hint: "do x" }] });
    expect(out.join("")).toBe("all good\n");
    expect(err.join("")).toContain("warning [W_A]: careful");
    expect(err.join("")).toContain("hint: do x");
  });
  test("quiet suppresses human output", () => {
    const { ctx, out } = captureCtx({ quiet: true });
    printSuccess(ctx, { path: "doctor" }, { human: "x" });
    expect(out).toHaveLength(0);
  });
  test("failure in json goes to stdout; in human mode to stderr", () => {
    const j = captureCtx({ json: true });
    printFailure(j.ctx, "x", new MontashError("E_Y", "bad"));
    expect(JSON.parse(j.out[0]!)).toMatchObject({ ok: false, error: { code: "E_Y" } });
    const h = captureCtx();
    printFailure(h.ctx, "x", new MontashError("E_Y", "bad", { hint: "fix" }));
    expect(h.out).toHaveLength(0);
    expect(h.err.join("")).toContain("error [E_Y]: bad");
    expect(h.err.join("")).toContain("hint: fix");
  });
  test("formatTable aligns columns", () => {
    const t = formatTable([{ id: "c1", start: 0 }, { id: "c10", start: 12.5 }]);
    expect(t.split("\n")[0]).toBe("id   start");
    expect(t.split("\n")).toHaveLength(4);
  });
});

describe("context", () => {
  test("findProjectDirFrom walks upward", () => {
    const root = mkdtempSync(join(tmpdir(), "montash-ctx-"));
    writeFileSync(join(root, "project.json"), "{}");
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(findProjectDirFrom(deep)).toBe(root);
    expect(findProjectDirFrom(mkdtempSync(join(tmpdir(), "montash-none-")))).toBeNull();
  });
  test("requireProjectDir throws E_PROJECT_NOT_FOUND", () => {
    const empty = mkdtempSync(join(tmpdir(), "montash-empty-"));
    const { ctx } = captureCtx({}, empty);
    expect(() => ctx.requireProjectDir()).toThrow(MontashError);
    try { ctx.requireProjectDir(); } catch (e) { expect((e as MontashError).code).toBe("E_PROJECT_NOT_FOUND"); }
  });
  test("-C / MONTASH_PROJECT resolve explicitly", () => {
    const root = mkdtempSync(join(tmpdir(), "montash-explicit-"));
    writeFileSync(join(root, "project.json"), "{}");
    const ctx = createContext(globals({ project: root }), { cwd: tmpdir(), env: {}, isTTY: false });
    expect(ctx.findProjectDir()).toBe(root);
    const ctx2 = createContext(globals(), { cwd: tmpdir(), env: { MONTASH_PROJECT: root }, isTTY: false });
    expect(ctx2.findProjectDir()).toBe(root);
  });
  test("actor detection", () => {
    expect(detectActor({}, true)).toBe("human");
    expect(detectActor({}, false)).toBe("ai");
    expect(detectActor({ MONTASH_ACTOR: "web" }, true)).toBe("web");
    expect(detectActor({ MONTASH_ACTOR: "bogus" }, false)).toBe("ai");
  });
});
