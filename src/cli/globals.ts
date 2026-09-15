/**
 * グローバルオプション（docs/04 §1.2）の宣言と読み取り。
 *
 * `cli/index.ts`（本物の CLI）と `cli/commands/batch.ts`（JSON Lines の 1 行を同一プロセスで
 * 実行するための yargs インスタンス）の 2 か所が同じ宣言を必要とするため、ここに切り出している。
 * 片方にだけオプションを足すと `montash batch` の中と外で解釈が変わるので、必ずここに書く。
 */
import type { Argv } from "yargs";
import type { GlobalOptions } from "./context.ts";
import type { CommandSpec } from "./define-command.ts";

/** グローバルが握っているキー（コマンド固有の引数と切り分けるために使う） */
export const GLOBAL_KEYS = new Set([
  "project",
  "C",
  "json",
  "quiet",
  "q",
  "verbose",
  "v",
  "dry-run",
  "dryRun",
  "yes",
  "y",
  "ffmpeg-path",
  "ffmpegPath",
  "ffprobe-path",
  "ffprobePath",
  "message",
  "m",
  "body",
  "no-color",
  "noColor",
  "color",
  "time-format",
  "timeFormat",
  "_",
  "$0",
]);

export function readGlobals(argv: Record<string, unknown>, env: NodeJS.ProcessEnv): GlobalOptions {
  const tf = argv.timeFormat;
  return {
    project: typeof argv.project === "string" ? argv.project : undefined,
    json: Boolean(argv.json) || env.MONTASH_JSON === "1",
    quiet: Boolean(argv.quiet),
    verbose: Boolean(argv.verbose),
    dryRun: Boolean(argv.dryRun),
    yes: Boolean(argv.yes),
    ffmpegPath: typeof argv.ffmpegPath === "string" ? argv.ffmpegPath : env.MONTASH_FFMPEG,
    ffprobePath: typeof argv.ffprobePath === "string" ? argv.ffprobePath : env.MONTASH_FFPROBE,
    message: typeof argv.message === "string" ? argv.message : undefined,
    body: typeof argv.body === "string" ? argv.body : undefined,
    noColor: argv.color === false || Boolean(argv.noColor),
    timeFormat: tf === "frames" || tf === "seconds" || tf === "tc" ? tf : "seconds",
  };
}

/**
 * コマンド固有の引数だけを残す（camelCase 側を採用）。
 * コマンドが自分で宣言している名前（`assets set --color` など、グローバルと綴りが同じもの）は
 * グローバル扱いせずハンドラに渡す。
 */
export function commandArgs(
  argv: Record<string, unknown>,
  spec: CommandSpec<Record<string, unknown>>,
): Record<string, unknown> {
  const own = new Set<string>();
  for (const key of Object.keys(spec.options ?? {})) {
    own.add(key);
    own.add(key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(argv)) {
    if (own.has(k)) {
      out[k] = v;
      continue;
    }
    if (GLOBAL_KEYS.has(k)) continue;
    if (k.includes("-")) continue; // kebab は camel 側に同じ値が入っている
    out[k] = v;
  }
  return out;
}

/** yargs のパーサ設定（index.ts と batch の行パーサで同じにする） */
export const PARSER_CONFIGURATION = {
  "camel-case-expansion": true,
  "strip-dashed": false,
  "populate--": true,
} as const;

/** グローバルオプションを yargs に宣言する（docs/04 §1.2） */
export function applyGlobalOptions(y: Argv): Argv {
  return (
    y
      .option("project", {
        alias: "C",
        type: "string",
        describe: "project directory (default: search upward for project.json)",
        global: true,
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "machine-readable JSON output (also MONTASH_JSON=1)",
        global: true,
      })
      .option("quiet", {
        alias: "q",
        type: "boolean",
        default: false,
        describe: "suppress human-readable output",
        global: true,
      })
      .option("verbose", {
        alias: "v",
        type: "boolean",
        default: false,
        describe: "print executed ffmpeg commands and details",
        global: true,
      })
      .option("dry-run", {
        type: "boolean",
        default: false,
        describe: "show what would change without writing",
        global: true,
      })
      .option("yes", {
        alias: "y",
        type: "boolean",
        default: false,
        describe: "answer yes to confirmations",
        global: true,
      })
      .option("ffmpeg-path", {
        type: "string",
        describe: "path to ffmpeg binary (also MONTASH_FFMPEG)",
        global: true,
      })
      .option("ffprobe-path", {
        type: "string",
        describe: "path to ffprobe binary (also MONTASH_FFPROBE)",
        global: true,
      })
      .option("message", {
        alias: "m",
        type: "string",
        describe: "commit this operation immediately with the given message",
        global: true,
      })
      .option("body", {
        type: "string",
        describe: "commit body (with -m)",
        global: true,
      })
      // グローバルは `--no-color`（docs/04 §1.2）。`color` を boolean で宣言すると
      // `assets set --color <hex>` / `text add --color` などコマンド側の値オプションを食ってしまうため、
      // boolean-negation が作る `color` キーは string として宣言だけしておく（strict() 対策）。
      .option("no-color", {
        type: "boolean",
        default: false,
        describe: "disable colorized output",
        global: true,
      })
      .option("color", {
        type: "string",
        describe: "(reserved) per-command color value; --no-color disables colorized output",
        hidden: true,
        global: true,
      })
      .option("time-format", {
        type: "string",
        choices: ["frames", "seconds", "tc"],
        default: "seconds",
        describe: "human-readable time format",
        global: true,
      })
  );
}
