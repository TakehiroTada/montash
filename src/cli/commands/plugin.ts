/**
 * プラグインコマンド（docs/04 §plugin、W-19）。
 *
 * **`install` は人間が実行する操作**として設計する。プラグインは任意のコードを実行できるので、
 * AI が自律的に導入してはいけない（docs/10）。`--yes` 無しでは capabilities を提示して確認する。
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadedPlugins, MANIFEST_FILE, pluginSearchPaths, userPluginDir } from "../../plugins/loader.ts";
import { parseManifest } from "../../plugins/manifest.ts";
import type { PluginManifest } from "../../plugins/types.ts";
import { defineCommand } from "../define-command.ts";
import { MontashError } from "../errors.ts";

/** 1 行だけ読む（reset.ts と同じ作り） */
async function readLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  try {
    const { value, done } = await reader.read();
    if (done || value === undefined) return "";
    const text = new TextDecoder().decode(value);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    reader.releaseLock();
  }
}

async function readManifestAt(dir: string): Promise<PluginManifest> {
  const path = join(dir, MANIFEST_FILE);
  const file = Bun.file(path);
  if (!(await file.exists()))
    throw new MontashError("E_PLUGIN_INVALID", `${path} not found`, {
      hint: "A plugin directory must contain montash-plugin.json.",
      detail: { dir },
    });
  return parseManifest(await file.json(), path);
}

// ---------------------------------------------------------------------------
// plugin list
// ---------------------------------------------------------------------------

export const pluginList = defineCommand({
  path: "plugin list",
  summary: "list the plugins that are loaded, and where they came from",
  workflows: ["W-19"],
  noProject: true,
  examples: [{ cmd: "montash plugin list --json" }],
  handler(ctx) {
    const plugins = loadedPlugins();
    const result = plugins.map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name ?? p.manifest.id,
      version: p.manifest.version ?? null,
      api_version: p.manifest.apiVersion,
      dir: p.dir,
      capabilities: p.manifest.capabilities ?? [],
      registered: p.registered,
    }));
    return {
      result: { plugins: result, search_paths: pluginSearchPaths(ctx.findProjectDir()) },
      op: null,
      commit: null,
      head: null,
      human: () =>
        result.length === 0
          ? `no plugins loaded\nsearched: ${pluginSearchPaths(ctx.findProjectDir()).join(", ")}`
          : result
              .map(
                (p) =>
                  `${p.id.padEnd(28)} v${p.version ?? "?"}  api${p.api_version}  ${[
                    ...p.registered.effects.map((e) => `effect:${e}`),
                    ...p.registered.generators.map((g) => `generator:${g}`),
                    ...p.registered.transitions.map((t) => `transition:${t}`),
                    ...p.registered.commands.map((c) => `command:${c}`),
                  ].join(" ")}`,
              )
              .join("\n"),
    };
  },
});

// ---------------------------------------------------------------------------
// plugin install / remove
// ---------------------------------------------------------------------------

interface InstallArgs extends Record<string, unknown> {
  path: string;
  force?: boolean;
}

