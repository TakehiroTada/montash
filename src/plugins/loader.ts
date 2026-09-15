/**
 * プラグインの探索と読み込み（docs/14、W-19）。
 *
 * 探索順（先に見つかった方が勝ち。同じ ID は 1 度だけ読む）:
 *   1. `<project>/.montash/plugins/`  — そのプロジェクト専用
 *   2. `~/.local/share/montash/plugins/` — ユーザー共通（`MONTASH_PLUGIN_PATH` で上書き可）
 *
 * 各プラグインは 1 ディレクトリ = 1 プラグインで、直下に `montash-plugin.json` を置く。
 * AviUtl2 が「Plugin フォルダとその 1 階層下」を見るのと同じ深さに合わせてある。
 *
 * **プラグインは montash を import しない。** ホストが `register(host)` で API を渡す（P2-3 の実測に基づく設計）。
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { MontashError } from "../cli/errors.ts";
import { registerEffect } from "../registry/effects.ts";
import { registerGenerator } from "../registry/generators.ts";
import { registerRequirements } from "../registry/requirements.ts";
import { registerTransition } from "../registry/transitions.ts";
import { assertCompatible, parseManifest } from "./manifest.ts";
import {
  type LoadedPlugin,
  PLUGIN_API_VERSION,
  type PluginCapability,
  type PluginHost,
  type PluginManifest,
  type PluginModule,
} from "./types.ts";

export const MANIFEST_FILE = "montash-plugin.json";
const DEFAULT_ENTRY = "index.js";
const ENTRY_CANDIDATES = ["index.js", "index.ts", "index.mjs"];

/** ユーザー共通のプラグイン置き場（ffmpeg と同じ `~/.local/share/montash` の下） */
export function userPluginDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MONTASH_PLUGIN_PATH;
  if (override && override.length > 0) return override;
  return join(homedir(), ".local", "share", "montash", "plugins");
}

