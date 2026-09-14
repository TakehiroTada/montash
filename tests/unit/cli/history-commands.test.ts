/**
 * 履歴コマンド群（status / log / show / diff / commit / checkout / undo / redo / tag / history verify / ids rebuild）と
 * `project set` の op 記録。一時プロジェクトに対し handler を直接呼んで検証する。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkout } from "../../../src/cli/commands/checkout.ts";
import { commit, commitMessageStyleWarning, expandOpsRange } from "../../../src/cli/commands/commit.ts";
import { diff } from "../../../src/cli/commands/diff.ts";
import { historyVerify } from "../../../src/cli/commands/history.ts";
import { idsRebuild } from "../../../src/cli/commands/ids.ts";
import { log } from "../../../src/cli/commands/log.ts";
import { projectSet } from "../../../src/cli/commands/project.ts";
import { redo } from "../../../src/cli/commands/redo.ts";
import { show } from "../../../src/cli/commands/show.ts";
import { status } from "../../../src/cli/commands/status.ts";
import { tag, tagDelete, tagList } from "../../../src/cli/commands/tag.ts";
import { undo } from "../../../src/cli/commands/undo.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult, CommandSpec } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { readIds } from "../../../src/core/ids.ts";
import { createProject, hashProject, initProjectDir, loadProject } from "../../../src/core/project.ts";

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

const mkCtx = (argv: string[], over: Partial<GlobalOptions> = {}) =>
  createContext(globals({ project: dir, ...over }), {
    cwd: dir,
    env: { MONTASH_ACTOR: "ai" },
    isTTY: false,
    argv,
  });

/** handler を直接呼ぶ（yargs を通さないので引数は camelCase で渡す） */
async function run<A extends Record<string, unknown>>(
  spec: CommandSpec<A>,
  args: Partial<A>,
  argv: string[] = [spec.path],
  over: Partial<GlobalOptions> = {},
): Promise<CommandResult> {
  return spec.handler(mkCtx(argv, over), args as A);
}

const setName = (name: string, over: Partial<GlobalOptions> = {}) =>
  run(projectSet, { key: "name", value: name }, ["project", "set", "name", name], over);

async function setup() {
  dir = mkdtempSync(join(tmpdir(), "montash-history-cli-"));
  const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 1280, height: 720 } });
  await initProjectDir(dir, project, { force: true });
  await recordInitialOp(dir, project, mkCtx(["init", dir]));
}

type R = Record<string, any>;
const res = (r: CommandResult): R => r.result as R;
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "(no error)";
  } catch (e) {
    return e instanceof MontashError ? e.code : String(e);
  }
};

describe("project set (runMutation)", () => {
  beforeEach(setup);

  test("records an op with summary and returns changes / head", async () => {
    const r = await setName("a");
    expect(r.op).toBe("o_0002");
    expect(res(r)).toEqual({ key: "name", before: "t", after: "a" });
    expect(r.head).toEqual({ op: "o_0002", pending: 2, detached: false });
    expect(r.changes?.some((c) => (c as { path: string }).path === "/name")).toBe(true);
    expect((await loadProject(dir)).name).toBe("a");
    const st = res(await run(status, {}));
    expect(st.head_op.summary).toBe('set name = "a"');
  });

  test("same value records no op", async () => {
    const r = await setName("t");
    expect(r.op).toBeNull();
    expect(r.head?.op).toBe("o_0001");
  });

  test("-m commits immediately", async () => {
    const r = await setName("x", { message: "00:00.0〜00:00.0 名前を x に" });
    expect(r.commit).toBe("k_0001");
    expect(r.head?.pending).toBe(0);
  });

  test("--dry-run writes nothing", async () => {
    const r = await setName("dry", { dryRun: true });
    expect(r.op).toBeNull();
    expect((await loadProject(dir)).name).toBe("t");
  });
});

