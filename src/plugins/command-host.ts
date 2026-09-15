/**
 * プラグインが足す CLI コマンド（docs/14 §3.3、計画 P3-4）。
 * AviUtl2 の「汎用プラグイン（.aux2）」— 効果でもジェネレータでもない、道具そのものを足す口に相当する。
 *
 * 2 つの規則で、組み込みとの事故を構造的に防ぐ:
 *
 *   1. **名前空間の強制**（`pluginNamespace`）
 *      プラグイン ID の末尾セグメントが、そのプラグインのコマンド名前空間になる。
 *      `com.example.glow` なら `montash glow ...` の下だけ。`define({ path: "render" })` の
 *      `path` は**名前空間からの相対**で、`glow render` に解決される。
 *      これで「プラグインが `montash render` を名乗る」ことが原理的に起きない。
 *
 *   2. **組み込みの上書き禁止**（`assertPathAvailable`）
 *      名前空間そのものが組み込みの第 1 セグメント（`clip` / `render` ...）と同じなら、
 *      その時点で `E_PLUGIN_COMMAND_CONFLICT`。組み込みの木に潜り込ませない。
 *      別のプラグインが既に取ったパスも同じエラーで弾く。先に読まれた方が勝つ（探索順と同じ）。
 *
 * 状態変更（`mutates: true`）は**必ず `runMutation()` を通す**（docs/14 原則 4）。
 * プラグインのハンドラに渡すのは `runMutation` が用意した作業コピーだけで、プロジェクトの
 * ディレクトリも保存関数も渡さない。検証・保存（tmp→rename）・op 記録はホストが行う。
 */
import type { CommandContext } from "../cli/context.ts";
import type { CommandExample, CommandResult, OptionSpec, PositionalSpec } from "../cli/define-command.ts";
import { MontashError, type Warning } from "../cli/errors.ts";
import { runMutation } from "../cli/mutate.ts";
import { loadProject } from "../core/project.ts";
import type { Fps, Project } from "../core/schema.ts";
import type { AnyCommandSpec } from "../registry/commands.ts";
import { registeredCommands } from "../registry/commands.ts";
import type { FeatureRequirements } from "../registry/requirements.ts";
import type { PluginManifest } from "./types.ts";

/** コマンドパスの 1 セグメント（`defineCommand` が受け付ける形と同じ） */
const SEGMENT = /^[a-z][a-z0-9-]*$/;

/**
 * プラグインのハンドラに渡す文脈。
 *
 * **`CommandContext` そのものは渡さない。** `requireProjectDir()` を渡すとプロジェクトの
 * ディレクトリが手に入り、`project.json` を直に書ける道ができてしまう（docs/14 §8「やらないこと」）。
 * 渡すのは「値」だけ — プロジェクトの複製（または作業コピー）と、出力の体裁に必要なグローバル設定。
 */
export interface PluginCommandContext {
  /**
   * `mutates: true` なら**作業コピー**（書き換えてよい。ホストが検証して保存し op に残す）。
   * それ以外は読み取り専用の複製（凍結済み。書き換えても保存されない）。プロジェクトが無ければ null。
   */
  readonly project: Project | null;
  /** `project.settings.fps`（プロジェクトが無ければ null） */
  readonly fps: Fps | null;
  /** コマンドを実行したディレクトリ。ユーザーが渡した相対パスの解決に使う */
  readonly cwd: string;
  /** 出力の体裁に関わるグローバル設定だけを渡す */
  readonly globals: Readonly<{
    json: boolean;
    quiet: boolean;
    verbose: boolean;
    dryRun: boolean;
    timeFormat: "frames" | "seconds" | "tc";
  }>;
  /** 診断ログ（`--verbose` のときだけ出る） */
  log(message: string): void;
}

/** プラグインのハンドラの戻り値 */
export interface PluginCommandResult {
  /** コマンド固有の結果（`--json` の `result`） */
  result?: unknown;
  /** 人間向け表示。省略時は result を整形して出す */
  human?: string;
  /** `mutates: true` のとき必須。op の 1 行要約として履歴に残る */
  summary?: string;
  /** `mutates: true` のときだけ意味がある。false なら「変更なし」として op を記録しない */
  changed?: boolean;
  warnings?: Warning[];
}

