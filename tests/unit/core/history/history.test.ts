import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MontashError } from "../../../../src/cli/errors.ts";
import { applyChanges, autoMessage, canonicalHash, History } from "../../../../src/core/history/index.ts";
import { init, newClip, openHistory, sampleProject, step, tempDir, type Project } from "./helpers.ts";

let dir: string;
let cleanup: () => Promise<void>;
let h: History;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  h = await openHistory(dir);
});
afterEach(() => cleanup());

const objectCount = async () => (await readdir(join(h.store.dir, "objects"))).length;

async function expectError(p: Promise<unknown>, code: string): Promise<MontashError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(MontashError);
  expect((err as MontashError).code).toBe(code);
  return err as MontashError;
}

describe("recordOp", () => {
  test("空の履歴では HEAD が null。op を記録すると HEAD が進み parent が繋がる", async () => {
    expect(await h.status()).toEqual({ head: null, headOp: null, commit: null, pending: [], detached: false, tip: null });
    const { project: p0, op: o1 } = await init(h);
    expect(o1).toMatchObject({ id: "o_0001", parent: null, actor: "system", commit: null });
    expect(o1.before).toBe(o1.after);
    const { after: p1, op: o2 } = await step(h, p0, (p) => p.tracks[0]!.clips.push(newClip(300)), "add clip");
    expect(o2).toMatchObject({ id: "o_0002", parent: "o_0001", before: o1.after, after: canonicalHash(p1) });
    expect(o2.changes).toHaveLength(1);
    expect(o2.changes[0]).toMatchObject({ op: "add", path: "/tracks/0/clips/1" });
    expect(o2.affects.clips).toEqual([p1.tracks[0]!.clips[1]!.id]);
    expect(o2.affects.range_f).toEqual([300, 360]);
    const st = await h.status();
    expect(st).toMatchObject({ head: "o_0002", commit: null, detached: false, tip: "o_0002" });
    expect(st.pending.map((o) => o.id)).toEqual(["o_0001", "o_0002"]);
    expect(await h.store.getHead()).toBe("o_0002");
  });

  test("同じ状態に戻ると object 数は増えない（重複排除）", async () => {
    const { project: p0 } = await init(h);
    expect(await objectCount()).toBe(1);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { x: 1 }));
    expect(await objectCount()).toBe(2);
    await step(h, p1, (p) => delete p.meta); // p0 と同じ内容
    expect(await objectCount()).toBe(2);
    const st = await h.status();
    expect(st.headOp?.after).toBe(canonicalHash(p0));
  });

  test("before が HEAD.after と一致しなければ W_DIRTY_WORKTREE（例外にはしない）", async () => {
    const { project: p0 } = await init(h);
    const edited = structuredClone(p0);
    edited.meta = { hand: true };
    const after = structuredClone(edited);
    after.meta = { hand: true, more: 1 };
    const res = await h.recordOp({ before: edited, after, command: ["x"], actor: "human", summary: "s" });
    expect(res.warnings.map((w) => w.code)).toEqual(["W_DIRTY_WORKTREE"]);
    expect(res.op.before).toBe(canonicalHash(edited));
    expect(res.head.head).toBe(res.op.id);
    // status に project を渡すと dirty 判定
    expect((await h.status({ project: after })).dirty).toBe(false);
    expect((await h.status({ project: p0 })).dirty).toBe(true);
  });

  test("durationMs / actorDetail / affects の明示指定を保持する", async () => {
    const p0 = sampleProject();
    const { op } = await h.recordOp({ before: p0, after: p0, command: ["init"], actor: "ai", actorDetail: "sess-1", summary: "init", durationMs: 5, affects: { clips: ["c9"], range_f: [1, 2] } });
    expect(op).toMatchObject({ actor_detail: "sess-1", duration_ms: 5, affects: { clips: ["c9"], range_f: [1, 2] } });
    const [raw] = await h.store.readOps();
    expect(raw).toEqual(op);
  });
});

