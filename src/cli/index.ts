/**
 * montash CLI エントリ。
 *
 * yargs にグローバルオプションとコマンド（registry/commands.ts の getCommands()）を登録し、
 * 各コマンドの実行を runLeaf() で包んで出力整形・エラー処理・終了コードを一元化する。
 * docs/04 §1（共通仕様）, docs/08 §3.1
 */
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadAllPlugins } from "../plugins/loader.ts";
import { getCommands } from "../registry/commands.ts";
import { createContext, findProjectDirFrom } from "./context.ts";
import { type CommandSpec, registerCommands } from "./define-command.ts";
import { ExitCode, MontashError, toMontashError } from "./errors.ts";
import { applyGlobalOptions, commandArgs, PARSER_CONFIGURATION, readGlobals } from "./globals.ts";
import { printFailure, printSuccess } from "./output.ts";
import { findSwallowedNegativeTime, NEGATIVE_TIME_HINT } from "./time-input.ts";

export const VERSION = "0.0.1";

export async function runLeaf(
  spec: CommandSpec<Record<string, unknown>>,
  argv: Record<string, unknown>,
): Promise<void> {
  const globals = readGlobals(argv, process.env);
  const ctx = createContext(globals, { argv: hideBin(process.argv) });
  try {
    if (!spec.noProject) ctx.requireProjectDir();
    const res = await spec.handler(ctx, commandArgs(argv, spec));
    printSuccess(ctx, spec, res);
    process.exitCode = res.exitCode ?? ExitCode.OK;
  } catch (e) {
    const err = toMontashError(e);
    printFailure(ctx, spec.path, err);
    process.exitCode = err.exitCode;
  }
}

/**
 * yargs は `.help("help")` を使うと、位置引数の**末尾**が "help" のときに内蔵ヘルプへ横取りする
 * （yargs-factory の helpCmds 判定）。montash は `help` を独自コマンドとして持つので、
 * 位置引数が "help" ただ 1 つのときだけ空の位置引数を足して横取りを避ける。
 * 空文字は help コマンド側の `.join(" ").trim()` で消えるため「引数なし」と同じ扱いになる。
 * `montash help clip add` は末尾が "add" なので横取りされず、ここでも何もしない。
 */
export function guardHelpCommand(argv: readonly string[]): string[] {
  const positionals = argv.filter((a) => !a.startsWith("-"));
  return positionals.length === 1 && positionals[0] === "help" ? [...argv, ""] : [...argv];
}

/**
 * コマンド定義は `getCommands()`（組み込み + 実行時登録）から取るため async
 * （将来はここでプラグインを `await import()` してから合成する。docs/13 D-18）。
 */
export async function buildCli(rawArgv: string[]) {
  const argv = guardHelpCommand(rawArgv);
  const y = yargs(argv)
    .scriptName("montash")
    .locale("en") // メッセージを OS ロケールに依存させない（AI が読む）
    .usage("$0 <command> [options]\n\nmontash — CLI video editor operated by AI (montage + sh)")
    .version(VERSION)
    .help("help")
    .alias("help", "h")
    .strict()
    .parserConfiguration(PARSER_CONFIGURATION)
    .demandCommand(1, "specify a command (try `montash --help`)")
    .recommendCommands()
    .fail((msg, err, yy) => {
      // 使用法エラーは JSON でも返す（AI が読めるように）
      const wantJson = argv.includes("--json") || process.env.MONTASH_JSON === "1";
      // `--in -f:300` は yargs が短縮フラグとして読む。`=` 形式を案内する（docs/13 B-11）
      const swallowed = findSwallowedNegativeTime(argv);
      const e =
        err instanceof MontashError
          ? err
          : new MontashError("E_USAGE", msg ?? err?.message ?? "usage error", {
              exitCode: ExitCode.USAGE,
              hint: swallowed
                ? `"${swallowed.value}" after "${swallowed.option}" is read as short flags; write it as \`${swallowed.option}=${swallowed.value}\`. ${NEGATIVE_TIME_HINT}`
                : "Run `montash <command> --help` or `montash schema --json`.",
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
  applyGlobalOptions(y);

  registerCommands(y, await getCommands(), runLeaf);
  return y;
}

/**
 * プラグインを読み込んでから CLI を組み立てる（docs/14、W-19）。
 *
 * 読み込みはコマンド定義より **前** に済ませる必要がある。プラグインが登録した効果の
 * パラメータが `effect add` のオプションになり、`schema` / `help` にも載るため。
 *
 * 1 つのプラグインが壊れていても montash 全体は止めない。失敗は stderr に警告として出し、
 * 残りを読み続ける（プロジェクトは開けるべき。F-EXT-4）。
 */
export async function loadPluginsForCli(argv: readonly string[]): Promise<void> {
  // 起動のたびにプロジェクトを探索したくないので、-C / MONTASH_PROJECT と cwd だけを見る
  const projectFlag = argv.findIndex((a) => a === "-C" || a === "--project");
  const explicit = projectFlag >= 0 ? argv[projectFlag + 1] : process.env.MONTASH_PROJECT;
  const projectDir = explicit ?? findProjectDirFrom(process.cwd());
  const verbose = argv.includes("-v") || argv.includes("--verbose");

  const { failures } = await loadAllPlugins(projectDir, {
    ...(verbose ? { onLog: (m: string) => process.stderr.write(`${m}\n`) } : {}),
  });
  for (const f of failures) {
    process.stderr.write(`warning [${f.error.code}]: ${f.error.message}\n`);
    if (f.error.hint) process.stderr.write(`  hint: ${f.error.hint}\n`);
  }
}

if (import.meta.main) {
  const argv = hideBin(process.argv);
  await loadPluginsForCli(argv);
  await (await buildCli(argv)).parseAsync();
}