/** 探索するディレクトリを優先順に返す */
export function pluginSearchPaths(projectDir: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (projectDir) out.push(join(projectDir, ".montash", "plugins"));
  out.push(userPluginDir(env));
  return out;
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new MontashError("E_PLUGIN_INVALID", `${path} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
}

/** ディレクトリ 1 つ分のマニフェストを読む（無ければ null） */
async function readManifestIn(dir: string): Promise<{ manifest: PluginManifest; dir: string } | null> {
  const path = join(dir, MANIFEST_FILE);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return { manifest: parseManifest(await readJson(path), path), dir };
}

/** 探索パス配下のプラグインディレクトリを列挙する（読み込みはしない） */
export async function discoverPlugins(
  projectDir: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ manifest: PluginManifest; dir: string }>> {
  const found: Array<{ manifest: PluginManifest; dir: string }> = [];
  const seen = new Set<string>();
  for (const root of pluginSearchPaths(projectDir, env)) {
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // 置き場が無いのは普通のこと
    }
    for (const name of entries.sort()) {
      const found1 = await readManifestIn(join(root, name));
      if (!found1) continue;
      if (seen.has(found1.manifest.id)) continue; // 先に見つかった方（プロジェクト側）が勝つ
      seen.add(found1.manifest.id);
      found.push(found1);
    }
  }
  return found;
}

/** エントリのパスを決める（`main` 指定 → 既定の候補の順） */
async function resolveEntry(dir: string, manifest: PluginManifest): Promise<string> {
  const candidates = manifest.main ? [manifest.main] : ENTRY_CANDIDATES;
  for (const rel of candidates) {
    if (isAbsolute(rel)) throw new MontashError("E_PLUGIN_INVALID", `${manifest.id}: "main" must be a relative path`);
    const path = resolve(dir, rel);
    // ディレクトリの外を指していないか（`../` でリポジトリ外を読ませない）
    if (!path.startsWith(resolve(dir))) {
      throw new MontashError("E_PLUGIN_INVALID", `${manifest.id}: "main" must stay inside the plugin directory`, {
        detail: { plugin: manifest.id, main: rel },
      });
    }
    if (await Bun.file(path).exists()) return path;
  }
  throw new MontashError("E_PLUGIN_INVALID", `${manifest.id}: entry point not found`, {
    hint: `Expected ${manifest.main ?? ENTRY_CANDIDATES.join(" or ")} in ${dir}.`,
    detail: { plugin: manifest.id, dir },
  });
}

/** `register(host)` に渡す API テーブルを作る */
function createHost(
  manifest: PluginManifest,
  onLog: (message: string) => void,
  registered: LoadedPlugin["registered"],
): PluginHost {
  const declared = new Set<PluginCapability>(manifest.capabilities ?? []);
  const capabilities = {
    analyze: declared.has("analyze"),
    process: declared.has("process"),
  } as const;

  return {
    apiVersion: PLUGIN_API_VERSION,
    manifest,
    capabilities,
    effects: {
      define(spec) {
        registerEffect(spec, "plugin");
        registered.effects.push(`${spec.target}:${spec.name}`);
      },
    },
    generators: {
      define(spec) {
        registerGenerator(spec, "plugin");
        registered.generators.push(spec.name);
      },
    },
    transitions: {
      define(spec) {
        registerTransition(spec, "plugin");
        registered.transitions.push(spec.name);
      },
    },
    requireFeatures(requires) {
      registerRequirements(`plugin:${manifest.id}:extra`, requires);
    },
    log(message) {
      onLog(`[${manifest.id}] ${message}`);
    },
  };
}

export interface LoadOptions {
  /** 診断ログ（`--verbose` 相当） */
  onLog?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** 1 つのプラグインを読み込んで登録する */
export async function loadPlugin(dir: string, manifest: PluginManifest, opts: LoadOptions = {}): Promise<LoadedPlugin> {
  assertCompatible(manifest, join(dir, MANIFEST_FILE));
  const entry = await resolveEntry(dir, manifest);
  const log = opts.onLog ?? (() => {});

  let mod: { default?: PluginModule };
  try {
    mod = (await import(entry)) as { default?: PluginModule };
  } catch (e) {
    throw new MontashError("E_PLUGIN_LOAD_FAILED", `plugin "${manifest.id}" could not be loaded: ${String(e)}`, {
      hint: "The plugin module threw while being imported. Check its entry point.",
      detail: { plugin: manifest.id, entry },
      cause: e,
    });
  }

  const plugin = mod.default;
  if (!plugin || typeof plugin.register !== "function") {
    throw new MontashError("E_PLUGIN_INVALID", `plugin "${manifest.id}" must default-export { register(host) }`, {
      hint: "export default { register(host) { host.effects.define(...) } }",
      detail: { plugin: manifest.id, entry },
    });
  }

  const registered: LoadedPlugin["registered"] = { effects: [], generators: [], transitions: [] };
  const host = createHost(manifest, log, registered);
  try {
    await plugin.register(host);
  } catch (e) {
    if (e instanceof MontashError) throw e;
    throw new MontashError("E_PLUGIN_LOAD_FAILED", `plugin "${manifest.id}" failed while registering: ${String(e)}`, {
      detail: { plugin: manifest.id, entry },
      cause: e,
    });
  }

  if (manifest.requires) registerRequirements(`plugin:${manifest.id}`, manifest.requires);
  log(`loaded ${manifest.id} (${registered.effects.length} effect(s))`);
  return { manifest, dir, entry, registered };
}

/** 読み込み済みプラグイン（プロセス内で 1 度だけ読む） */
const loaded = new Map<string, LoadedPlugin>();

export function loadedPlugins(): readonly LoadedPlugin[] {
  return [...loaded.values()];
}

/** テスト用。読み込み済みの記録を捨てる（レジストリ側の登録は消さない） */
export function clearLoadedPlugins(): void {
  loaded.clear();
}

/**
 * 探索して全部読み込む。
 * **1 つのプラグインの失敗で montash 全体を止めない** — 失敗は警告として返し、他は読み続ける
 * （プラグインが壊れていてもプロジェクトは開けるべき。F-EXT-4 と同じ考え方）。
 */
export async function loadAllPlugins(
  projectDir: string | null,
  opts: LoadOptions = {},
): Promise<{ plugins: LoadedPlugin[]; failures: Array<{ id: string; dir: string; error: MontashError }> }> {
  const plugins: LoadedPlugin[] = [];
  const failures: Array<{ id: string; dir: string; error: MontashError }> = [];
  for (const { manifest, dir } of await discoverPlugins(projectDir, opts.env)) {
    if (loaded.has(manifest.id)) {
      plugins.push(loaded.get(manifest.id)!);
      continue;
    }
    try {
      const plugin = await loadPlugin(dir, manifest, opts);
      loaded.set(manifest.id, plugin);
      plugins.push(plugin);
    } catch (e) {
      const err =
        e instanceof MontashError
          ? e
          : new MontashError("E_PLUGIN_LOAD_FAILED", `plugin "${manifest.id}" failed: ${String(e)}`, { cause: e });
      failures.push({ id: manifest.id, dir, error: err });
    }
  }
  return { plugins, failures };
}