describe("status", () => {
  beforeEach(setup);

  test("counts pending ops, reports tip and not dirty", async () => {
    await setName("a");
    await setName("b");
    const r = await run(status, {});
    const s = res(r);
    expect(s.head).toBe("o_0003");
    expect(s.pending).toHaveLength(3);
    expect(s.pending.map((p: R) => p.id)).toEqual(["o_0001", "o_0002", "o_0003"]);
    expect(s.detached).toBe(false);
    expect(s.dirty).toBe(false);
    expect(s.tip).toBe("o_0003");
    expect(s.last_commit).toBeNull();
    expect(r.head).toEqual({ op: "o_0003", pending: 3, detached: false });
    expect(r.op).toBeNull();
  });

  test("after a commit: commit / last_commit are set and pending is 0", async () => {
    await setName("a", { message: "00:00.0〜00:01.0 rename" });
    const s = res(await run(status, {}));
    expect(s.commit).toBe("k_0001");
    expect(s.last_commit.id).toBe("k_0001");
    expect(s.pending).toHaveLength(0);
  });
});

describe("undo / redo / checkout", () => {
  beforeEach(async () => {
    await setup();
    await setName("a");
    await setName("b");
  });

  test("undo writes the previous state to project.json, redo restores it", async () => {
    const u = await run(undo, {});
    expect(res(u).target.id).toBe("o_0002");
    expect(u.head?.op).toBe("o_0002");
    expect(u.head?.detached).toBe(true);
    expect((await loadProject(dir)).name).toBe("a");
    expect(u.warnings?.map((w) => w.code)).toContain("W_DETACHED_HEAD");
    expect(u.warnings?.map((w) => w.code)).toContain("W_LEAVING_PENDING");

    const r = await run(redo, {});
    expect(r.head).toEqual({ op: "o_0003", pending: 3, detached: false });
    expect((await loadProject(dir)).name).toBe("b");
    expect(r.warnings).toEqual([]);
  });

  test("undo n and E_NOTHING_TO_UNDO / E_NOTHING_TO_REDO", async () => {
    await run(undo, { n: 2 });
    expect((await loadProject(dir)).name).toBe("t");
    expect(await codeOf(run(undo, {}))).toBe("E_NOTHING_TO_UNDO");
    await run(redo, { n: 2 });
    expect(await codeOf(run(redo, {}))).toBe("E_NOTHING_TO_REDO");
    expect(await codeOf(run(undo, { n: 0 }))).toBe("E_USAGE");
  });

  test("checkout o_0001 is detached with warnings; project.json matches HEAD (not dirty)", async () => {
    const c = await run(checkout, { ref: "o_0001" });
    expect(res(c).target.id).toBe("o_0001");
    expect(res(c).head.detached).toBe(true);
    expect(c.warnings?.map((w) => w.code).sort()).toEqual(["W_DETACHED_HEAD", "W_LEAVING_PENDING"]);
    expect((await loadProject(dir)).name).toBe("t");
    // saveProject で updated_at を触らないので dirty にならない
    const s = res(await run(status, {}));
    expect(s.dirty).toBe(false);
    expect(s.detached).toBe(true);

    const t = await run(checkout, { ref: "tip" });
    expect(t.head).toEqual({ op: "o_0003", pending: 3, detached: false });
    expect((await loadProject(dir)).name).toBe("b");
  });

  test("checkout HEAD~1 and unknown ref", async () => {
    const c = await run(checkout, { ref: "HEAD~1" });
    expect(res(c).target.id).toBe("o_0002");
    expect(await codeOf(run(checkout, { ref: "o_9999" }))).toBe("E_HISTORY_REF_NOT_FOUND");
  });

  test("a new op after checkout branches; redo reports W_MULTIPLE_CHILDREN", async () => {
    await run(checkout, { ref: "o_0001" });
    await setName("c"); // o_0004, parent o_0001
    const s = res(await run(status, {}));
    expect(s.head).toBe("o_0004");
    expect(s.detached).toBe(false);
    await run(undo, {});
    const r = await run(redo, {});
    expect(r.warnings?.map((w) => w.code)).toContain("W_MULTIPLE_CHILDREN");
    expect(res(r).target.id).toBe("o_0004"); // 最後に HEAD だった系列
    const all = res(await run(log, { all: true, ops: true, limit: 20 }));
    expect(all.pending).toHaveLength(4);
  });
});

