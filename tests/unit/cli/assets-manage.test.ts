/**
 * 素材管理コマンド（docs/04 §4, W-13 / W-17）。
 * ハンドラを直接呼び、一時プロジェクトの project.json とファイルシステムを検査する。
 * テキスト素材を使うことで ffprobe に依存せず動く。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetsNewText,
  assetsRelink,
  assetsRemove,
  assetsSet,
  assetsSetText,
  assetsShow,
} from "../../../src/cli/commands/assets.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import type { CommandSpec } from "../../../src/cli/define-command.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject, saveProject } from "../../../src/core/project.ts";
import { type ProjectInput, ProjectSchema } from "../../../src/core/schema.ts";

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
let outside: string;

const ctxFor = (argv: string[], over: Partial<GlobalOptions> = {}) =>
  createContext(globals({ project: dir, ...over }), { cwd: dir, env: { MONTASH_ACTOR: "ai" }, isTTY: false, argv });

/** ハンドラを直接呼ぶ（yargs を経由しない） */
async function call(
  spec: CommandSpec<Record<string, unknown>>,
  args: Record<string, unknown>,
  over: Partial<GlobalOptions> = {},
) {
  return spec.handler(ctxFor(spec.path.split(" "), over), args);
}

/** 失敗を期待する（MontashError の code を返す） */
async function failure(
  spec: CommandSpec<Record<string, unknown>>,
  args: Record<string, unknown>,
  over: Partial<GlobalOptions> = {},
): Promise<MontashError> {
  try {
    await call(spec, args, over);
  } catch (e) {
    expect(e).toBeInstanceOf(MontashError);
    return e as MontashError;
  }
  throw new Error(`${spec.path} unexpectedly succeeded`);
}

const sha256 = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

/** project.json を直接組み立てる（クリップやリンクの前提を用意するため） */
async function writeProject(mutate: (p: ProjectInput) => void): Promise<void> {
  const project = (await loadProject(dir)) as unknown as ProjectInput;
  mutate(project);
  await saveProject(dir, ProjectSchema.parse(project));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "montash-assets-"));
  outside = await mkdtemp(join(tmpdir(), "montash-assets-src-"));
  const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
  await initProjectDir(dir, project, { force: true });
  await recordInitialOp(dir, project, ctxFor(["init", dir]));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("assets set", () => {
  beforeEach(async () => {
    await call(assetsNewText, { id: "title", text: "Summer Trip" });
  });

  test("sets label, replaces tags, then adds and removes single tags", async () => {
    const set = await call(assetsSet, { id: "title", label: "タイトル", tags: "空撮, 冒頭 ,空撮" });
    expect((set.result as { asset: { label: string; tags: string[] } }).asset.tags).toEqual(["空撮", "冒頭"]);
    expect(set.op).toBe("o_0003");
    await call(assetsSet, { id: "title", "add-tag": ["drone"], "remove-tag": ["空撮"] });
    const asset = (await loadProject(dir)).assets.title!;
    expect(asset.tags).toEqual(["冒頭", "drone"]);
    expect(asset.label).toBe("タイトル");
  });

  test("stores color and note, and clears them with an empty string", async () => {
    await call(assetsSet, { id: "title", color: "#3B82F6", note: "冒頭で使う" });
    let asset = (await loadProject(dir)).assets.title!;
    expect(asset.color).toBe("#3B82F6");
    expect(asset.note).toBe("冒頭で使う");
    await call(assetsSet, { id: "title", color: "", note: "", label: "" });
    asset = (await loadProject(dir)).assets.title!;
    expect(asset.color).toBeUndefined();
    expect(asset.note).toBeUndefined();
    expect(asset.label).toBeUndefined();
  });

  test("re-running with the same values records no op", async () => {
    await call(assetsSet, { id: "title", label: "x" });
    const again = await call(assetsSet, { id: "title", label: "x" });
    expect(again.op).toBeNull();
  });

  test("rejects unknown IDs, missing options and invalid colors", async () => {
    expect((await failure(assetsSet, { id: "nope", label: "x" })).code).toBe("E_ASSET_NOT_FOUND");
    expect((await failure(assetsSet, { id: "title" })).code).toBe("E_USAGE");
    expect((await failure(assetsSet, { id: "title", color: "blue" })).code).toBe("E_USAGE");
  });
});

