/**
 * プラグインが足す CLI コマンド（docs/14 §3.3、計画 P3-4）。AviUtl2 の「汎用プラグイン」に相当。
 *
 * 固定したいのは 4 つ:
 *   1. 登録したコマンドが `getCommands()` / `schema` / `help` の 3 者すべてに現れる（P0-6 の仕組みに乗る）
 *   2. 名前空間はプラグイン ID の末尾セグメント。**組み込みの上書きは必ず拒否**（E_PLUGIN_COMMAND_CONFLICT）
 *   3. `mutates: true` の変更は必ず `runMutation()` 経由（project.json を直に書かない。docs/14 原則 4）
 *   4. プラグインが 1 つも無ければコマンド数は組み込みのまま（既存の挙動を変えない）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { help } from "../../../src/cli/commands/help.ts";
import { commands as builtinCommands } from "../../../src/cli/commands/registry.ts";
import { schema } from "../../../src/cli/commands/schema.ts";
import { createContext, type GlobalOptions } from "../../../src/cli/context.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { recordInitialOp } from "../../../src/cli/mutate.ts";
import { createProject, initProjectDir, loadProject } from "../../../src/core/project.ts";
import { clearLoadedPlugins, loadAllPlugins, loadedPlugins } from "../../../src/plugins/loader.ts";
import { clearRegisteredCommands, getCommands, registeredCommands } from "../../../src/registry/commands.ts";
import { clearRegisteredRequirements, requiredFilters } from "../../../src/registry/requirements.ts";

/** 組み込みコマンド数。プラグインが無ければここから 1 つも増減しない（docs/04） */
const BUILTIN_COMMAND_COUNT = 101;

const globals = (over: Partial<GlobalOptions> = {}): GlobalOptions => ({
  json: false,
  quiet: false,
  verbose: false,
  dryRun: false,
  yes: false,
  noColor: true,
  timeFormat: "seconds",
  ...over,
});

const ctx = (cwd = process.cwd()) => createContext(globals(), { cwd, env: {}, isTTY: false });

const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "montash-plugin-cmd-"));
  roots.push(d);
  return d;
}
const envWith = (dir: string) => ({ MONTASH_PLUGIN_PATH: dir }) as NodeJS.ProcessEnv;

/** `register(host)` の中身だけを書けば、1 つのプラグインとして置ける */
async function makePlugin(root: string, id: string, body: string): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "montash-plugin.json"), JSON.stringify({ id, apiVersion: 1, version: "1.0.0" }));
  await writeFile(join(dir, "index.js"), `export default { register(host) {\n${body}\n} };\n`);
  return dir;
}

/** 1 つ載せて読み込む。失敗は呼び出し側で見る */
async function loadOne(id: string, body: string) {
  const root = await tmpRoot();
  await makePlugin(root, id, body);
  return loadAllPlugins(null, { env: envWith(root) });
}

const COUNT_COMMAND = `
  host.commands.define({
    path: "count",
    summary: "count the clips (from a plugin)",
    noProject: true,
    examples: [{ cmd: "montash demo count" }],
    options: { unit: { type: "string", describe: "unit label", default: "clip" } },
    run: (c) => ({ result: { clips: (c.project?.tracks ?? []).flatMap((t) => t.clips ?? []).length } }),
  });
`;

afterEach(() => {
  clearLoadedPlugins();
  clearRegisteredCommands();
  clearRegisteredRequirements();
});

describe("プラグインが無ければ何も変わらない", () => {
  test("コマンド数は組み込みのまま", async () => {
    expect(builtinCommands).toHaveLength(BUILTIN_COMMAND_COUNT);
    expect(await getCommands()).toHaveLength(BUILTIN_COMMAND_COUNT);
    const all = await schema.handler(ctx(), { format: "json" });
    expect(all.result as unknown[]).toHaveLength(BUILTIN_COMMAND_COUNT);
  });

  test("置き場が空でも読み込みは成功し、登録は 0 件", async () => {
    const { plugins, failures } = await loadAllPlugins(null, { env: envWith(await tmpRoot()) });
    expect(plugins).toEqual([]);
    expect(failures).toEqual([]);
    expect(await getCommands()).toHaveLength(BUILTIN_COMMAND_COUNT);
  });
});

