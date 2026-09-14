import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { currentHead, recordInitialOp, runMutation } from "../../../src/cli/mutate.ts";
import { History } from "../../../src/core/history/index.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: true,
  quiet: false,
  verbose: false,
  dryRun: false,
  yes: true,
  noColor: true,
  timeFormat: "seconds",
  ...over,
});

let dir: string;

async function setup(argv: string[] = ["init", "x"]) {
  dir = mkdtempSync(join(tmpdir(), "montash-mutate-"));
  const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 1280, height: 720 } });
  await initProjectDir(dir, project, { force: true });
  const ctx = createContext(globals({ project: dir }), { cwd: dir, env: { MONTASH_ACTOR: "ai" }, isTTY: false, argv });
  const init = await recordInitialOp(dir, project, ctx);
  return { ctx, init };
}

const mkCtx = (argv: string[], over: Partial<GlobalOptions> = {}) =>
  createContext(globals({ project: dir, ...over }), { cwd: dir, env: { MONTASH_ACTOR: "ai" }, isTTY: false, argv });

describe("runMutation", () => {
  beforeEach(async () => {
    await setup();
  });

  test("init records an initial op and HEAD", async () => {
    const head = await currentHead(dir);
    expect(head.op).toBe("o_0001");
    expect(head.pending).toBe(1);
    expect(head.detached).toBe(false);
  });

  test("writes project, records op with command/actor, returns changes and head", async () => {
    const ctx = mkCtx(["project", "set", "name", "renamed"]);
    const res = await runMutation(ctx, ({ project }) => {
      project.name = "renamed";
      return { result: { name: project.name }, summary: "rename project" };
    });
    expect(res.op).toBe("o_0002");
    expect(res.commit).toBeNull();
    expect(res.head).toEqual({ op: "o_0002", pending: 2, detached: false });
    expect(res.changes?.some((c) => (c as { path: string }).path === "/name")).toBe(true);
    expect((await loadProject(dir)).name).toBe("renamed");
    const h = await History.open(dir);
    const ops = await h.ops();
    expect(ops.at(-1)?.command).toEqual(["project", "set", "name", "renamed"]);
    expect(ops.at(-1)?.actor).toBe("ai");
    expect(ops.at(-1)?.summary).toBe("rename project");
    expect((res.timeline as { duration_f: number }).duration_f).toBe(0);
  });

  test("-m commits immediately and pending drops to 0", async () => {
    const ctx = mkCtx(["project", "set", "name", "c"], { message: "名前を変更", body: "指示: rename" });
    const res = await runMutation(ctx, ({ project }) => {
      project.name = "c";
      return { summary: "rename" };
    });
    expect(res.commit).toBe("k_0001");
    expect(res.head?.pending).toBe(0);
    const h = await History.open(dir);
    const commits = await h.commits();
    expect(commits[0]?.message).toBe("名前を変更");
    expect(commits[0]?.body).toBe("指示: rename");
    expect(commits[0]?.ops).toEqual(["o_0001", "o_0002"]);
  });

  test("--dry-run writes nothing and returns diff", async () => {
    const ctx = mkCtx(["project", "set", "name", "dry"], { dryRun: true });
    const res = await runMutation(ctx, ({ project }) => {
      project.name = "dry";
      return { result: { name: "dry" }, summary: "rename" };
    });
    expect(res.op).toBeNull();
    expect((res.result as { dry_run: boolean }).dry_run).toBe(true);
    expect(res.changes?.length).toBeGreaterThan(0);
    expect((await loadProject(dir)).name).toBe("t");
    expect((await currentHead(dir)).op).toBe("o_0001");
  });

  test("validation failure writes nothing", async () => {
    const ctx = mkCtx(["clip", "add"]);
    await expect(
      runMutation(ctx, ({ project }) => {
        // 存在しないアセットを参照するクリップ → E_ASSET_NOT_FOUND 系の validation error
        project.tracks[0]!.clips.push({
          id: "c1",
          asset: "nope",
          start_f: 0,
          in_f: 0,
          out_f: 30,
          speed: 1,
          pitch_keep: false,
          loop: false,
          link: null,
          label: null,
        } as never);
        return { summary: "bad clip" };
      }),
    ).rejects.toBeInstanceOf(MontashError);
    expect((await loadProject(dir)).tracks[0]!.clips).toHaveLength(0);
    expect((await currentHead(dir)).op).toBe("o_0001");
  });

  test("changed: false records no op", async () => {
    const ctx = mkCtx(["noop"]);
    const res = await runMutation(ctx, () => ({ result: { noop: true }, summary: "noop", changed: false }));
    expect(res.op).toBeNull();
    expect(res.head?.op).toBe("o_0001");
  });

  test("warnings from the handler and validation are merged", async () => {
    const ctx = mkCtx(["x"]);
    const res = await runMutation(ctx, ({ project }) => {
      project.name = "w";
      return { summary: "w", warnings: [{ code: "W_TEST", message: "hello" }] };
    });
    expect(res.warnings?.some((w) => w.code === "W_TEST")).toBe(true);
  });
});
