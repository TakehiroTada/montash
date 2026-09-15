/**
 * `montash batch <file.jsonl|-> [--atomic] [--continue-on-error]` — 複数コマンドの一括実行（docs/04 §16、F-AI-5）。
 *
 * ## 実行方式: 同一プロセス
 *
 * 各行は `Bun.spawn` で montash を呼び直すのではなく、`getCommands()` のコマンド定義を
 * **同じプロセスで** 呼ぶ。理由は 3 つ:
 *   1. `--atomic` は「全体で 1 op」（docs/11 §3.2）なので、子プロセスに op を積ませない仕組みが要る。
 *      同一プロセスなら `ctx.mutationRecorder` を渡すだけで済む（子プロセスだと環境変数などで
 *      同じ約束を伝える必要があり、失敗時の巻き戻しも子の成否に依存して脆くなる）。
 *   2. 起動コスト。100 行のバッチで Bun の起動 + プラグイン読み込みを 100 回繰り返すのは無駄。
 *   3. 引数の解釈が本物の CLI と 1 文字も変わらない（同じ yargs 定義・同じ `applyGlobalOptions`）。
 *
 * ## 履歴の残り方
 *
 * - `--atomic`（既定）: 全行をまとめて **1 op**（`command` は `["batch", ...]`、`changes` に全差分）。
 *   docs/11 §3.2 がそう定めている。AI から見ても「このバッチ 1 つ」で undo / checkout できる方が扱いやすい。
 * - `--continue-on-error`: 途中で止まらない = 部分適用が残るので、**各行が通常どおり op を積む**。
 *   どこまで進んだかを op 単位で戻せる必要があるため。
 *
 * ## ロールバック
 *
 * `--atomic` の実行中は op を 1 つも積まない（`MutationRecorder` が記録を横取りする）。
 * したがって失敗時の巻き戻しは **既存の履歴機構そのもの**で足りる: HEAD は開始前のまま動いていないので、
 * `History.checkout("HEAD")` が返すスナップショットを project.json に書き戻せば開始前の状態に戻る
 * （移動は moves.jsonl に残るので監査もできる）。新しいロールバック機構は作っていない。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import yargs from "yargs";
import { type Affects, History, type Op } from "../../core/history/index.ts";
import { atomicWrite, loadProject, parseProject, projectPaths, serializeProject } from "../../core/project.ts";
import type { Project } from "../../core/schema.ts";
import { getCommands } from "../../registry/commands.ts";
import { type BatchLine, parseBatchInput } from "../batch-input.ts";
import type { CommandContext } from "../context.ts";
import { type CommandResult, type CommandSpec, defineCommand, registerCommands } from "../define-command.ts";
import { ExitCode, errors, MontashError, toMontashError, type Warning, warning } from "../errors.ts";
import { applyGlobalOptions, commandArgs, PARSER_CONFIGURATION, readGlobals } from "../globals.ts";
import { headSummary, type MutationRecord, type MutationRecorder } from "../mutate.ts";
import { formatTable } from "../output.ts";
import { timelineSummary } from "./project.ts";

type AnySpec = CommandSpec<Record<string, unknown>>;

/** バッチの中では意味を持たない / 危険なコマンド */
const NEVER_IN_BATCH = new Set(["batch", "serve", "init"]);
/** `--atomic` の「全体で 1 op」を壊すコマンド（HEAD を動かす・自分で op を積む） */
const NOT_IN_ATOMIC_BATCH = new Set([
  "checkout",
  "undo",
  "redo",
  "revert",
  "reset",
  "commit",
  "history import",
  "history prune",
]);

interface LineOutcome {
  line: number;
  index: number;
  args: string[];
  /** 解決したコマンドのパス（"clip add"）。解決前に失敗したら未設定 */
  command?: string;
  status: "ok" | "failed" | "skipped";
  ok: boolean;
  /** その行が積んだ op（--continue-on-error のときだけ付く。--atomic では常に null） */
  op?: string | null;
  summary?: string;
  change_count?: number;
  result?: unknown;
  warnings?: Warning[];
  error?: ReturnType<MontashError["toJSON"]>;
}

// ---------------------------------------------------------------------------
// 1 行の実行
// ---------------------------------------------------------------------------