describe("登録したコマンドが getCommands / schema / help の 3 者に出る", () => {
  test("3 者すべてに 1 度だけ現れる", async () => {
    const { failures } = await loadOne("com.example.demo", COUNT_COMMAND);
    expect(failures).toEqual([]);

    // 1. getCommands()（= yargs 登録の元）
    const paths = (await getCommands()).map((s) => s.path);
    expect(paths).toHaveLength(BUILTIN_COMMAND_COUNT + 1);
    expect(paths.filter((p) => p === "demo count")).toHaveLength(1);
    expect(paths.slice(0, BUILTIN_COMMAND_COUNT)).toEqual(builtinCommands.map((s) => s.path));

    // 2. schema --json（AI のツール定義から漏れない）
    const all = await schema.handler(ctx(), { format: "json" });
    const schemaPaths = (all.result as Array<{ path: string }>).map((s) => s.path);
    expect(schemaPaths).toContain("demo count");
    const one = await schema.handler(ctx(), { command: "demo count", format: "json" });
    const spec = (one.result as Array<{ summary: string; options: Record<string, unknown> }>)[0];
    expect(spec?.summary).toBe("count the clips (from a plugin)");
    expect(spec?.options.unit).toBeDefined();

    // 3. help（一覧と詳細）
    const overview = await help.handler(ctx(), { command: [] });
    const overviewText = typeof overview.human === "function" ? overview.human() : (overview.human ?? "");
    expect(overviewText).toContain(`montash — ${BUILTIN_COMMAND_COUNT + 1} commands`);
    expect(overviewText).toContain("demo");
    const detail = await help.handler(ctx(), { command: ["demo", "count"] });
    const detailText = typeof detail.human === "function" ? detail.human() : (detail.human ?? "");
    expect(detailText).toContain("montash demo count — count the clips (from a plugin)");
  });

  test("plugin list に出る（registered.commands）", async () => {
    await loadOne("com.example.demo", COUNT_COMMAND);
    expect(loadedPlugins()[0]?.registered.commands).toEqual(["demo count"]);

    const { pluginList } = await import("../../../src/cli/commands/plugin.ts");
    const res = await pluginList.handler(ctx(), {});
    const listed = (res.result as { plugins: Array<{ id: string; registered: { commands: string[] } }> }).plugins;
    expect(listed[0]?.registered.commands).toEqual(["demo count"]);
    const human = typeof res.human === "function" ? res.human() : (res.human ?? "");
    expect(human).toContain("command:demo count");
  });

  test("requires は doctor の検査対象に合成される", async () => {
    await loadOne(
      "com.example.demo",
      'host.commands.define({ path: "x", summary: "s", noProject: true, requires: { filters: ["deshake"] }, run: () => ({}) });',
    );
    expect(requiredFilters(["null"])).toContain("deshake");
  });
});

