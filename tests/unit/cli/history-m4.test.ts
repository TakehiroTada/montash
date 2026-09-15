/**
 * M4 の履歴コマンド: `revert` / `blame` / `reset --hard` / `history prune|export|import`。
 * 一時プロジェクトに対して handler を直接呼ぶ（history-commands.test.ts と同じ流儀）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blame } from "../../../src/cli/commands/blame.ts";
import { commit } from "../../../src/cli/commands/commit.ts";
import { historyExport, historyImport, historyPrune, historyVerify } from "../../../src/cli/commands/history.ts";
import { log } from "../../../src/cli/commands/log.ts";
import { projectSet } from "../../../src/cli/commands/project.ts";
import { redo } from "../../../src/cli/commands/redo.ts";
import { reset } from "../../../src/cli/commands/reset.ts";
import { revert } from "../../../src/cli/commands/revert.ts";
import { trackAdd } from "../../../src/cli/commands/track.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandResult, CommandSpec } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: true,
  quiet: true,
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

async function run<A extends Record<string, unknown>>(
  spec: CommandSpec<A>,
  args: Partial<A> = {},
  argv: string[] = [spec.path],
  over: Partial<GlobalOptions> = {},
): Promise<CommandResult> {
  return spec.handler(mkCtx(argv, over), args as A);
}

// biome-ignore lint/suspicious/noExplicitAny: テストでは result を素の JSON として読む
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

async function setup(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "montash-m4-history-"));
  const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 320, height: 180 } });
  await initProjectDir(dir, project, { force: true });
  await recordInitialOp(dir, project, mkCtx(["init", dir]));
}

const setName = (name: string, over: Partial<GlobalOptions> = {}) =>
  run(projectSet, { key: "name", value: name }, ["project", "set", "name", name], over);

describe("revert", () => {
  test("コミットを revert すると状態が戻り、もう一度 revert すると元に戻る", async () => {
    await setup();
    await setName("before");
    await run(commit, {}, ["commit"], { message: "名前を before に" });
    await setName("after");
    const committed = await run(commit, {}, ["commit"], { message: "名前を after に" });
    expect(res(committed).commit.id).toBe("k_0002");
    expect((await loadProject(dir)).name).toBe("after");

    const r1 = await run(revert, { ref: "k_0002" }, ["revert", "k_0002"]);
    expect(res(r1).reverted.ref).toBe("k_0002");
    expect(res(r1).reverted.message).toBe("名前を after に");
    expect(r1.op).toBe("o_0004");
    expect((await loadProject(dir)).name).toBe("before");

    // revert の revert で元に戻る（往復）
    await run(revert, { ref: "o_0004" }, ["revert", "o_0004"]);
    expect((await loadProject(dir)).name).toBe("after");
    expect(res(await run(historyVerify)).ok).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("-m を付けると即コミットされ、summary は `revert <ref>: <元のメッセージ>`", async () => {
    await setup();
    await run(commit, {}, ["commit"], { message: "プロジェクトを初期化" });
    await setName("x");
    await run(commit, {}, ["commit"], { message: "名前を x に" });
    const r = await run(revert, { ref: "k_0002" }, ["revert", "k_0002"], { message: "x を取り消し" });
    expect(r.commit).toBe("k_0003");
    const commits = res(await run(log, { ops: true, limit: 20 })).commits as R[];
    const newest = commits[0] as R;
    expect(newest.message).toBe("x を取り消し");
    expect((newest.ops as R[])[0]?.summary).toBe("revert k_0002: 名前を x に");
    await rm(dir, { recursive: true, force: true });
  });

  test("初期化コミットの revert は E_REVERT_CONFLICT（空のプロジェクトになるため）", async () => {
    await setup();
    await run(commit, {}, ["commit"], { message: "プロジェクトを初期化" });
    expect(await codeOf(run(revert, { ref: "k_0001" }, ["revert", "k_0001"]))).toBe("E_REVERT_CONFLICT");
    await rm(dir, { recursive: true, force: true });
  });

  test("逆差分の対象が既に無ければ E_REVERT_CONFLICT", async () => {
    await setup();
    await run(trackAdd, { kind: "video" }, ["track", "add", "--kind", "video"]);
    const added = await run(trackAdd, { kind: "audio" }, ["track", "add", "--kind", "audio"]);
    expect(added.op).toBe("o_0003");
    // 追加したトラックを直接消して、逆差分（削除）の対象を失わせる
    const project = await loadProject(dir);
    project.tracks = [];
    await Bun.write(join(dir, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
    await setName("touch"); // worktree を op 化して HEAD を進める

    const err = await codeOf(run(revert, { ref: "o_0003" }, ["revert", "o_0003"]));
    expect(err).toBe("E_REVERT_CONFLICT");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("blame", () => {
  test("要素を最後に変更した op / commit / actor を返す", async () => {
    await setup();
    const t1 = res(await run(trackAdd, { kind: "video" }, ["track", "add", "--kind", "video"])).track as R;
    await run(commit, {}, ["commit"], { message: "V トラックを追加" });
    await run(trackAdd, { kind: "audio" }, ["track", "add", "--kind", "audio"]);

    const r = res(await run(blame, { element: t1.id }, ["blame", t1.id]));
    expect(r.element).toBe(t1.id);
    expect(r.op.id).toBe("o_0002");
    expect(r.actor).toBe("ai");
    expect(r.commit.message).toBe("V トラックを追加");
    expect(r.change_count).toBeGreaterThan(0);
    await rm(dir, { recursive: true, force: true });
  });

  test("知らない要素は E_HISTORY_REF_NOT_FOUND", async () => {
    await setup();
    expect(await codeOf(run(blame, { element: "nope" }, ["blame", "nope"]))).toBe("E_HISTORY_REF_NOT_FOUND");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("reset --hard", () => {
  test("既定の log から外れ、--all では見える。redo も辿らない", async () => {
    await setup();
    await setName("a");
    await run(commit, {}, ["commit"], { message: "a にする" });
    await setName("b");
    await run(commit, {}, ["commit"], { message: "b にする" });

    const r = await run(reset, { ref: "k_0001", hard: true }, ["reset", "--hard", "k_0001"]);
    expect(res(r).reset.discarded).toEqual(["o_0003"]);
    expect((await loadProject(dir)).name).toBe("a");

    const def = res(await run(log, { limit: 20 }));
    expect((def.commits as R[]).map((c) => c.id)).toEqual(["k_0001"]);
    const all = res(await run(log, { limit: 20, all: true }));
    expect((all.commits as R[]).map((c) => c.id)).toEqual(["k_0002", "k_0001"]);
    expect(all.reset).toEqual(["o_0003"]);

    // 捨てた系列へは redo で進まない
    expect(await codeOf(run(redo, {}, ["redo"]))).toBe("E_NOTHING_TO_REDO");
    // 物理削除はしていないので verify は通る
    expect(res(await run(historyVerify)).ok).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("--yes が無く非対話なら E_CONFIRM_REQUIRED、--hard が無ければ E_USAGE", async () => {
    await setup();
    await setName("a");
    expect(await codeOf(run(reset, { ref: "o_0001", hard: true }, ["reset", "--hard", "o_0001"], { yes: false }))).toBe(
      "E_CONFIRM_REQUIRED",
    );
    expect(await codeOf(run(reset, { ref: "o_0001", hard: false }, ["reset", "o_0001"]))).toBe("E_USAGE");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("history prune", () => {
  test("--dry-run は対象を列挙するだけで、既定はコミット済み op を守る", async () => {
    await setup();
    await setName("a");
    await run(commit, {}, ["commit"], { message: "a にする" });
    await setName("b"); // pending のまま

    // 既定（--keep-days 30）では何も消えない
    const keep = res(
      await run(historyPrune, { keepCommits: 100, keepDays: 30 }, ["history", "prune"], { dryRun: true }),
    );
    expect(keep.dry_run).toBe(true);
    expect(keep.ops).toEqual([]);

    // HEAD 上の op は「古く」ても守られる（HEAD = o_0003）
    const aggressive = res(
      await run(historyPrune, { keepCommits: 0, keepDays: 0 }, ["history", "prune"], { dryRun: true }),
    );
    expect(aggressive.ops).toEqual([]);
    expect(aggressive.kept.ops).toBe(3);
    // dry-run なので何も消えていない
    expect(res(await run(historyVerify)).counts.ops).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });

  test("参照されなくなった op と object を実際に消しても verify が通る", async () => {
    await setup();
    await setName("a");
    await run(commit, {}, ["commit"], { message: "a にする" });
    await setName("b"); // o_0003（pending）
    // HEAD を戻して o_0003 を系列から外す
    await run(reset, { ref: "k_0001", hard: true }, ["reset", "--hard", "k_0001"]);

    const dry = res(await run(historyPrune, { keepCommits: 0, keepDays: 0 }, ["history", "prune"], { dryRun: true }));
    expect(dry.ops).toEqual(["o_0003"]);
    const applied = res(await run(historyPrune, { keepCommits: 0, keepDays: 0 }, ["history", "prune"]));
    expect(applied.dry_run).toBe(false);
    expect(applied.ops).toEqual(["o_0003"]);
    expect(applied.objects.length).toBeGreaterThan(0);
    const verified = res(await run(historyVerify));
    expect(verified.ok).toBe(true);
    expect(verified.counts.ops).toBe(2);
    // prune 後も ID は再利用しない
    const next = await setName("c");
    expect(next.op).toBe("o_0004");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("history export / import", () => {
  test("export → 履歴を消して import で往復する", async () => {
    await setup();
    await setName("a");
    await run(commit, {}, ["commit"], { message: "a にする" });
    await setName("b");
    const before = res(await run(log, { limit: 20, all: true, ops: true }));

    const file = join(dir, "history.jsonl");
    const exported = res(await run(historyExport, { out: file }, ["history", "export", "-o", file]));
    expect(exported.counts.ops).toBe(3);
    expect(exported.lines).toBeGreaterThan(exported.counts.ops);

    await rm(join(dir, ".montash", "history"), { recursive: true, force: true });
    const imported = res(await run(historyImport, { file }, ["history", "import", file]));
    expect(imported.added.ops).toBe(3);
    expect(imported.head).toBe("o_0003");
    expect(res(await run(historyVerify)).ok).toBe(true);

    const after = res(await run(log, { limit: 20, all: true, ops: true }));
    expect(after.commits).toEqual(before.commits);
    expect((after.pending as R[]).map((p) => p.id)).toEqual((before.pending as R[]).map((p) => p.id));
    await rm(dir, { recursive: true, force: true });
  });

  test("ID が衝突する import は E_HISTORY_IMPORT_CONFLICT", async () => {
    await setup();
    await setName("a");
    const file = join(dir, "history.jsonl");
    await run(historyExport, { out: file }, ["history", "export", "-o", file]);
    expect(await codeOf(run(historyImport, { file }, ["history", "import", file]))).toBe("E_HISTORY_IMPORT_CONFLICT");
    await rm(dir, { recursive: true, force: true });
  });
});
