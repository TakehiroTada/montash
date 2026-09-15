/**
 * プラグインの探索・検証・読み込み（docs/14、W-19）。
 *
 * 設計上の要点を固定する:
 *   1. プラグインは montash を import しない（ホストが `register(host)` で API を渡す）
 *   2. マニフェストが正。`apiVersion` はホストの受理範囲でだけ通す
 *   3. 1 つ壊れていても他は読み続ける（プロジェクトは開けるべき）
 *   4. プロジェクト内のプラグインがユーザー共通より優先される
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MontashError } from "../../../src/cli/errors.ts";
import { clearLoadedPlugins, discoverPlugins, loadAllPlugins, pluginSearchPaths } from "../../../src/plugins/loader.ts";
import { assertCompatible, parseManifest } from "../../../src/plugins/manifest.ts";
import { videoEffects } from "../../../src/registry/effects.ts";

async function makePlugin(
  root: string,
  id: string,
  opts: { apiVersion?: number; entry?: string; main?: string; effect?: string } = {},
): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "montash-plugin.json"),
    JSON.stringify({
      id,
      apiVersion: opts.apiVersion ?? 1,
      version: "1.0.0",
      ...(opts.main ? { main: opts.main } : {}),
    }),
  );
  const effect = opts.effect ?? id.split(".").pop();
  await writeFile(
    join(dir, opts.main && !opts.main.startsWith("..") ? opts.main : "index.js"),
    opts.entry ??
      `export default { register(host) { host.effects.define({ name: ${JSON.stringify(effect)}, target: "video", summary: "t", build: () => ["null"] }); } };`,
  );
  return dir;
}

const roots: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "montash-plugins-"));
  roots.push(d);
  return d;
}
const envWith = (dir: string) => ({ MONTASH_PLUGIN_PATH: dir }) as NodeJS.ProcessEnv;

afterEach(() => {
  clearLoadedPlugins();
});

describe("マニフェスト", () => {
  test("id と apiVersion が要る", () => {
    expect(() => parseManifest({ apiVersion: 1 }, "m")).toThrow(MontashError);
    expect(() => parseManifest({ id: "com.example.a" }, "m")).toThrow(MontashError);
    expect(parseManifest({ id: "com.example.a", apiVersion: 1 }, "m").id).toBe("com.example.a");
  });

  test("id は逆ドメイン形式（ディレクトリ名として安全な文字だけ）", () => {
    expect(() => parseManifest({ id: "glow", apiVersion: 1 }, "m")).toThrow(/com\.example\.name/);
    expect(() => parseManifest({ id: "../escape", apiVersion: 1 }, "m")).toThrow(MontashError);
  });

  test("ホストが知らない API バージョンは導入を拒否する", () => {
    try {
      assertCompatible({ id: "com.example.a", apiVersion: 99 }, "m");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as MontashError).code).toBe("E_PLUGIN_INCOMPATIBLE");
      expect((e as MontashError).hint).toContain("Upgrade montash");
    }
  });
});

describe("探索", () => {
  test("プロジェクト内 → ユーザー共通 の順に見る", () => {
    const paths = pluginSearchPaths("/tmp/proj", envWith("/tmp/user"));
    expect(paths[0]).toBe(join("/tmp/proj", ".montash", "plugins"));
    expect(paths[1]).toBe("/tmp/user");
  });

  test("同じ id はプロジェクト側が勝つ", async () => {
    const user = await tmpRoot();
    const proj = await tmpRoot();
    await makePlugin(user, "com.example.dup", { effect: "from-user" });
    await mkdir(join(proj, ".montash", "plugins"), { recursive: true });
    await makePlugin(join(proj, ".montash", "plugins"), "com.example.dup", { effect: "from-project" });

    const found = await discoverPlugins(proj, envWith(user));
    expect(found).toHaveLength(1);
    expect(found[0]?.dir).toContain(".montash");
  });

  test("置き場が無くてもエラーにしない", async () => {
    expect(await discoverPlugins(null, envWith("/nonexistent-dir"))).toEqual([]);
  });
});

describe("読み込み", () => {
  test("register(host) 経由で効果が登録される（montash を import しない）", async () => {
    const root = await tmpRoot();
    await makePlugin(root, "com.example.loaded", { effect: "loaded-fx" });
    const { plugins, failures } = await loadAllPlugins(null, { env: envWith(root) });
    expect(failures).toEqual([]);
    expect(plugins[0]?.registered.effects).toEqual(["video:loaded-fx"]);
    expect(videoEffects.entry("loaded-fx")?.source).toBe("plugin");
  });

  test("1 つ壊れていても他は読み続ける", async () => {
    const root = await tmpRoot();
    await makePlugin(root, "com.example.broken", { entry: "throw new Error('boom');" });
    await makePlugin(root, "com.example.fine", { effect: "fine-fx" });

    const { plugins, failures } = await loadAllPlugins(null, { env: envWith(root) });
    expect(plugins.map((p) => p.manifest.id)).toEqual(["com.example.fine"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error.code).toBe("E_PLUGIN_LOAD_FAILED");
  });

  test("register を持たないモジュールは E_PLUGIN_INVALID", async () => {
    const root = await tmpRoot();
    await makePlugin(root, "com.example.noreg", { entry: "export default { hello: 1 };" });
    const { failures } = await loadAllPlugins(null, { env: envWith(root) });
    expect(failures[0]?.error.code).toBe("E_PLUGIN_INVALID");
  });

  test("非互換な apiVersion は読み込まず、他に影響しない", async () => {
    const root = await tmpRoot();
    await makePlugin(root, "com.example.future", { apiVersion: 99 });
    await makePlugin(root, "com.example.ok", { effect: "ok-fx" });
    const { plugins, failures } = await loadAllPlugins(null, { env: envWith(root) });
    expect(plugins.map((p) => p.manifest.id)).toEqual(["com.example.ok"]);
    expect(failures[0]?.error.code).toBe("E_PLUGIN_INCOMPATIBLE");
  });

  test("TypeScript のプラグインも読める（Bun の TS ローダー）", async () => {
    const root = await tmpRoot();
    await makePlugin(root, "com.example.ts", {
      main: "index.ts",
      entry:
        'export default { register(host: { effects: { define(s: unknown): void } }) { host.effects.define({ name: "ts-fx", target: "video", summary: "t", build: () => ["null"] }); } };',
    });
    const { plugins, failures } = await loadAllPlugins(null, { env: envWith(root) });
    expect(failures).toEqual([]);
    expect(plugins[0]?.registered.effects).toEqual(["video:ts-fx"]);
  });

  test("宣言しない限り capabilities は false", async () => {
    const root = await tmpRoot();
    await makePlugin(root, "com.example.caps", {
      entry: "export default { register(host) { globalThis.__caps = host.capabilities; } };",
    });
    await loadAllPlugins(null, { env: envWith(root) });
    expect((globalThis as { __caps?: unknown }).__caps).toEqual({ analyze: false, process: false });
  });
});