/** 行ごとのコンテキスト。`-C` などバッチに付いたグローバルは引き継ぎ、出力は黙らせる */
function lineContext(
  ctx: CommandContext,
  args: string[],
  argv: Record<string, unknown>,
  recorder: MutationRecorder | undefined,
): CommandContext {
  const line = readGlobals(argv, ctx.env);
  return {
    ...ctx,
    argv: args,
    globals: {
      ...line,
      project: ctx.globals.project,
      json: false,
      quiet: true,
      verbose: ctx.globals.verbose,
      dryRun: ctx.globals.dryRun || line.dryRun,
      // バッチは非対話（AI が回す）。バッチ自体に --yes が付いていれば各行にも効かせる
      yes: ctx.globals.yes || line.yes,
      ffmpegPath: line.ffmpegPath ?? ctx.globals.ffmpegPath,
      ffprobePath: line.ffprobePath ?? ctx.globals.ffprobePath,
      noColor: true,
      timeFormat: ctx.globals.timeFormat,
      // --atomic では行ごとのコミットはできない（op が 1 つしか無いため）
      ...(recorder ? { message: undefined, body: undefined } : {}),
    },
    ...(recorder ? { mutationRecorder: recorder } : {}),
  };
}

interface LineExecution {
  spec: AnySpec;
  res: CommandResult | null;
  /** 行に `-m` が付いていたが --atomic で無視した */
  messageIgnored: boolean;
}

/**
 * 1 行を本物の CLI と同じ yargs 定義で解釈して実行する。
 * `plan` が true なら解釈だけ行い、ハンドラは呼ばない（`--dry-run`）。
 */
async function executeLine(
  ctx: CommandContext,
  specs: readonly AnySpec[],
  args: string[],
  opts: { atomic: boolean; recorder?: MutationRecorder; plan: boolean },
): Promise<LineExecution> {
  let captured: LineExecution | null = null;
  const y = yargs(args)
    .scriptName("montash")
    .locale("en")
    .exitProcess(false)
    .strict()
    .help(false)
    .version(false)
    .parserConfiguration(PARSER_CONFIGURATION)
    .demandCommand(1, "specify a command")
    .fail((msg, err) => {
      if (err) throw err;
      throw new MontashError("E_USAGE", msg ?? "usage error", {
        exitCode: ExitCode.USAGE,
        hint: "Run `montash schema --json` for the accepted arguments of each command.",
      });
    });
  applyGlobalOptions(y);
  registerCommands(y, specs, async (spec, argv) => {
    if (NEVER_IN_BATCH.has(spec.path))
      throw new MontashError("E_BATCH_UNSUPPORTED", `\`${spec.path}\` cannot be run inside a batch`, {
        hint: "Run it as its own command before or after the batch.",
        detail: { command: spec.path },
      });
    if (opts.atomic && NOT_IN_ATOMIC_BATCH.has(spec.path))
      throw new MontashError(
        "E_BATCH_UNSUPPORTED",
        `\`${spec.path}\` moves HEAD or records its own op, so it cannot be part of an atomic batch`,
        {
          hint: `Run \`montash ${spec.path}\` outside the batch, or use \`montash batch --continue-on-error\` (each line then records its own op).`,
          detail: { command: spec.path, mode: "atomic" },
        },
      );
    const messageIgnored = opts.recorder !== undefined && typeof argv.message === "string";
    if (opts.plan) {
      captured = { spec, res: null, messageIgnored };
      return;
    }
    const sub = lineContext(ctx, args, argv, opts.recorder);
    if (!spec.noProject) sub.requireProjectDir();
    const res = await spec.handler(sub, commandArgs(argv, spec));
    captured = { spec, res, messageIgnored };
  });
  await y.parseAsync();
  if (captured === null)
    throw new MontashError("E_BATCH_UNSUPPORTED", "the line did not resolve to a runnable command", {
      hint: "Each line must name a leaf command, e.g. `clip add ...` (not just `clip`).",
    });
  return captured;
}

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

/**
 * `<file>` を読む。`-` は標準入力。
 *
 * yargs-parser は単独の `-` を位置引数の**空文字**にしてしまう（`_` にも残らない）ので、
 * 空文字のときは実引数に `-` があったかで判断する。
 */