export const pluginInstall = defineCommand<InstallArgs>({
  path: "plugin install",
  summary: "install a plugin directory for the current user (run this yourself, not via AI)",
  workflows: ["W-19"],
  noProject: true,
  positionals: [{ name: "path", describe: "plugin directory containing montash-plugin.json", required: true }],
  options: { force: { type: "boolean", describe: "overwrite an already installed plugin with the same id" } },
  examples: [{ cmd: "montash plugin install ./montash-glow" }],
  async handler(ctx, args) {
    const from = isAbsolute(String(args.path)) ? String(args.path) : resolve(ctx.cwd, String(args.path));
    const manifest = await readManifestAt(from);
    const target = join(userPluginDir(ctx.env), manifest.id);

    if (await Bun.file(join(target, MANIFEST_FILE)).exists()) {
      if (!args.force)
        throw new MontashError("E_PLUGIN_EXISTS", `plugin "${manifest.id}" is already installed`, {
          hint: `Use --force to replace it (installed at ${target}).`,
          detail: { plugin: manifest.id, dir: target },
        });
      await rm(target, { recursive: true, force: true });
    }

    // 任意コードを実行できるものを入れるので、能力を見せて確認する
    const caps = manifest.capabilities ?? [];
    const summary = `install ${manifest.id}${manifest.version ? ` v${manifest.version}` : ""}${
      caps.length > 0 ? ` (capabilities: ${caps.join(", ")})` : ""
    }`;
    // `--yes` が無ければ確認する。プラグインは montash の中で任意コードを実行するため、
    // 非対話（AI・スクリプト）では素通しせず E_CONFIRM_REQUIRED で止める（docs/10）。
    if (!ctx.globals.yes) {
      const interactive = Boolean(process.stdin.isTTY) && !ctx.globals.json;
      if (!interactive)
        throw new MontashError("E_CONFIRM_REQUIRED", `${summary} requires confirmation`, {
          hint: "A plugin runs arbitrary code inside montash. Re-run this yourself with --yes after reviewing the source.",
          detail: { plugin: manifest.id, from, capabilities: caps },
        });
      ctx.stderr(`${summary}\nPlugins run arbitrary code inside montash. Install from ${from}? [y/N] `);
      const line = await readLine();
      if (!/^y(es)?$/i.test(line.trim()))
        throw new MontashError("E_CONFIRM_REQUIRED", "aborted by the user", {
          detail: { plugin: manifest.id, from },
        });
    }

    await mkdir(userPluginDir(ctx.env), { recursive: true });
    await cp(from, target, { recursive: true });
    return {
      result: { installed: true, plugin: manifest.id, dir: target, capabilities: caps },
      op: null,
      commit: null,
      head: null,
      human: `installed ${manifest.id} -> ${target}\nrun \`montash plugin list\` to confirm, \`montash doctor\` to check its ffmpeg requirements`,
    };
  },
});

interface RemoveArgs extends Record<string, unknown> {
  id: string;
}

export const pluginRemove = defineCommand<RemoveArgs>({
  path: "plugin remove",
  summary: "remove an installed plugin",
  workflows: ["W-19"],
  noProject: true,
  positionals: [{ name: "id", describe: "plugin id (see `montash plugin list`)", required: true }],
  examples: [{ cmd: "montash plugin remove com.example.glow" }],
  async handler(ctx, args) {
    const dir = join(userPluginDir(ctx.env), String(args.id));
    if (!(await Bun.file(join(dir, MANIFEST_FILE)).exists()))
      throw new MontashError("E_PLUGIN_NOT_FOUND", `plugin "${String(args.id)}" is not installed`, {
        hint: "Run `montash plugin list` to see installed plugins.",
        detail: { plugin: String(args.id), dir },
      });
    await rm(dir, { recursive: true, force: true });
    return {
      result: { removed: true, plugin: String(args.id), dir },
      op: null,
      commit: null,
      head: null,
      human: `removed ${String(args.id)}`,
    };
  },
});

// ---------------------------------------------------------------------------
// plugin doctor
// ---------------------------------------------------------------------------

export const pluginDoctor = defineCommand({
  path: "plugin doctor",
  summary: "report which plugins a project needs and whether they are available",
  workflows: ["W-19"],
  examples: [{ cmd: "montash plugin doctor --json" }],
  async handler(ctx) {
    const { loadProject } = await import("../../core/project.ts");
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const loaded = new Set(loadedPlugins().map((p) => p.manifest.id));

    const required = ((project as { plugins?: { requires?: Array<{ id: string; version?: string }> } }).plugins
      ?.requires ?? []) as Array<{ id: string; version?: string }>;
    const missing = required.filter((r) => !loaded.has(r.id));

    // project.json のどこで未知の種別・効果が使われているかを拾う
    const { videoEffects, audioEffects } = await import("../../registry/effects.ts");
    const unknownEffects = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        for (const e of (clip as { effects?: Array<{ type: string }> }).effects ?? []) {
          const known = track.kind === "audio" ? audioEffects.has(e.type) : videoEffects.has(e.type);
          if (!known) unknownEffects.add(e.type);
        }
      }
    }

    const ok = missing.length === 0 && unknownEffects.size === 0;
    return {
      result: {
        ok,
        loaded: [...loaded],
        required,
        missing_plugins: missing,
        unknown_effects: [...unknownEffects],
      },
      exitCode: ok ? undefined : 1,
      op: null,
      commit: null,
      head: null,
      human: () =>
        ok
          ? "all plugins this project needs are available"
          : [
              ...missing.map((m) => `missing plugin  ${m.id}${m.version ? ` (>= ${m.version})` : ""}`),
              ...[...unknownEffects].map((e) => `unknown effect  ${e}  (no registered plugin provides it)`),
              "",
              "Ask the person running montash to install the plugin; montash does not download plugins by itself.",
            ].join("\n"),
    };
  },
});