describe("undo / redo / checkout", () => {
  test("undo→redo で同じ object。undo 後に新 op を作ると分岐し、旧系列は残る", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { v: 1 }), "v1");
    const { after: p2 } = await step(h, p1, (p) => (p.meta = { v: 2 }), "v2");

    const u = await h.undo(1, "human");
    expect(u.target.id).toBe("o_0002");
    expect(u.project).toEqual(p1);
    expect(u.warnings.map((w) => w.code)).toEqual(["W_LEAVING_PENDING", "W_DETACHED_HEAD"]);
    expect(u.head.detached).toBe(true);
    expect(u.head.tip).toBe("o_0003");

    const r = await h.redo(1, "human");
    expect(r.target.id).toBe("o_0003");
    expect(r.project).toEqual(p2);
    expect(r.target.after).toBe(canonicalHash(p2));
    expect(r.warnings).toEqual([]);
    expect((await h.status()).detached).toBe(false);

    // undo → 新 op で分岐
    await h.undo(1, "human");
    const { after: p3, op: o4 } = await step(h, p1, (p) => (p.meta = { v: 3 }), "v3");
    expect(o4).toMatchObject({ id: "o_0004", parent: "o_0002" });
    const ids = (await h.store.readOps()).map((o) => o.id);
    expect(ids).toEqual(["o_0001", "o_0002", "o_0003", "o_0004"]);
    const st = await h.status();
    expect(st).toMatchObject({ head: "o_0004", detached: false, tip: "o_0004" });
    expect(st.pending.map((o) => o.id)).toEqual(["o_0001", "o_0002", "o_0004"]);

    // 旧系列はコミットすれば log --all に見える
    await h.checkout("o_0003", "human");
    const kOld = await h.commit({ message: "old branch", author: "ai" });
    await h.checkout("o_0004", "human");
    const kNew = await h.commit({ message: "new branch", author: "ai" });
    expect((await h.log()).entries.map((e) => e.commit.id)).toEqual([kNew.id]);
    expect((await h.log({ all: true })).entries.map((e) => e.commit.id)).toEqual([kNew.id, kOld.id]);
    expect((await h.checkout("o_0003", "human")).project).toEqual(p2);
    expect((await h.checkout("o_0004", "human")).project).toEqual(p3);
    // moves が記録されている
    const moves = await h.store.readMoves();
    expect(moves.map((m) => m.kind)).toEqual(["undo", "redo", "undo", "checkout", "checkout", "checkout", "checkout"]);
    expect(moves[0]).toMatchObject({ from: "o_0003", to: "o_0002", ref: "HEAD~1", last_op: "o_0003", actor: "human" });
  });

  test("redo は子が複数なら最後に HEAD だった系列を選び W_MULTIPLE_CHILDREN を返す", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { a: 1 }), "a"); // o_0002
    await h.undo(1, "human");
    const { after: p2 } = await step(h, p0, (p) => (p.meta = { b: 1 }), "b"); // o_0003 (parent o_0001)
    expect((await h.status()).tip).toBe("o_0003");

    // 直近の HEAD は o_0003 系列
    await h.undo(1, "human");
    let r = await h.redo(1, "human");
    expect(r.target.id).toBe("o_0003");
    expect(r.project).toEqual(p2);
    expect(r.warnings.map((w) => w.code)).toEqual(["W_MULTIPLE_CHILDREN"]);
    expect(r.warnings[0]?.detail).toMatchObject({ chosen: "o_0003", candidates: ["o_0002", "o_0003"] });

    // o_0002 系列へ checkout してから undo → redo は o_0002 を選ぶ
    await h.checkout("o_0002", "human");
    await h.undo(1, "human");
    expect((await h.status()).tip).toBe("o_0002");
    r = await h.redo(1, "human");
    expect(r.target.id).toBe("o_0002");
    expect(r.project).toEqual(p1);
    expect(r.warnings.map((w) => w.code)).toEqual(["W_MULTIPLE_CHILDREN"]);
  });

  test("端では E_NOTHING_TO_UNDO / E_NOTHING_TO_REDO", async () => {
    await expectError(h.undo(1, "human"), "E_NOTHING_TO_UNDO");
    await expectError(h.redo(1, "human"), "E_NOTHING_TO_REDO");
    const { project: p0 } = await init(h);
    await expectError(h.undo(1, "human"), "E_NOTHING_TO_UNDO");
    await expectError(h.redo(1, "human"), "E_NOTHING_TO_REDO");
    await step(h, p0, (p) => (p.meta = { a: 1 }));
    const err = await expectError(h.undo(2, "human"), "E_NOTHING_TO_UNDO");
    expect(err.detail).toMatchObject({ available: 1, requested: 2 });
    await expectError(h.redo(1, "human"), "E_NOTHING_TO_REDO");
    await h.undo(1, "human");
    await expectError(h.redo(2, "human"), "E_NOTHING_TO_REDO");
  });

  test("checkout は各種 ref を受け付け、pending があれば W_LEAVING_PENDING", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { v: 1 }));
    const k1 = await h.commit({ message: "v1", author: "ai", tags: ["v1"] });
    const { after: p2 } = await step(h, p1, (p) => (p.meta = { v: 2 }));
    await step(h, p2, (p) => (p.meta = { v: 3 }));

    const c = await h.checkout("k_0001", "human");
    expect(c.target.id).toBe("o_0002");
    expect(c.project).toEqual(p1);
    expect(c.warnings.map((w) => w.code)).toEqual(["W_LEAVING_PENDING", "W_DETACHED_HEAD"]);
    expect(c.warnings[0]?.detail).toMatchObject({ pending: ["o_0003", "o_0004"] });
    expect(c.head).toMatchObject({ head: "o_0002", commit: k1.id, detached: true, tip: "o_0004" });
    expect(c.head.pending).toEqual([]);

    // pending 無しの移動は W_LEAVING_PENDING を出さない
    expect((await h.checkout("tip", "human")).warnings.map((w) => w.code)).toEqual([]);
    expect((await h.status()).head).toBe("o_0004");
    // pending 系列内の移動（親へ）も pending は失われないが警告は出す
    expect((await h.checkout("HEAD~1", "human")).warnings.map((w) => w.code)).toEqual(["W_LEAVING_PENDING", "W_DETACHED_HEAD"]);
    expect((await h.checkout("v1", "human")).target.id).toBe("o_0002");
    expect((await h.checkout("o_0004", "web", "browser")).head.detached).toBe(false);
    await expectError(h.checkout("nope", "human"), "E_HISTORY_REF_NOT_FOUND");
  });
});