describe("commit", () => {
  beforeEach(async () => {
    await setup();
    await setName("a");
    await setName("b");
  });

  test("commits all pending ops; message without range warns W_COMMIT_MESSAGE_STYLE", async () => {
    const r = await run(commit, { allowEmpty: false, autoMessage: false }, ["commit"], { message: "名前を b に" });
    expect(r.commit).toBe("k_0001");
    expect(res(r).commit.ops).toEqual(["o_0001", "o_0002", "o_0003"]);
    expect(res(r).commit.author).toBe("ai");
    expect(r.head).toEqual({ op: "o_0003", pending: 0, detached: false });
    expect(r.warnings?.map((w) => w.code)).toEqual(["W_COMMIT_MESSAGE_STYLE"]);
  });

  test("message with MM:SS range has no style warning; body / tag / author are stored", async () => {
    const r = await run(commit, { allowEmpty: false, autoMessage: false, tag: "v1", author: "take" }, ["commit"], {
      message: "00:00.0〜00:03.0 名前を b に",
      body: "指示: rename",
    });
    expect(r.warnings).toEqual([]);
    expect(res(r).commit.body).toBe("指示: rename");
    expect(res(r).commit.tags).toEqual(["v1"]);
    expect(res(r).commit.author).toBe("take");
    const tags = res(await run(tagList, {})).tags;
    expect(tags[0].name).toBe("v1");
    expect(tags[0].target).toBe("k_0001");
  });

  test("--last keeps the rest pending; nothing to commit afterwards is E_NOTHING_TO_COMMIT", async () => {
    const r = await run(commit, { allowEmpty: false, autoMessage: false, last: 1 }, ["commit"], {
      message: "00:00.0 b",
    });
    expect(res(r).commit.ops).toEqual(["o_0003"]);
    // 残りの o_0001, o_0002 は HEAD の祖先で、コミット済み o_0003 で pending 判定が止まるため 0
    expect(r.head?.pending).toBe(0);
    expect(await codeOf(run(commit, { allowEmpty: false, autoMessage: false }, ["commit"], { message: "x" }))).toBe(
      "E_NOTHING_TO_COMMIT",
    );
    expect(await codeOf(run(commit, { allowEmpty: false, autoMessage: false }))).toBe("E_NOTHING_TO_COMMIT");
  });

  test("--ops a..b, --auto-message, missing -m", async () => {
    expect(await codeOf(run(commit, { allowEmpty: false, autoMessage: false }))).toBe("E_USAGE");
    const r = await run(commit, { allowEmpty: false, autoMessage: true, ops: "o_0002..o_0003" });
    expect(res(r).auto_message).toBe(true);
    expect(res(r).commit.ops).toEqual(["o_0002", "o_0003"]);
    expect(res(r).commit.message).toBe('set name = "a", set name = "b"');
  });

  test("--allow-empty", async () => {
    await run(commit, { allowEmpty: false, autoMessage: false }, ["commit"], { message: "00:00.0 all" });
    const r = await run(commit, { allowEmpty: true, autoMessage: false }, ["commit"], { message: "00:00.0 milestone" });
    expect(res(r).commit.ops).toEqual([]);
    expect(r.commit).toBe("k_0002");
  });

  test("style / range helpers", () => {
    expect(commitMessageStyleWarning("00:12.0〜00:15.0 の言い間違いをカット")).toBeNull();
    expect(commitMessageStyleWarning("1:02:03.0〜1:02:05.0 cut")).toBeNull();
    expect(commitMessageStyleWarning("名前を変更")?.code).toBe("W_COMMIT_MESSAGE_STYLE");
    expect(commitMessageStyleWarning(`00:01 ${"x".repeat(90)}`)?.detail?.problems).toHaveLength(1);
    const pending = ["o_0001", "o_0002", "o_0003"].map((id) => ({ id })) as never;
    expect(expandOpsRange("o_0002..o_0003", pending)).toEqual(["o_0002", "o_0003"]);
    expect(expandOpsRange("o_0003..o_0002", pending)).toEqual(["o_0002", "o_0003"]);
    expect(expandOpsRange("o_0002,o_0003", pending)).toEqual(["o_0002", "o_0003"]);
    expect(() => expandOpsRange("o_0002..o_0009", pending)).toThrow(MontashError);
    expect(() => expandOpsRange("garbage", pending)).toThrow(MontashError);
  });
});