/** `host.commands.define(spec)` が受け取る形。`defineCommand` の spec から handler だけ差し替えたもの */
export interface PluginCommandSpec {
  /** **名前空間からの相対パス**（`"render"` / `"cache clear"`）。先頭にプラグイン名は付けない */
  path: string;
  summary: string;
  description?: string;
  workflows?: string[];
  positionals?: PositionalSpec[];
  options?: Record<string, OptionSpec>;
  examples?: CommandExample[];
  /** 状態を変更する（`runMutation` を通し、op として履歴に残る）。`noProject` とは併用できない */
  mutates?: boolean;
  /** プロジェクトを必要としない */
  noProject?: boolean;
  /** このコマンドが必要とする ffmpeg 機能（`doctor` の検査対象に合成される） */
  requires?: FeatureRequirements;
  run(ctx: PluginCommandContext, args: Record<string, unknown>): Promise<PluginCommandResult> | PluginCommandResult;
}

/**
 * プラグイン ID → コマンド名前空間。末尾セグメントをそのまま使う（`com.example.glow` → `glow`）。
 * コマンドパスとして使えない末尾（数字始まりなど）は、コマンドを定義しようとした時点で弾く。
 */
export function pluginNamespace(id: string): string {
  return id.split(".").at(-1) ?? id;
}

/** 相対パスを名前空間付きの絶対パスに解決する */
export function resolveCommandPath(manifest: PluginManifest, relative: string): string {
  const ns = pluginNamespace(manifest.id);
  if (!SEGMENT.test(ns)) {
    throw new MontashError(
      "E_PLUGIN_INVALID",
      `plugin "${manifest.id}" cannot define commands: "${ns}" is not usable as a command name`,
      {
        hint: "The last segment of the plugin id becomes its command namespace, so it must start with a letter and contain only [a-z0-9-].",
        detail: { plugin: manifest.id, namespace: ns },
      },
    );
  }
  const rel = relative.trim();
  const segments = rel.length === 0 ? [] : rel.split(/\s+/);
  if (segments.length === 0 || !segments.every((s) => SEGMENT.test(s))) {
    throw new MontashError("E_PLUGIN_INVALID", `plugin "${manifest.id}": invalid command path "${relative}"`, {
      hint: 'A command path is one or more space-separated segments like "render" or "cache clear", relative to the plugin namespace.',
      detail: { plugin: manifest.id, path: relative, namespace: ns },
    });
  }
  return [ns, ...segments].join(" ");
}

/**
 * そのパスを取ってよいか。**組み込みの上書きは常に禁止**する（`E_PLUGIN_COMMAND_CONFLICT`）。
 * 名前空間が組み込みの第 1 セグメントと同じ場合も、組み込みの木に混ざるので同じエラーで弾く。
 */
export function assertPathAvailable(manifest: PluginManifest, path: string, builtinPaths: ReadonlySet<string>): void {
  const ns = path.split(" ")[0] ?? path;
  const builtinRoots = new Set([...builtinPaths].map((p) => p.split(" ")[0]));

  const conflict = (message: string, hint: string, detail: Record<string, unknown>): never => {
    throw new MontashError("E_PLUGIN_COMMAND_CONFLICT", message, {
      hint,
      detail: { plugin: manifest.id, path, namespace: ns, ...detail },
    });
  };

  if (builtinPaths.has(path)) {
    conflict(
      `plugin "${manifest.id}" tried to define the built-in command "${path}"`,
      "Built-in commands can never be replaced by a plugin. Rename the plugin command, or rename the plugin id (its last segment is the namespace).",
      { owner: "builtin" },
    );
  }
  if (builtinRoots.has(ns)) {
    conflict(
      `plugin "${manifest.id}" would define "${path}" inside the built-in "${ns}" command group`,
      `The plugin namespace comes from the last segment of its id, and "${ns}" is a built-in command. Rename the plugin id (e.g. com.example.${ns}-tools).`,
      { owner: "builtin" },
    );
  }
  const taken = registeredCommands().find((r) => r.spec.path === path);
  if (taken) {
    conflict(
      `command "${path}" is already provided by ${taken.plugin ? `plugin "${taken.plugin}"` : taken.source}`,
      "Two plugins cannot provide the same command path. The one loaded first wins; remove or rename one of them.",
      { owner: taken.plugin ?? taken.source },
    );
  }
}