describe("commit", () => {
  test("pending を全部まとめる。commit 後 pending は 0、op.commit が補完される", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => p.tracks[0]!.clips.push(newClip(300)), "add c");
    const { after: p2 } = await step(h, p1, (p) => (p.tracks[0]!.clips[0]!.duration_f = 200), "trim c1");
    await step(h, p2, (p) => p.tracks[0]!.clips.splice(1, 1), "delete");
    const k = await h.commit({ message: "edit", body: "why", author: "ai", authorDetail: "sess" });
    expect(k).toMatchObject({ id: "k_0001", parent: null, ops: ["o_0001", "o_0002", "o_0003", "o_0004"], head: "o_0004", message: "edit", body: "why", author: "ai", author_detail: "sess", tags: [] });
    expect(k.stats).toEqual({ ops: 4, clips_added: 1, clips_removed: 1, clips_modified: 1 });
    const st = await h.status();
    expect(st.pending).toEqual([]);
    expect(st.commit).toBe("k_0001");
    expect(st.headOp?.commit).toBe("k_0001");
    expect((await h.ops()).every((o) => o.commit === "k_0001")).toBe(true);
    // ファイル上の op は commit: null のまま（追記専用）
    expect((await h.store.readOps()).every((o) => o.commit === null)).toBe(true);
    await expectError(h.commit({ message: "again", author: "ai" }), "E_NOTHING_TO_COMMIT");
    const empty = await h.commit({ message: "milestone", author: "human", allowEmpty: true });
    expect(empty).toMatchObject({ id: "k_0002", parent: "k_0001", ops: [], head: "o_0004" });
    expect(empty.stats.ops).toBe(0);
  });

  test("--last n / --ops は末尾側の連続部分のみ", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { v: 1 }), "v1");
    const { after: p2 } = await step(h, p1, (p) => (p.meta = { v: 2 }), "v2");
    await step(h, p2, (p) => (p.meta = { v: 3 }), "v3");
    const k1 = await h.commit({ message: "last two", author: "ai", last: 2 });
    expect(k1).toMatchObject({ ops: ["o_0003", "o_0004"], head: "o_0004", parent: null });
    // 残りは pending のまま（HEAD より前なので、pending 判定上は「コミット済みの下」になる）
    const st = await h.status();
    expect(st.pending).toEqual([]);
    expect((await h.log({ all: true })).pending.map((o) => o.id)).toEqual(["o_0001", "o_0002"]);

    const { after: p4 } = await step(h, structuredClone(p2), (p) => (p.meta = { v: 4 }), "v4");
    await step(h, p4, (p) => (p.meta = { v: 5 }), "v5");
    await expectError(h.commit({ message: "x", author: "ai", ops: ["o_0005"] }), "E_USAGE");
    await expectError(h.commit({ message: "x", author: "ai", ops: ["o_0002"] }), "E_USAGE");
    await expectError(h.commit({ message: "x", author: "ai", last: 3 }), "E_USAGE");
    const k2 = await h.commit({ message: "ops", author: "ai", ops: ["o_0006", "o_0005"] });
    expect(k2).toMatchObject({ id: "k_0002", parent: "k_0001", ops: ["o_0005", "o_0006"], head: "o_0006" });
  });

  test("detached でもコミットできる（その系列の tip になる）。タグも付く", async () => {
    const { project: p0 } = await init(h);
    await step(h, p0, (p) => (p.meta = { v: 1 }));
    await h.commit({ message: "base", author: "ai" });
    await h.undo(1, "human");
    await step(h, p0, (p) => (p.meta = { w: 1 }));
    const k = await h.commit({ message: "branch", author: "ai", tags: ["side"] });
    // 親コミットは分岐元 o_0001 を含む k_0001（先頭 op の parent が親コミットの途中にある）
    expect(k).toMatchObject({ id: "k_0002", parent: "k_0001", ops: ["o_0003"], head: "o_0003", tags: ["side"] });
    expect(await h.verify()).toEqual({ ok: true, problems: [] });
    expect(await h.listTags()).toEqual([{ name: "side", target: "k_0002", at: expect.any(String), op: "o_0003" }]);
    await step(h, { ...p0, meta: { w: 1 } }, (p) => (p.meta = { w: 2 }));
    await expectError(h.commit({ message: "dup", author: "ai", tags: ["side"] }), "E_TAG_EXISTS");
  });

  test("autoMessage は summary を連結し範囲を付記する", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => p.tracks[0]!.clips.push(newClip(300, 30)), "c2 を追加");
    await step(h, p1, (p) => (p.tracks[0]!.clips[0]!.duration_f = 100), "c1 をトリム");
    const st = await h.status();
    expect(autoMessage(st.pending)).toBe("init, c2 を追加, c1 をトリム — f:0–330 に影響");
    expect(autoMessage([])).toBe("(empty commit)");
    expect(autoMessage([{ ...st.pending[0]!, summary: "", affects: { clips: [], range_f: null } }])).toBe("1 op");
  });
});

