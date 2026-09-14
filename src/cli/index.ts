/**
 * montash CLI エントリ。
 *
 * yargs にグローバルオプションとコマンド（src/cli/commands/registry.ts）を登録し、
 * 各コマンドの実行を runLeaf() で包んで出力整形・エラー処理・終了コードを一元化する。
 * docs/04 §1（共通仕様）, docs/08 §3.1
 */
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { commands } from "./commands/registry.ts";
import { createContext, type GlobalOptions } from "./context.ts";
import { type CommandSpec, registerCommands } from "./define-command.ts";
import { ExitCode, MontashError, toMontashError } from "./errors.ts";
import { printFailure, printSuccess } from "./output.ts";

export const VERSION = "0.0.1";

const GLOBAL_KEYS = new Set([
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

function readGlobals(argv: Record<string, unknown>, env: NodeJS.ProcessEnv): GlobalOptions {
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

/** コマンド固有の引数だけを残す（camelCase 側を採用） */
function commandArgs(argv: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(argv)) {
    if (GLOBAL_KEYS.has(k)) continue;
    if (k.includes("-")) continue; // kebab は camel 側に同じ値が入っている
    out[k] = v;
  }
  return out;
}

export async function runLeaf(
  spec: CommandSpec<Record<string, unknown>>,
  argv: Record<string, unknown>,
): Promise<void> {
  const globals = readGlobals(argv, process.env);
  const ctx = createContext(globals, { argv: hideBin(process.argv) });
  try {
    if (!spec.noProject) ctx.requireProjectDir();
    const res = await spec.handler(ctx, commandArgs(argv));
    printSuccess(ctx, spec, res);
    process.exitCode = ExitCode.OK;
  } catch (e) {
    const err = toMontashError(e);
    printFailure(ctx, spec.path, err);
    process.exitCode = err.exitCode;
  }
}

export function buildCli(argv: string[]) {
  const y = yargs(argv)
    .scriptName("montash")
    .locale("en") // メッセージを OS ロケールに依存させない（AI が読む）
    .usage("$0 <command> [options]\n\nmontash — CLI video editor operated by AI (montage + sh)")
    .version(VERSION)
    .help("help")
    .alias("help", "h")
    .strict()
    .parserConfiguration({
      "camel-case-expansion": true,
      "strip-dashed": false,
      "populate--": true,
    })
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
    .option("color", {
      type: "boolean",
      default: true,
      describe: "colorize output (--no-color to disable)",
      global: true,
    })
    .option("time-format", {
      type: "string",
      choices: ["frames", "seconds", "tc"],
      default: "seconds",
      describe: "human-readable time format",
      global: true,
    })
    .demandCommand(1, "specify a command (try `montash --help`)")
    .recommendCommands()
    .fail((msg, err, yy) => {
      // 使用法エラーは JSON でも返す（AI が読めるように）
      const wantJson = argv.includes("--json") || process.env.MONTASH_JSON === "1";
      const e =
        err instanceof MontashError
          ? err
          : new MontashError("E_USAGE", msg ?? err?.message ?? "usage error", {
              exitCode: ExitCode.USAGE,
              hint: "Run `montash <command> --help` or `montash schema --json`.",
            });
      if (wantJson) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            command: argv
              .filter((a) => !a.startsWith("-"))
              .slice(0, 2)
              .join(" "),
            error: e.toJSON(),
          })}\n`,
        );
      } else {
        process.stderr.write(`error [${e.code}]: ${e.message}\n`);
        if (e.hint) process.stderr.write(`  hint: ${e.hint}\n`);
        if (!err) process.stderr.write(`\n${yy.help()}\n`);
      }
      process.exit(e.exitCode);
    })
    .wrap(Math.min(110, process.stdout.columns ?? 100));

  registerCommands(y, commands, runLeaf);
  return y;
}

if (import.meta.main) {
  await buildCli(hideBin(process.argv)).parseAsync();
}