async function readBatchSource(ctx: CommandContext, file: string): Promise<{ text: string; source: string }> {
  const stdin = file === "-" || (file === "" && ctx.argv.includes("-"));
  if (stdin) return { text: await Bun.stdin.text(), source: "<stdin>" };
  if (file === "") throw errors.usage("missing <file>", "montash batch <file.jsonl|->");
  const path = resolve(ctx.cwd, file);
  try {
    return { text: await readFile(path, "utf8"), source: path };
  } catch (err) {
    throw new MontashError("E_IO", `cannot read ${path}`, {
      hint: "Pass a JSON Lines file (one command per line) or `-` to read from stdin.",
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

function mergeAffects(records: readonly MutationRecord[]): Affects | undefined {
  const clips = new Set<string>();
  let from: number | null = null;
  let to: number | null = null;
  let any = false;
  for (const r of records) {
    if (!r.affects) continue;
    any = true;
    for (const c of r.affects.clips) clips.add(c);
    if (r.affects.range_f) {
      const [a, b] = r.affects.range_f;
      from = from === null ? a : Math.min(from, a);
      to = to === null ? b : Math.max(to, b);
    }
  }
  // 1 行も affects を持たないなら recordOp に changes から導出させる
  if (!any) return undefined;
  return { clips: [...clips], range_f: from === null || to === null ? null : [from, to] };
}

function batchSummary(source: string, lineCount: number, records: readonly MutationRecord[]): string {
  const head = `batch ${source}: ${lineCount} command(s)`;
  const detail = records.map((r) => r.summary).join("; ");
  if (detail === "") return head;
  const joined = `${head} — ${detail}`;
  return joined.length <= 200 ? joined : `${joined.slice(0, 197)}...`;
}

function humanReport(result: BatchResult): string {
  const rows = result.lines.map((l) => ({
    line: l.line,
    command: l.command ?? l.args.join(" "),
    status: l.status,
    op: l.op ?? "-",
    detail: l.status === "failed" ? `${l.error?.code}: ${l.error?.message}` : (l.summary ?? ""),
  }));
  const head =
    `batch ${result.source} — ${result.succeeded}/${result.total} ok` +
    (result.failed ? `, ${result.failed} failed` : "") +
    (result.skipped ? `, ${result.skipped} skipped` : "") +
    ` (${result.mode}${result.dry_run ? ", dry-run" : ""})`;
  const tail = result.rolled_back ? "\nrolled back to the state before the batch (nothing was applied)" : "";
  return `${head}\n${formatTable(rows, ["line", "command", "status", "op", "detail"])}${tail}`;
}

interface BatchResult {
  source: string;
  mode: "atomic" | "continue-on-error";
  dry_run: boolean;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  rolled_back: boolean;
  lines: LineOutcome[];
}

// ---------------------------------------------------------------------------
// ロールバック（既存の履歴機構: checkout HEAD）
// ---------------------------------------------------------------------------

/**
 * 開始前の状態へ戻す。--atomic 中は op を積んでいないので HEAD は開始時のまま = `checkout HEAD` で戻せる。
 * 開始前から project.json が HEAD と食い違っていた（手編集）場合だけ、その内容を書き戻す。
 */
async function rollback(
  ctx: CommandContext,
  dir: string,
  history: History,
  before: Project,
  dirty: boolean,
): Promise<{ via: "checkout" | "worktree"; head: string | null; warnings: Warning[] }> {
  const state = await history.status();
  if (state.head !== null && !dirty) {
    const move = await history.checkout("HEAD", ctx.actor, ctx.actorDetail);
    const project = parseProject(move.project, `history object ${move.target.after}`);
    await atomicWrite(projectPaths(dir).projectFile, serializeProject(project));
    return { via: "checkout", head: move.target.id, warnings: move.warnings };
  }
  await atomicWrite(projectPaths(dir).projectFile, serializeProject(before));
  return {
    via: "worktree",
    head: state.head,
    warnings: dirty
      ? [
          warning("W_DIRTY_WORKTREE", "project.json did not match HEAD when the batch started", {
            hint: "The batch restored the file exactly as it was before it ran, hand edits included.",
          }),
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// コマンド定義
// ---------------------------------------------------------------------------

interface Args extends Record<string, unknown> {
  file: string;
  atomic: boolean;
  continueOnError: boolean;
}

export const batch = defineCommand<Args>({
  path: "batch",
  summary: "run several commands from a JSON Lines file (or stdin) as one operation",
  description:
    'One command per line: {"args": ["clip", "add", "--asset", "a", "--at", "end"]}, a bare JSON array, ' +
    "or a plain shell line. Blank lines and lines starting with # are ignored. " +
    "--atomic (the default) rolls the project back to the state it had before the batch if any line fails, " +
    "and records the whole batch as a single op. --continue-on-error keeps going after a failure and lets " +
    "each line record its own op. Only the timeline state (project.json) is rolled back — files written by " +
    "`render` / `proxy build` are not removed.",
  workflows: ["W-20"],
  mutates: true,
  positionals: [{ name: "file", describe: "JSON Lines file, or - to read from stdin", required: true }],
  options: {
    atomic: {
      type: "boolean",
      default: true,
      describe: "roll back to the state before the batch if any line fails, and record one op (default)",
    },
    "continue-on-error": {
      type: "boolean",
      default: false,
      describe: "keep going after a failing line (implies --no-atomic; each line records its own op)",
    },
  },
  examples: [
    { cmd: "montash batch edits.jsonl --json" },
    { cmd: 'printf \'{"args":["clip","add","--asset","a","--at","end"]}\\n\' | montash batch - --json' },
    { cmd: "montash batch edits.jsonl --continue-on-error --json", note: "apply what works, report the rest" },
    { cmd: 'montash batch edits.jsonl -m "素材 3 本を並べて繋ぎをクロスフェード"', note: "run and commit" },
  ],
  async handler(ctx, args) {
    const startedAt = Date.now();
    const dir = ctx.requireProjectDir();
    if (args.file === undefined || args.file === null)
      throw errors.usage("missing <file>", "montash batch <file.jsonl|->");

    const continueOnError = Boolean(args.continueOnError);
    if (continueOnError && ctx.argv.includes("--atomic"))
      throw errors.usage(
        "--atomic and --continue-on-error are mutually exclusive",
        "Use --atomic to roll everything back on the first failure, or --continue-on-error to apply what works.",
      );
    const atomic = continueOnError ? false : args.atomic !== false;

    const { text, source } = await readBatchSource(ctx, String(args.file));
    const lines: BatchLine[] = parseBatchInput(text); // 構文エラーはここで全部落とす（1 行も実行しない）
    if (lines.length === 0)
      throw new MontashError("E_BATCH_EMPTY", `${source} has no commands to run`, {
        hint: 'Write one command per line, e.g. {"args": ["clip", "add", "--asset", "a", "--at", "end"]}.',
        detail: { source },
      });

    const specs = await getCommands();
    const history = await History.open(dir);
    const before = await loadProject(dir);
    const startState = await history.status({ project: before });
    const dirty = startState.dirty === true;

    const mutations: MutationRecord[] = [];
    const recorder: MutationRecorder | undefined = atomic ? { record: (m) => void mutations.push(m) } : undefined;
    const warnings: Warning[] = [];
    const outcomes: LineOutcome[] = [];
    let failedAt: LineOutcome | null = null;

    for (const item of lines) {
      if (failedAt !== null && !continueOnError) {
        outcomes.push({ line: item.line, index: item.index, args: item.args, status: "skipped", ok: false });
        continue;
      }
      const seen = mutations.length;
      try {
        const exec = await executeLine(ctx, specs, item.args, {
          atomic,
          ...(recorder ? { recorder } : {}),
          plan: ctx.globals.dryRun,
        });
        const mine = mutations.slice(seen);
        const res = exec.res;
        if (exec.messageIgnored)
          warnings.push(
            warning("W_BATCH_MESSAGE_IGNORED", `line ${item.line}: -m is ignored inside an atomic batch`, {
              hint: "An atomic batch is a single op; pass -m to `montash batch` itself to commit the whole batch.",
              detail: { line: item.line },
            }),
          );
        for (const w of res?.warnings ?? []) warnings.push({ ...w, detail: { ...w.detail, batch_line: item.line } });
        outcomes.push({
          line: item.line,
          index: item.index,
          args: item.args,
          command: exec.spec.path,
          status: "ok",
          ok: true,
          op: res?.op ?? null,
          ...(mine.length > 0 ? { summary: mine.map((m) => m.summary).join("; ") } : {}),
          change_count: recorder ? mine.reduce((n, m) => n + m.changes.length, 0) : (res?.changes?.length ?? 0),
          ...(res?.result !== undefined ? { result: res.result } : {}),
          ...((res?.warnings?.length ?? 0) > 0 ? { warnings: res?.warnings } : {}),
        });
      } catch (err) {
        const e = toMontashError(err);
        const outcome: LineOutcome = {
          line: item.line,
          index: item.index,
          args: item.args,
          status: "failed",
          ok: false,
          error: e.toJSON(),
        };
        outcomes.push(outcome);
        failedAt ??= outcome;
      }
    }

    const succeeded = outcomes.filter((o) => o.status === "ok").length;
    const failed = outcomes.filter((o) => o.status === "failed").length;
    const skipped = outcomes.filter((o) => o.status === "skipped").length;
    const base: Omit<BatchResult, "rolled_back"> = {
      source,
      mode: atomic ? "atomic" : "continue-on-error",
      dry_run: ctx.globals.dryRun,
      total: lines.length,
      succeeded,
      failed,
      skipped,
      lines: outcomes,
    };

    // --dry-run: 解釈だけして何も書かない（docs/04 §1.4）
    if (ctx.globals.dryRun) {
      const result: BatchResult = { ...base, rolled_back: false };
      if (failedAt)
        throw new MontashError("E_BATCH_FAILED", `batch would fail at line ${failedAt.line}: ${failedAt.error?.code}`, {
          hint: failedAt.error?.hint ?? "Fix the reported line and run the batch again.",
          detail: { ...result },
        });
      return {
        result,
        warnings,
        op: null,
        commit: null,
        head: headSummary(startState),
        timeline: timelineSummary(before),
        human: humanReport(result),
      };
    }

    // --atomic かつ失敗: 開始前へ巻き戻す（op は 1 つも積んでいないので checkout HEAD で戻る）
    if (atomic && failedAt) {
      // 1 行も適用されていなければ project.json は触っていない（runMutation は成功時しか書かない）
      const back =
        mutations.length > 0
          ? await rollback(ctx, dir, history, before, dirty)
          : { via: "nothing-applied" as const, head: startState.head, warnings: [] };
      warnings.push(...back.warnings);
      const result: BatchResult = { ...base, rolled_back: mutations.length > 0 };
      const e = failedAt.error;
      throw new MontashError(
        "E_BATCH_FAILED",
        `batch failed at line ${failedAt.line} of ${lines.length} (${failedAt.args.join(" ")}): ` +
          `${e?.code} ${e?.message}` +
          (result.rolled_back ? "; rolled back to the state before the batch" : "; nothing had been applied yet"),
        {
          exitCode: ExitCode.GENERAL,
          hint:
            (e?.hint ? `${e.hint} ` : "") +
            "Nothing was applied: fix that line and run the file again. `detail.lines` shows every line's result.",
          detail: { ...result, rollback: { via: back.via, head: back.head }, warnings },
        },
      );
    }

    const after = await loadProject(dir);
    let op: Op | null = null;
    let opWarnings: Warning[] = [];
    if (atomic && mutations.length > 0) {
      const affects = mergeAffects(mutations);
      const rec = await history.recordOp({
        before,
        after,
        command: ctx.argv,
        actor: ctx.actor,
        ...(ctx.actorDetail !== undefined ? { actorDetail: ctx.actorDetail } : {}),
        summary: batchSummary(source, lines.length, mutations),
        ...(affects !== undefined ? { affects } : {}),
        durationMs: Date.now() - startedAt,
      });
      op = rec.op;
      opWarnings = rec.warnings;
    }
    warnings.push(...opWarnings);

    let commitId: string | null = null;
    if (ctx.globals.message !== undefined && failed === 0) {
      const commit = await history.commit({
        message: ctx.globals.message,
        ...(ctx.globals.body !== undefined ? { body: ctx.globals.body } : {}),
        author: ctx.env.MONTASH_AUTHOR ?? ctx.actor,
        ...(ctx.actorDetail !== undefined ? { authorDetail: ctx.actorDetail } : {}),
      });
      commitId = commit.id;
    }

    const result: BatchResult = { ...base, rolled_back: false };
    return {
      ...(failed > 0 ? { exitCode: ExitCode.GENERAL } : {}),
      result,
      ...(op ? { changes: op.changes } : {}),
      warnings,
      op: op?.id ?? null,
      commit: commitId,
      head: headSummary(await history.status()),
      timeline: timelineSummary(after),
      human: humanReport(result),
    };
  },
});