describe("assets new-text / set-text", () => {
  test("creates assets/text/<id>.txt and round-trips the body through set-text", async () => {
    const created = await call(assetsNewText, {
      id: "title",
      text: "Summer Trip\n2026",
      label: "タイトル",
      tags: "telop",
    });
    const asset = (created.result as { asset: Record<string, unknown> }).asset;
    expect(asset.path).toBe(join("assets", "text", "title.txt"));
    expect(asset.owned).toBe(true);
    expect(asset.type).toBe("text");
    expect(asset.text_preview).toBe("Summer Trip\n2026");
    expect(asset.line_count).toBe(2);
    expect(asset.tags).toEqual(["telop"]);
    expect(await Bun.file(join(dir, "assets/text/title.txt")).text()).toBe("Summer Trip\n2026");

    await call(assetsSetText, { id: "title", text: "Summer Trip 2027" });
    expect(await Bun.file(join(dir, "assets/text/title.txt")).text()).toBe("Summer Trip 2027");
    const updated = (await loadProject(dir)).assets.title!;
    expect(updated.type === "text" && updated.text_preview).toBe("Summer Trip 2027");
    expect(updated.type === "text" && updated.line_count).toBe(1);
    expect(updated.size).toBe(16);
    const shown = await call(assetsShow, { id: "title" });
    expect((shown.result as { text: string }).text).toBe("Summer Trip 2027");
  });

  test("previews only the first 80 characters", async () => {
    const body = "あ".repeat(100);
    const created = await call(assetsNewText, { id: "long", text: body });
    const asset = (created.result as { asset: { text_preview: string } }).asset;
    expect(asset.text_preview).toHaveLength(80);
  });

  test("reads the body from --text-file", async () => {
    const path = join(outside, "body.txt");
    await writeFile(path, "ファイルから\n", "utf8");
    await call(assetsNewText, { id: "from_file", "text-file": path });
    expect(await Bun.file(join(dir, "assets/text/from_file.txt")).text()).toBe("ファイルから\n");
  });

  test("rejects duplicate IDs, both/neither text sources and unreadable files", async () => {
    await call(assetsNewText, { id: "title", text: "a" });
    expect((await failure(assetsNewText, { id: "title", text: "b" })).code).toBe("E_ID_EXISTS");
    expect((await failure(assetsNewText, { id: "other" })).code).toBe("E_USAGE");
    expect((await failure(assetsNewText, { id: "other", text: "a", "text-file": "x.txt" })).code).toBe("E_USAGE");
    expect((await failure(assetsNewText, { id: "other", "text-file": join(outside, "nope.txt") })).code).toBe(
      "E_ASSET_MISSING",
    );
  });

  test("set-text refuses imported (not owned) files and non-text assets", async () => {
    const external = join(outside, "external.txt");
    await writeFile(external, "外部ファイル", "utf8");
    await writeProject((p) => {
      p.assets!.external = {
        id: "external",
        type: "text",
        path: external,
        owned: false,
        tags: [],
        duration_s: null,
        duration_f: null,
        text_preview: "外部ファイル",
        line_count: 1,
      };
      p.assets!.movie = {
        id: "movie",
        type: "video",
        path: join(outside, "movie.mp4"),
        owned: false,
        tags: [],
        duration_s: 5,
        duration_f: 150,
      };
    });
    const notOwned = await failure(assetsSetText, { id: "external", text: "書き換え" });
    expect(notOwned.code).toBe("E_ASSET_NOT_OWNED");
    expect(notOwned.hint).toContain("--copy");
    // 元素材は非破壊（docs/04 §4）
    expect(await Bun.file(external).text()).toBe("外部ファイル");
    expect((await failure(assetsSetText, { id: "movie", text: "x" })).code).toBe("E_ASSET_TYPE_MISMATCH");
    expect((await failure(assetsSetText, { id: "nope", text: "x" })).code).toBe("E_ASSET_NOT_FOUND");
  });

  test("--dry-run writes neither the file nor the project", async () => {
    const before = await Bun.file(join(dir, "project.json")).text();
    const res = await call(assetsNewText, { id: "title", text: "a" }, { dryRun: true });
    expect(res.op).toBeNull();
    expect(existsSync(join(dir, "assets/text/title.txt"))).toBe(false);
    expect(await Bun.file(join(dir, "project.json")).text()).toBe(before);
  });
});