describe("名前空間: プラグイン ID の末尾セグメント", () => {
  test("相対パスが名前空間の下に解決される（戻り値も絶対パス）", async () => {
    await loadOne(
      "com.example.glow",
      'globalThis.__path = host.commands.define({ path: "cache clear", summary: "s", noProject: true, run: () => ({}) });',
    );
    expect((globalThis as { __path?: string }).__path).toBe("glow cache clear");
    expect((await getCommands()).some((c) => c.path === "glow cache clear")).toBe(true);
  });

  test("組み込みと同じパスは取れない（E_PLUGIN_COMMAND_CONFLICT）", async () => {
    // 末尾が "clip" のプラグイン → 名前空間が組み込みの "clip" と衝突する
    const { plugins, failures } = await loadOne(
      "com.example.clip",
      'host.commands.define({ path: "add", summary: "hijack", noProject: true, run: () => ({}) });',
    );
    expect(plugins).toEqual([]);
    const err = failures[0]?.error as MontashError | undefined;
    expect(err?.code).toBe("E_PLUGIN_COMMAND_CONFLICT");
    expect(err?.message).toContain("com.example.clip");
    expect(err?.message).toContain("clip add");
    expect(err?.detail).toMatchObject({ plugin: "com.example.clip", path: "clip add", owner: "builtin" });
    // 組み込みは 1 つも置き換わっていない
    expect(await getCommands()).toHaveLength(BUILTIN_COMMAND_COUNT);
  });

  test("組み込みグループの下に潜り込むこともできない", async () => {
    const { failures } = await loadOne(
      "com.example.render",
      'host.commands.define({ path: "fast", summary: "s", noProject: true, run: () => ({}) });',
    );
    expect((failures[0]?.error as MontashError | undefined)?.code).toBe("E_PLUGIN_COMMAND_CONFLICT");
    expect(await getCommands()).toHaveLength(BUILTIN_COMMAND_COUNT);
  });

  test("別のプラグインが取ったパスも拒否する（先に読まれた方が勝つ）", async () => {
    const root = await tmpRoot();
    // ディレクトリ名の昇順に読むので a → b の順
    await makePlugin(
      root,
      "com.a.dup",
      'host.commands.define({ path: "run", summary: "a", noProject: true, run: () => ({}) });',
    );
    await makePlugin(
      root,
      "com.b.dup",
      'host.commands.define({ path: "run", summary: "b", noProject: true, run: () => ({}) });',
    );
    const { plugins, failures } = await loadAllPlugins(null, { env: envWith(root) });
    expect(plugins.map((p) => p.manifest.id)).toEqual(["com.a.dup"]);
    const err = failures[0]?.error as MontashError | undefined;
    expect(err?.code).toBe("E_PLUGIN_COMMAND_CONFLICT");
    expect(err?.detail).toMatchObject({ owner: "com.a.dup" });
    expect(registeredCommands().find((r) => r.spec.path === "dup run")?.plugin).toBe("com.a.dup");
  });

  test("コマンドパスとして使えない末尾は E_PLUGIN_INVALID", async () => {
    const { failures } = await loadOne(
      "com.example.3d",
      'host.commands.define({ path: "x", summary: "s", noProject: true, run: () => ({}) });',
    );
    expect((failures[0]?.error as MontashError | undefined)?.code).toBe("E_PLUGIN_INVALID");
  });

  test("空パス・不正なセグメントは E_PLUGIN_INVALID", async () => {
    const { failures } = await loadOne(
      "com.example.demo",
      'host.commands.define({ path: "Bad Path", summary: "s", noProject: true, run: () => ({}) });',
    );
    expect((failures[0]?.error as MontashError | undefined)?.code).toBe("E_PLUGIN_INVALID");
  });
});