describe("log / show", () => {
  test("既定は HEAD 系列の commit、新しい順。ops / limit / grep / author", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { v: 1 }), "v1");
    await h.commit({ message: "first cut", author: "ai" });
    const { after: p2 } = await step(h, p1, (p) => (p.meta = { v: 2 }), "v2");
    await h.commit({ message: "add BGM", author: "human" });
    await step(h, p2, (p) => (p.meta = { v: 3 }), "v3");

    const all = await h.log({ ops: true });
    expect(all.entries.map((e) => e.commit.id)).toEqual(["k_0002", "k_0001"]);
    expect(all.entries[0]?.ops?.map((o) => o.id)).toEqual(["o_0003"]);
    expect(all.entries[1]?.ops?.map((o) => o.id)).toEqual(["o_0001", "o_0002"]);
    expect(all.pending.map((o) => o.id)).toEqual(["o_0004"]);
    expect((await h.log({ limit: 1 })).entries.map((e) => e.commit.id)).toEqual(["k_0002"]);
    expect((await h.log({ grep: "bgm" })).entries.map((e) => e.commit.id)).toEqual(["k_0002"]);
    expect((await h.log({ author: "ai" })).entries.map((e) => e.commit.id)).toEqual(["k_0001"]);
    expect((await h.log()).entries[0]?.ops).toBeUndefined();
    // 別系列からは見えない
    await h.checkout("o_0001", "human");
    expect((await h.log()).entries).toEqual([]);
    expect((await h.log({ all: true })).entries).toHaveLength(2);
  });

  test("show は op / commit の差分と前後スナップショットを返す", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { v: 1 }));
    const { after: p2 } = await step(h, p1, (p) => (p.meta = { v: 2 }));
    await h.commit({ message: "m", author: "ai" });
    const so = await h.show("o_0002");
    expect(so.before).toEqual(p0);
    expect(so.after).toEqual(p1);
    expect(so.changes).toEqual([{ op: "add", path: "/meta", value: { v: 1 } }]);
    expect(so.commit?.id).toBe("k_0001");
    const sk = await h.show("k_0001");
    expect(sk.before).toEqual(p0);
    expect(sk.after).toEqual(p2);
    expect(sk.changes).toEqual([{ op: "add", path: "/meta", value: { v: 2 } }]);
    expect(sk.op.id).toBe("o_0003");
  });
});