/** 読み取り系に渡すプロジェクトは凍結する（書き換えても保存されないことを、その場で分からせる） */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  return Object.freeze(value);
}

function globalsOf(ctx: CommandContext): PluginCommandContext["globals"] {
  return Object.freeze({
    json: ctx.globals.json,
    quiet: ctx.globals.quiet,
    verbose: ctx.globals.verbose,
    dryRun: ctx.globals.dryRun,
    timeFormat: ctx.globals.timeFormat,
  });
}

/**
 * プラグインのコマンド定義を、組み込みとまったく同じ `CommandSpec` に変換する。
 * これで `getCommands()`（= yargs 登録 / `schema` / `help`）の 3 者すべてに同じように載る。
 */
export function toCommandSpec(
  manifest: PluginManifest,
  spec: PluginCommandSpec,
  path: string,
  log: (message: string) => void,
): AnyCommandSpec {
  if (spec.mutates && spec.noProject) {
    throw new MontashError(
      "E_PLUGIN_INVALID",
      `plugin "${manifest.id}": command "${path}" cannot be both mutates and noProject`,
      {
        hint: "A state-changing command needs a project: its changes are recorded as an op.",
        detail: { plugin: manifest.id, path },
      },
    );
  }

  const handler = async (ctx: CommandContext, args: Record<string, unknown>): Promise<CommandResult> => {
    // 状態変更は必ず runMutation 経由（docs/14 原則 4）。
    // プラグインは作業コピーを書き換えるだけで、検証・保存・op 記録はホストが行う。
    if (spec.mutates) {
      return runMutation(ctx, async (tools) => {
        const out = await spec.run(
          {
            project: tools.project,
            fps: tools.fps,
            cwd: ctx.cwd,
            globals: globalsOf(ctx),
            log,
          },
          args,
        );
        if (typeof out.summary !== "string" || out.summary.length === 0) {
          throw new MontashError(
            "E_PLUGIN_INVALID",
            `plugin "${manifest.id}": command "${path}" declares mutates but returned no summary`,
            {
              hint: "A state-changing command must return { summary } — it becomes the one-line description of the recorded op.",
              detail: { plugin: manifest.id, path },
            },
          );
        }
        return {
          ...(out.result !== undefined ? { result: out.result } : {}),
          summary: out.summary,
          ...(out.human !== undefined ? { human: out.human } : {}),
          ...(out.changed !== undefined ? { changed: out.changed } : {}),
          ...(out.warnings !== undefined ? { warnings: out.warnings } : {}),
        };
      });
    }

    const dir = spec.noProject ? ctx.findProjectDir() : ctx.requireProjectDir();
    const project = dir ? deepFreeze(await loadProject(dir)) : null;
    const out = await spec.run(
      {
        project,
        fps: project?.settings.fps ?? null,
        cwd: ctx.cwd,
        globals: globalsOf(ctx),
        log,
      },
      args,
    );
    return {
      ...(out.result !== undefined ? { result: out.result } : {}),
      ...(out.human !== undefined ? { human: out.human } : {}),
      ...(out.warnings !== undefined ? { warnings: out.warnings } : {}),
      op: null,
      commit: null,
      head: null,
    };
  };

  return {
    path,
    summary: spec.summary,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    workflows: spec.workflows ?? [],
    ...(spec.positionals !== undefined ? { positionals: spec.positionals } : {}),
    ...(spec.options !== undefined ? { options: spec.options } : {}),
    ...(spec.examples !== undefined ? { examples: spec.examples } : {}),
    ...(spec.mutates !== undefined ? { mutates: spec.mutates } : {}),
    ...(spec.noProject !== undefined ? { noProject: spec.noProject } : {}),
    handler,
  };
}