describe("log / show / diff", () => {
  beforeEach(async () => {
    await setup();
    await setName("x", { message: "00:00.0〜00:00.0 名前を x に" }); // k_0001 = o_0001..o_0002
    await setName("y"); // o_0003 pending
  });

  test("log lists commits newest first with ops and pending", async () => {
    await run(commit, { allowEmpty: false, autoMessage: false }, ["commit"], { message: "名前を y に" }); // k_0002
    const r = await run(log, { ops: true, all: false, limit: 20, graph: false });
    const l = res(r);
    expect(l.commits.map((c: R) => c.id)).toEqual(["k_0002", "k_0001"]);
    expect(l.commits[0].ops.map((o: R) => o.id)).toEqual(["o_0003"]);
    expect(l.commits[0].ops[0].change_count).toBeGreaterThan(0);
    expect(l.pending).toEqual([]);
    expect(r.head?.pending).toBe(0);
    const g = await run(log, { ops: false, all: false, limit: 1, graph: true });
    expect(res(g).commits).toHaveLength(1);
    expect(typeof g.human === "function" ? g.human() : g.human).toContain("● k_0002");
    const grep = res(await run(log, { ops: false, all: false, limit: 20, graph: false, grep: "x に" }));
    expect(grep.commits.map((c: R) => c.id)).toEqual(["k_0001"]);
  });

  test("show op / commit with --patch", async () => {
    const op = res(await run(show, { ref: "o_0003", patch: true }));
    expect(op.kind).toBe("op");
    expect(op.op.id).toBe("o_0003");
    expect(op.changed_paths).toContain("/name");
    expect(op.changes.find((c: R) => c.path === "/name")).toEqual({
      op: "replace",
      path: "/name",
      from: "x",
      value: "y",
    });
    const noPatch = res(await run(show, { ref: "HEAD", patch: false }));
    expect(noPatch.changes).toBeUndefined();
    expect(noPatch.change_count).toBe(op.change_count);

    const k = res(await run(show, { ref: "k_0001", patch: true }));
    expect(k.kind).toBe("commit");
    expect(k.commit.id).toBe("k_0001");
    expect(k.changed_paths).toContain("/name"); // 空 → x の全体差分
    expect(await codeOf(run(show, { ref: "k_0009", patch: false }))).toBe("E_HISTORY_REF_NOT_FOUND");
  });

  test("diff without args is the pending diff; empty once committed; explicit refs", async () => {
    const pending = res(await run(diff, {}));
    expect(pending.from.op).toBe("o_0002");
    expect(pending.to.op).toBe("o_0003");
    expect(pending.changes.find((c: R) => c.path === "/name")?.value).toBe("y");

    await run(commit, { allowEmpty: false, autoMessage: false }, ["commit"], { message: "00:00.0 y" });
    const empty = res(await run(diff, {}));
    expect(empty.changes).toEqual([]);
    expect(empty.change_count).toBe(0);

    const explicit = res(await run(diff, { a: "o_0001", b: "HEAD" }));
    expect(explicit.from.op).toBe("o_0001");
    expect(explicit.to.op).toBe("o_0003");
    expect(explicit.changed_paths ?? explicit.changes.map((c: R) => c.path)).toContain("/name");
    const byCommit = res(await run(diff, { a: "k_0001", b: "k_0002" }));
    expect(byCommit.changes.find((c: R) => c.path === "/name")).toEqual({
      op: "replace",
      path: "/name",
      from: "x",
      value: "y",
    });
  });
});