describe("assets remove", () => {
  /** V1: c1（clip_a）と c3（clip_a）が x1 で繋がり、c1 は別素材の音声 c2 とリンクしている */
  async function withTimeline() {
    await writeProject((p) => {
      p.assets!.clip_a = {
        id: "clip_a",
        type: "video",
        path: join(outside, "clip_a.mp4"),
        owned: false,
        tags: [],
        duration_s: 5,
        duration_f: 150,
      };
      p.assets!.narration = {
        id: "narration",
        type: "audio",
        path: join(outside, "narration.wav"),
        owned: false,
        tags: [],
        duration_s: 10,
        duration_f: 300,
      };
      p.tracks![0]!.clips = [
        { id: "c1", type: "media", asset: "clip_a", start_f: 0, in_f: 0, out_f: 30, link: "c2" },
        { id: "c3", type: "media", asset: "clip_a", start_f: 30, in_f: 60, out_f: 90, link: null },
      ];
      p.tracks![1]!.clips = [
        { id: "c2", type: "media", asset: "narration", start_f: 0, in_f: 0, out_f: 30, link: "c1" },
      ];
      p.transitions = [{ id: "x1", track: "V1", from: "c1", to: "c3", type: "fade", duration_f: 10 }];
    });
  }

  test("refuses to remove an asset in use and lists the referencing clips", async () => {
    await withTimeline();
    const err = await failure(assetsRemove, { id: "clip_a" });
    expect(err.code).toBe("E_ASSET_IN_USE");
    const clips = (err.detail as { clips: Array<{ id: string }> }).clips;
    expect(clips.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect((await loadProject(dir)).assets.clip_a).toBeDefined();
  });

  test("--force removes referencing clips, the linked audio clip and spanning transitions", async () => {
    await withTimeline();
    const res = await call(assetsRemove, { id: "clip_a", force: true });
    const result = res.result as { clips: Array<{ id: string }>; transitions: string[] };
    expect(result.clips.map((c) => c.id).sort()).toEqual(["c1", "c2", "c3"]);
    expect(result.transitions).toEqual(["x1"]);
    expect(res.warnings?.map((w) => w.code)).toContain("W_TRANSITION_REMOVED");
    const project = await loadProject(dir);
    expect(project.assets.clip_a).toBeUndefined();
    expect(project.tracks.flatMap((t) => t.clips)).toEqual([]);
    expect(project.transitions).toEqual([]);
    // リンク相手の素材そのものは残る
    expect(project.assets.narration).toBeDefined();
  });

  test("deletes the owned text file and the derived cache directory", async () => {
    await call(assetsNewText, { id: "title", text: "Summer Trip" });
    const cache = join(dir, ".montash/cache/title");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "probe.json"), "{}", "utf8");
    const res = await call(assetsRemove, { id: "title" });
    expect((res.result as { files: string[] }).files).toHaveLength(2);
    expect(existsSync(join(dir, "assets/text/title.txt"))).toBe(false);
    expect(existsSync(cache)).toBe(false);
  });

  test("keeps external files on disk", async () => {
    const external = join(outside, "external.txt");
    await writeFile(external, "外部", "utf8");
    await writeProject((p) => {
      p.assets!.external = {
        id: "external",
        type: "text",
        path: external,
        owned: false,
        tags: [],
        duration_s: null,
        duration_f: null,
      };
    });
    await call(assetsRemove, { id: "external" });
    expect(existsSync(external)).toBe(true);
  });
});