describe("tag", () => {
  test("作成・一覧・削除・重複", async () => {
    const { project: p0 } = await init(h);
    await step(h, p0, (p) => (p.meta = { v: 1 }));
    const t = await h.tag("draft", "HEAD", "first draft");
    expect(t).toMatchObject({ name: "draft", target: "o_0002", op: "o_0002", message: "first draft" });
    await h.commit({ message: "m", author: "ai" });
    expect((await h.tag("rel", "k_0001")).target).toBe("k_0001");
    expect((await h.tag("prev", "k_0001~1")).target).toBe("o_0001");
    expect((await h.listTags()).map((t) => [t.name, t.target, t.op])).toEqual([
      ["draft", "o_0002", "o_0002"],
      ["prev", "o_0001", "o_0001"],
      ["rel", "k_0001", "o_0002"],
    ]);
    await expectError(h.tag("draft"), "E_TAG_EXISTS");
    await expectError(h.tag("HEAD"), "E_USAGE");
    await expectError(h.tag("o_0009"), "E_USAGE");
    await h.deleteTag("draft");
    await expectError(h.deleteTag("draft"), "E_TAG_NOT_FOUND");
    expect(JSON.parse(await readFile(h.store.path("tags.json"), "utf8"))).toEqual({
      rel: { target: "k_0001", at: expect.any(String) },
      prev: { target: "o_0001", at: expect.any(String) },
    });
  });
});

describe("revertChanges", () => {
  test("op / commit の逆差分を現在 HEAD に適用できる", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => p.tracks[0]!.clips.push(newClip(300)), "add");
    const { after: p2 } = await step(h, p1, (p) => (p.tracks[0]!.clips[0]!.duration_f = 100), "trim");
    await h.commit({ message: "m", author: "ai" });
    const { after: p3 } = await step(h, p2, (p) => (p.meta = { later: true }), "meta");

    const r = await h.revertChanges("o_0003");
    expect(r.conflicts).toEqual([]);
    const reverted = applyChanges(p3, r.changes) as Project;
    expect(reverted.tracks[0]!.clips[0]!.duration_f).toBe(300);
    expect(reverted.meta).toEqual({ later: true });

    const rk = await h.revertChanges("k_0001");
    expect(rk.conflicts).toEqual([]);
    expect(applyChanges(p3, rk.changes)).toEqual({ ...p0, meta: { later: true } });
  });

  test("対象が既に無ければ conflicts に列挙する", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.tracks[0]!.clips[0]!.duration_f = 100), "trim");
    await step(h, p1, (p) => p.tracks[0]!.clips.splice(0, 1), "delete c1");
    const r = await h.revertChanges("o_0002");
    expect(r.conflicts).toEqual(["/tracks/0/clips/0/duration_f"]);
    await expectError(h.revertChanges("o_0099"), "E_HISTORY_REF_NOT_FOUND");
  });
});