describe("tag", () => {
  beforeEach(async () => {
    await setup();
    await setName("a");
  });

  test("tag HEAD with -m, list, checkout by tag, duplicate is E_TAG_EXISTS, delete", async () => {
    const t = await run(tag, { name: "before-x" }, ["tag", "before-x"], { message: "節目" });
    expect(res(t).tag).toMatchObject({ name: "before-x", target: "o_0002", op: "o_0002", message: "節目" });
    expect(t.head?.op).toBe("o_0002");
    expect(await codeOf(run(tag, { name: "before-x" }))).toBe("E_TAG_EXISTS");
    expect(await codeOf(run(tag, { name: "HEAD" }))).toBe("E_USAGE");

    await run(tag, { name: "root", ref: "o_0001" });
    const list = res(await run(tagList, {})).tags;
    expect(list.map((x: R) => x.name)).toEqual(["before-x", "root"]);

    await setName("b");
    const c = await run(checkout, { ref: "before-x" });
    expect(res(c).target.id).toBe("o_0002");
    expect((await loadProject(dir)).name).toBe("a");

    await run(tagDelete, { name: "root" });
    expect(res(await run(tagList, {})).tags).toHaveLength(1);
    expect(await codeOf(run(tagDelete, { name: "root" }))).toBe("E_TAG_NOT_FOUND");
  });

  test("tag on a commit id targets the commit", async () => {
    await run(commit, { allowEmpty: false, autoMessage: false }, ["commit"], { message: "00:00.0 a" });
    const t = res(await run(tag, { name: "v1", ref: "k_0001" }));
    expect(t.tag.target).toBe("k_0001");
    expect(t.tag.op).toBe("o_0002");
  });
});

describe("history verify / ids rebuild", () => {
  beforeEach(async () => {
    await setup();
    await setName("a");
  });

  test("verify ok with counts", async () => {
    await run(undo, {});
    const r = await run(historyVerify, {});
    expect(res(r)).toMatchObject({ ok: true, problems: [], counts: { ops: 2, commits: 0, moves: 1, tags: 0 } });
    expect(r.head?.op).toBe("o_0001");
  });

  test("verify detects a corrupted object", async () => {
    const { readdir, writeFile } = await import("node:fs/promises");
    const objects = join(dir, ".montash", "history", "objects");
    const [first] = (await readdir(objects)).filter((n) => n.endsWith(".json"));
    await writeFile(join(objects, first as string), '{"tampered":true}');
    const code = await codeOf(run(historyVerify, {}));
    expect(code).toBe("E_HISTORY_CORRUPT");
  });

  test("ids rebuild scans project and history objects", async () => {
    // 履歴 object に c3 を含む状態を作る（過去に存在したクリップ ID はカウンタに反映される）
    const project = await loadProject(dir);
    const { History } = await import("../../../src/core/history/index.ts");
    const h = await History.open(dir);
    const withClip = structuredClone(project) as unknown as { tracks: R[] };
    withClip.tracks[0]!.clips = [{ id: "c3" }];
    await h.store.putObject(withClip);
    const r = await run(idsRebuild, {});
    expect(res(r).counters.c).toBe(4);
    expect(res(r).counters.t).toBe(1);
    expect(res(r).objects_scanned).toBeGreaterThanOrEqual(3);
    expect((await readIds(dir))?.counters.c).toBe(4);
    expect(r.op).toBeNull();
    expect(r.head?.op).toBe("o_0002");
    // project.json は変更されない
    expect(hashProject(await loadProject(dir))).toBe(hashProject(project));
  });
});