describe("assets relink", () => {
  /** 4 つのテキスト素材を outside に作り、moved/ に移して欠落状態にする */
  async function movedAssets() {
    const moved = join(outside, "moved");
    await mkdir(moved, { recursive: true });
    const files = {
      byname: { body: "name matching\n", to: "byname.txt" },
      bysize: { body: "size matching only!!\n", to: "renamed-size.txt" },
      byhash: { body: "hash matching only\n", to: "renamed-hash.txt" },
      gone: { body: "not moved anywhere at all\n", to: null },
    };
    await writeProject((p) => {
      for (const [id, spec] of Object.entries(files)) {
        p.assets![id] = {
          id,
          type: "text",
          path: join(outside, `${id}.txt`),
          owned: false,
          tags: [],
          duration_s: null,
          duration_f: null,
          size: Buffer.byteLength(spec.body),
          hash_head: sha256(spec.body),
          text_preview: spec.body,
          line_count: 2,
        };
      }
      // 名前だけで当てる素材は、サイズもハッシュも一致しないようにしておく
      p.assets!.byname!.size = 99_999;
      p.assets!.byname!.hash_head = sha256("something else");
      // ハッシュだけで当てる素材はサイズを外す（名前は移動先で変わる）
      p.assets!.byhash!.size = 88_888;
    });
    for (const [id, spec] of Object.entries(files)) {
      const from = join(outside, `${id}.txt`);
      await writeFile(from, spec.body, "utf8");
      if (spec.to) await rename(from, join(moved, spec.to));
      else await rm(from, { force: true });
    }
    return moved;
  }

  test("--search resolves by name, size and hash and reports what is left", async () => {
    const moved = await movedAssets();
    const res = await call(assetsRelink, { search: moved });
    const result = res.result as {
      relinked: Array<{ id: string; from: string; to: string; matched_by: string }>;
      unresolved: string[];
    };
    const by = Object.fromEntries(result.relinked.map((r) => [r.id, r.matched_by]));
    expect(by).toEqual({ byname: "name", bysize: "size", byhash: "hash" });
    expect(result.unresolved).toEqual(["gone"]);
    expect(result.relinked[0]?.from).toBe(join(outside, "byname.txt"));

    const project = await loadProject(dir);
    expect(project.assets.bysize!.path).toBe(join(moved, "renamed-size.txt"));
    // 再リンク後は指紋とプレビューを取り直す
    expect(project.assets.byname!.size).toBe(Buffer.byteLength("name matching\n"));
    expect(project.assets.byname!.hash_head).toBe(sha256("name matching\n"));
    const relinked = project.assets.byhash!;
    expect(relinked.type === "text" && relinked.text_preview).toBe("hash matching only\n");
  });

  test("--match puts the requested rule first", async () => {
    const moved = await movedAssets();
    // "byname.txt" は名前が一致する移動先があるが、ハッシュは別ファイル（bysize の中身）に一致させる
    const confuse = () =>
      writeProject((p) => {
        p.assets!.byname!.path = join(outside, "byname.txt");
        p.assets!.byname!.size = 99_999;
        p.assets!.byname!.hash_head = sha256("size matching only!!\n");
      });
    await confuse();
    const byName = await call(assetsRelink, { id: "byname", search: moved });
    expect((byName.result as { relinked: Array<{ to: string; matched_by: string }> }).relinked[0]).toMatchObject({
      matched_by: "name",
      to: join(moved, "byname.txt"),
    });
    await confuse();
    const byHash = await call(assetsRelink, { id: "byname", search: moved, match: "hash" });
    expect((byHash.result as { relinked: Array<{ to: string; matched_by: string }> }).relinked[0]).toMatchObject({
      matched_by: "hash",
      to: join(moved, "renamed-size.txt"),
    });
  });

  test("--path relinks a single asset and marks derived files stale", async () => {
    const moved = await movedAssets();
    await writeProject((p) => {
      p.assets!.bysize!.derived = { proxy: { state: "ready", path: ".montash/cache/bysize/proxy.mp4" } };
    });
    const res = await call(assetsRelink, { id: "bysize", path: join(moved, "renamed-size.txt") });
    expect((res.result as { relinked: Array<{ matched_by: string }> }).relinked[0]?.matched_by).toBe("path");
    const project = await loadProject(dir);
    expect(project.assets.bysize!.path).toBe(join(moved, "renamed-size.txt"));
    expect(project.assets.bysize!.derived?.proxy?.state).toBe("stale");
  });

  test("nothing to relink records no op; bad usage is rejected", async () => {
    const moved = await movedAssets();
    await call(assetsRelink, { search: moved });
    const again = await call(assetsRelink, { search: moved });
    expect(again.op).toBeNull();
    expect((again.result as { relinked: unknown[] }).relinked).toEqual([]);
    expect((await failure(assetsRelink, { id: "gone" })).code).toBe("E_USAGE");
    expect((await failure(assetsRelink, { path: "/tmp/x.txt" })).code).toBe("E_USAGE");
    expect((await failure(assetsRelink, { id: "gone", path: join(outside, "nope.txt") })).code).toBe("E_ASSET_MISSING");
    expect((await failure(assetsRelink, { search: join(outside, "nope") })).code).toBe("E_ASSET_MISSING");
  });
});
