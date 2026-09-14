/**
 * 出力整形（docs/04 §1.5）。成功・失敗とも --json では 1 つの JSON オブジェクト、
 * 既定は人間向けテキスト。エラーは code / message / hint を必ず含む。
 */
import type { CommandContext } from "./context.ts";
import type { CommandResult, CommandSpec } from "./define-command.ts";
import { MontashError, type Warning } from "./errors.ts";

export interface SuccessEnvelope {
  ok: true;
  command: string;
  result?: unknown;
  changes?: unknown[];
  warnings: Warning[];
  op: string | null;
  commit: string | null;
  head: CommandResult["head"];
  timeline?: unknown;
}

export interface FailureEnvelope {
  ok: false;
  command: string;
  error: { code: string; message: string; hint?: string; detail?: Record<string, unknown> };
  warnings?: Warning[];
}

export function successEnvelope(spec: Pick<CommandSpec, "path">, res: CommandResult): SuccessEnvelope {
  return {
    ok: true,
    command: spec.path,
    ...(res.result !== undefined ? { result: res.result } : {}),
    ...(res.changes !== undefined ? { changes: res.changes } : {}),
    warnings: res.warnings ?? [],
    op: res.op ?? null,
    commit: res.commit ?? null,
    head: res.head ?? null,
    ...(res.timeline !== undefined ? { timeline: res.timeline } : {}),
  };
}

export function failureEnvelope(command: string, err: MontashError, warnings?: Warning[]): FailureEnvelope {
  return {
    ok: false,
    command,
    error: err.toJSON(),
    ...(warnings && warnings.length ? { warnings } : {}),
  };
}

const useColor = (ctx: CommandContext): boolean => !ctx.globals.noColor && Boolean(process.stdout.isTTY) && !("NO_COLOR" in ctx.env);
const paint = (ctx: CommandContext, code: string, s: string): string => (useColor(ctx) ? `\x1b[${code}m${s}\x1b[0m` : s);

export function printSuccess(ctx: CommandContext, spec: Pick<CommandSpec, "path">, res: CommandResult): void {
  if (ctx.globals.json) {
    ctx.stdout(JSON.stringify(successEnvelope(spec, res)) + "\n");
    return;
  }
  if (ctx.globals.quiet) return;
  const human = typeof res.human === "function" ? res.human() : res.human;
  if (human !== undefined) {
    ctx.stdout(human.endsWith("\n") ? human : human + "\n");
  } else if (res.result !== undefined) {
    ctx.stdout(JSON.stringify(res.result, null, 2) + "\n");
  }
  for (const w of res.warnings ?? []) {
    ctx.stderr(paint(ctx, "33", `warning [${w.code}]`) + `: ${w.message}` + (w.hint ? `\n  hint: ${w.hint}` : "") + "\n");
  }
  if (res.op) {
    ctx.stderr(paint(ctx, "2", `op ${res.op}${res.commit ? ` → commit ${res.commit}` : ""}`) + "\n");
  }
}

export function printFailure(ctx: CommandContext, command: string, err: MontashError): void {
  if (ctx.globals.json) {
    ctx.stdout(JSON.stringify(failureEnvelope(command, err)) + "\n");
    return;
  }
  ctx.stderr(paint(ctx, "31", `error [${err.code}]`) + `: ${err.message}\n`);
  if (err.hint) ctx.stderr(`  hint: ${err.hint}\n`);
  if (ctx.globals.verbose && err.detail) ctx.stderr(`  detail: ${JSON.stringify(err.detail)}\n`);
  if (ctx.globals.verbose && err.cause instanceof Error && err.cause.stack) ctx.stderr(err.cause.stack + "\n");
}

/** 人間向けテーブル（簡易）。列幅は内容に合わせる */
export function formatTable(rows: Array<Record<string, string | number | boolean | null | undefined>>, columns?: string[]): string {
  if (rows.length === 0) return "(empty)";
  const cols = columns ?? Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const cell = (v: unknown): string => (v === null || v === undefined ? "-" : String(v));
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
  const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(cols), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join("\n");
}