describe("verify", () => {
  test("正常系は ok", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { v: 1 }));
    await h.commit({ message: "a", author: "ai", tags: ["t1"] });
    await step(h, p1, (p) => (p.meta = { v: 2 }));
    await h.undo(1, "human");
    await step(h, p1, (p) => (p.meta = { v: 3 }));
    await h.commit({ message: "b", author: "ai", last: 1 });
    await h.commit({ message: "empty", author: "ai", allowEmpty: true });
    expect(await h.verify()).toEqual({ ok: true, problems: [] });
    expect((await History.open(dir)).verify()).resolves.toEqual({ ok: true, problems: [] });
  });

  test("ops.jsonl を壊すと問題を報告する", async () => {
    const { project: p0 } = await init(h);
    const { after: p1 } = await step(h, p0, (p) => (p.meta = { v: 1 }));
    await step(h, p1, (p) => (p.meta = { v: 2 }));
    await h.commit({ message: "a", author: "ai" });

    // 1) 行を書き換えて after を存在しないハッシュにする（不変条件 1, 2）
    const path = h.store.path("ops.jsonl");
    const original = await readFile(path, "utf8");
    const lines = original.trim().split("\n");
    const second = JSON.parse(lines[1]!) as { after: string };
    second.after = "sha1:0000000000000000000000000000000000000000";
    lines[1] = JSON.stringify(second);
    await writeFile(path, `${lines.join("\n")}\n`);
    let v = await h.verify();
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("object sha1:0000") && p.includes("missing"))).toBe(true);
    expect(v.problems.some((p) => p.includes("o_0003.before") && p.includes("o_0002.after"))).toBe(true);

    // 2) 壊れた JSON 行
    await writeFile(path, original);
    await appendFile(path, "garbage\n");
    v = await h.verify();
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain("E_HISTORY_CORRUPT");

    // 3) HEAD が存在しない op を指す
    await writeFile(path, original);
    await h.store.setHead("o_0099");
    v = await h.verify();
    expect(v.problems).toContain("HEAD points to unknown op o_0099");
    await h.store.setHead("o_0003");

    // 4) object の内容が改変された
    const target = h.store.objectPath(canonicalHash(p1));
    await writeFile(target, JSON.stringify({ tampered: true }));
    v = await h.verify();
    expect(v.problems.some((p) => p.includes("content hashes to"))).toBe(true);

    // 5) commit の連続性
    const cpath = h.store.path("commits.jsonl");
    const commit = JSON.parse((await readFile(cpath, "utf8")).trim()) as { ops: string[]; head: string; parent: string | null };
    commit.ops = ["o_0001", "o_0003"];
    await writeFile(cpath, `${JSON.stringify(commit)}\n`);
    v = await h.verify();
    expect(v.problems.some((p) => p.includes("k_0001: o_0003.parent"))).toBe(true);

    // 6) 親コミットの不整合
    commit.ops = ["o_0001", "o_0002", "o_0003"];
    commit.parent = "k_0000";
    await writeFile(cpath, `${JSON.stringify(commit)}\n`);
    v = await h.verify();
    expect(v.problems.some((p) => p.includes("k_0001.parent k_0000 does not exist"))).toBe(true);
    expect(v.problems.some((p) => p.includes("descends from the root but k_0001.parent is k_0000"))).toBe(true);
  });
});