describe("状態変更は必ず runMutation 経由", () => {
  /** 最小のプロジェクトを作る（init 相当。ここでは runMutation の入出力だけ見たい） */
  async function tmpProject(): Promise<string> {
    const dir = await tmpRoot();
    const project = createProject({ name: "t", fps: { num: 30, den: 1 }, resolution: { width: 640, height: 360 } });
    await initProjectDir(dir, project, { force: true });
    await recordInitialOp(dir, project, ctx(dir));
    return dir;
  }

  const TAG_COMMAND = `
    host.commands.define({
      path: "tag",
      summary: "add a tag",
      mutates: true,
      positionals: [{ name: "label", describe: "tag", required: true }],
      run: (c, args) => {
        c.project.meta.tags.push(String(args.label));
        return { result: { tags: c.project.meta.tags }, summary: "add tag " + args.label };
      },
    });
  `;

  test("op が記録され、project.json はホストが書く", async () => {
    const dir = await tmpProject();
    await loadOne("com.example.demo", TAG_COMMAND);
    const spec = (await getCommands()).find((c) => c.path === "demo tag");
    expect(spec?.mutates).toBe(true);

    const res = await spec?.handler(ctx(dir), { label: "keep" });
    expect(res?.op).toBe("o_0002"); // init の op に続く 2 つ目
    expect((await loadProject(dir)).meta.tags).toEqual(["keep"]);
  });

  test("--dry-run では何も書かれない（runMutation の既定の振る舞いに乗る）", async () => {
    const dir = await tmpProject();
    await loadOne("com.example.demo", TAG_COMMAND);
    const spec = (await getCommands()).find((c) => c.path === "demo tag");
    const dryCtx = createContext(globals({ dryRun: true }), { cwd: dir, env: {}, isTTY: false });
    const res = await spec?.handler(dryCtx, { label: "nope" });
    expect(res?.op).toBeNull();
    expect(res?.changes).toHaveLength(1);
    expect((await loadProject(dir)).meta.tags).toEqual([]);
  });

  test("不変条件を壊す変更は保存されない（validate はホストが行う）", async () => {
    const dir = await tmpProject();
    await loadOne(
      "com.example.demo",
      'host.commands.define({ path: "break", summary: "s", mutates: true, run: (c) => { c.project.settings.fps = { num: 0, den: 1 }; return { summary: "break" }; } });',
    );
    const spec = (await getCommands()).find((c) => c.path === "demo break");
    expect(spec?.handler(ctx(dir), {})).rejects.toThrow(MontashError);
    expect((await loadProject(dir)).settings.fps.num).toBe(30);
  });

  test("summary を返さない mutates コマンドは E_PLUGIN_INVALID（op に残せないため）", async () => {
    const dir = await tmpProject();
    await loadOne(
      "com.example.demo",
      'host.commands.define({ path: "silent", summary: "s", mutates: true, run: (c) => { c.project.meta.tags.push("x"); return {}; } });',
    );
    const spec = (await getCommands()).find((c) => c.path === "demo silent");
    expect(spec?.handler(ctx(dir), {})).rejects.toThrow(/mutates but returned no summary/);
    expect((await loadProject(dir)).meta.tags).toEqual([]);
  });

  test("mutates と noProject は併用できない", async () => {
    const { failures } = await loadOne(
      "com.example.demo",
      'host.commands.define({ path: "x", summary: "s", mutates: true, noProject: true, run: () => ({ summary: "s" }) });',
    );
    expect((failures[0]?.error as MontashError | undefined)?.code).toBe("E_PLUGIN_INVALID");
  });

  test("読み取り系に渡る project は凍結されている（書き換えても保存されない）", async () => {
    const dir = await tmpProject();
    await loadOne(
      "com.example.demo",
      'host.commands.define({ path: "peek", summary: "s", run: (c) => { let frozen = Object.isFrozen(c.project); try { c.project.meta.tags.push("x"); } catch { frozen = frozen && true; } return { result: { frozen, tags: c.project.meta.tags.length } }; } });',
    );
    const spec = (await getCommands()).find((c) => c.path === "demo peek");
    const res = await spec?.handler(ctx(dir), {});
    expect(res?.result).toEqual({ frozen: true, tags: 0 });
    expect(res?.op).toBeNull();
    expect((await loadProject(dir)).meta.tags).toEqual([]);
  });

  test("ハンドラの文脈にプロジェクトディレクトリは渡さない（直接書き込む道を作らない）", async () => {
    const dir = await tmpProject();
    await loadOne(
      "com.example.demo",
      'host.commands.define({ path: "keys", summary: "s", run: (c) => ({ result: { keys: Object.keys(c).sort() } }) });',
    );
    const spec = (await getCommands()).find((c) => c.path === "demo keys");
    const res = await spec?.handler(ctx(dir), {});
    expect((res?.result as { keys: string[] } | undefined)?.keys).toEqual(["cwd", "fps", "globals", "log", "project"]);
  });
});
