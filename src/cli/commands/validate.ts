/**
 * `montash validate [--deep] [--strict]`（docs/04 §3, docs/05 §14）
 *
 * error があれば E_VALIDATION_FAILED（終了コード 5）。結果は detail に errors / warnings を含める。
 */
import { defineCommand } from "../define-command.ts";
import { ExitCode, MontashError, warning, type Warning } from "../errors.ts";
import { loadProject } from "../../core/project.ts";
import { type Issue, validateProject } from "../../core/validate.ts";
import { timelineSummary } from "./project.ts";

interface Args extends Record<string, unknown> {
  deep: boolean;
  strict: boolean;
}

export const validate = defineCommand<Args>({
  path: "validate",
  summary: "check project.json invariants (references, ranges, overlaps, handles, gaps)",
  workflows: ["W-03", "W-09", "W-13"],
  options: {
    deep: { type: "boolean", describe: "also check that asset files exist (ffmpeg decode check: not implemented yet)", default: false },
    strict: { type: "boolean", describe: "treat gaps and fps/resolution mismatches as errors", default: false },
  },
  examples: [{ cmd: "montash validate --json" }, { cmd: "montash validate --deep --strict" }],
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const res = validateProject(project, { checkFiles: Boolean(args.deep), strict: Boolean(args.strict), dir });
    const warnings: Warning[] = [];
    if (args.deep) {
      // TODO(ffmpeg): 各アセットの先頭 1 秒をデコードして読めるか確認する（docs/04 §3）。src/ffmpeg 側の実装待ち
      warnings.push(warning("W_DEEP_NOT_IMPLEMENTED", "--deep checked file existence only; ffmpeg decode and font checks are not implemented yet"));
    }
    const result = { ok: res.ok, errors: res.errors, warnings: res.warnings, strict: Boolean(args.strict), deep: Boolean(args.deep) };
    const human = () => formatHuman(result);

    if (!res.ok) {
      // 人間向けでは一覧を stderr に出してから失敗させる（JSON では detail に全件入る）
      if (!ctx.globals.json && !ctx.globals.quiet) ctx.stderr(human() + "\n");
      throw new MontashError("E_VALIDATION_FAILED", `${res.errors.length} error(s), ${res.warnings.length} warning(s)`, {
        hint: res.errors[0]?.hint ?? "Fix the listed errors (see detail.errors).",
        detail: { errors: res.errors, warnings: res.warnings },
        exitCode: ExitCode.VALIDATION,
      });
    }
    return { result, warnings, timeline: timelineSummary(project), human };
  },
});

function formatIssue(prefix: string, i: Issue): string {
  const loc = i.path ? ` (${i.path})` : "";
  return `  ${prefix} [${i.code}] ${i.message}${loc}${i.hint ? `\n      hint: ${i.hint}` : ""}`;
}

function formatHuman(r: { ok: boolean; errors: Issue[]; warnings: Issue[] }): string {
  const lines = [`validate — ${r.ok ? "OK" : "FAILED"}: ${r.errors.length} error(s), ${r.warnings.length} warning(s)`];
  for (const e of r.errors) lines.push(formatIssue("error  ", e));
  for (const w of r.warnings) lines.push(formatIssue("warning", w));
  return lines.join("\n");
}
