/**
 * `montash doctor` — 環境診断（docs/03 W-01, docs/04 §2）
 */
import { readFileSync } from "node:fs";
import { platform, release } from "node:os";
import {
  inspectFfmpeg,
  locateBinaries,
  MIN_FFMPEG,
  RECOMMENDED_FFMPEG,
  STATIC_FFMPEG_HOME,
} from "../../ffmpeg/locate.ts";
import { defineCommand } from "../define-command.ts";
import { MontashError, type Warning, warning } from "../errors.ts";

interface Args extends Record<string, unknown> {
  fixHints: boolean;
}

const MIN_BUN = "1.2.0";

function isWsl(): boolean {
  if (platform() !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function bunVersionOk(v: string): boolean {
  const [a = 0, b = 0] = v.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const [ma = 0, mb = 0] = MIN_BUN.split(".").map((x) => Number.parseInt(x, 10) || 0);
  return a > ma || (a === ma && b >= mb);
}

export const doctor = defineCommand<Args>({
  path: "doctor",
  summary: "check ffmpeg / Bun / platform and report missing features with hints",
  workflows: ["W-01"],
  noProject: true,
  options: {
    "fix-hints": {
      type: "boolean",
      describe: "also run scripts/install-deps.sh --check --json and merge its result",
      default: false,
    },
  },
  examples: [{ cmd: "montash doctor --json" }],
  async handler(ctx, args) {
    const warnings: Warning[] = [];
    const problems: Array<{ code: string; message: string; hint: string }> = [];

    // --- Bun ---
    const bun = { version: Bun.version, ok: bunVersionOk(Bun.version) };
    if (!bun.ok)
      problems.push({
        code: "E_BUN_TOO_OLD",
        message: `Bun ${Bun.version} < ${MIN_BUN}`,
        hint: "Run `bun upgrade`.",
      });

    // --- platform ---
    const plat = {
      os: platform(),
      release: release(),
      arch: process.arch,
      wsl: isWsl(),
      static_ffmpeg_home: STATIC_FFMPEG_HOME,
    };

    // --- ffmpeg ---
    let ffmpeg: Record<string, unknown> = { found: false };
    try {
      const bins = locateBinaries({
        ffmpegPath: ctx.globals.ffmpegPath,
        ffprobePath: ctx.globals.ffprobePath,
        env: ctx.env,
      });
      const info = await inspectFfmpeg(bins);
      ffmpeg = {
        found: true,
        path: bins.ffmpeg,
        ffprobe: bins.ffprobe,
        source: bins.source,
        version: info.version,
        version_ok: info.versionOk,
        best_effort: info.bestEffort,
        required: info.required,
        recommended: info.recommended,
        optional: info.optional,
        text_engine: info.textEngine,
      };
      if (!info.versionOk) {
        problems.push({
          code: "E_FFMPEG_OUTDATED",
          message: `ffmpeg ${info.version} < ${MIN_FFMPEG}`,
          hint: "bash scripts/install-deps.sh --static (Linux/WSL) or brew upgrade ffmpeg (macOS)",
        });
      } else if (info.bestEffort) {
        warnings.push(
          warning(
            "W_FFMPEG_BEST_EFFORT",
            `ffmpeg ${info.version} < ${RECOMMENDED_FFMPEG}: supported on a best-effort basis`,
            {
              hint: "bash scripts/install-deps.sh --static to get a recent build",
            },
          ),
        );
      }
      if (info.required.missing.length) {
        problems.push({
          code: "E_FFMPEG_FEATURE_MISSING",
          message: `ffmpeg lacks required features: ${info.required.missing.join(", ")}`,
          hint: "Install a full-featured build: bash scripts/install-deps.sh --static (Linux/WSL) / brew install ffmpeg (macOS)",
        });
      }
      if (info.recommended.missing.length) {
        const how =
          plat.os === "darwin"
            ? "brew install ffmpeg-full (Homebrew's plain `ffmpeg` formula omits libass/libfreetype)"
            : "bash scripts/install-deps.sh --static";
        warnings.push(
          warning(
            "W_TEXT_ENGINE_LIMITED",
            `ffmpeg lacks recommended filters: ${info.recommended.missing.join(", ")} (text engine: ${info.textEngine})`,
            {
              hint: `libass (subtitles filter) enables wrapping, background boxes and CJK fallback for captions. Fix: ${how}`,
            },
          ),
        );
      }
    } catch (e) {
      const err = e instanceof MontashError ? e : new MontashError("E_FFMPEG_NOT_FOUND", String(e));
      problems.push({
        code: err.code,
        message: err.message,
        hint: err.hint ?? "bash scripts/install-deps.sh",
      });
    }

    // --- install-deps.sh --check --json ---
    let installDeps: unknown;
    if (args.fixHints) {
      try {
        const proc = Bun.spawn(["bash", "scripts/install-deps.sh", "--check", "--json"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        installDeps = JSON.parse(out);
      } catch (e) {
        warnings.push(warning("W_INSTALL_DEPS_UNAVAILABLE", `could not run scripts/install-deps.sh: ${String(e)}`));
      }
    }

    const ok = problems.length === 0;
    const result = {
      ok,
      bun,
      platform: plat,
      ffmpeg,
      problems,
      ...(installDeps !== undefined ? { install_deps: installDeps } : {}),
    };

    const human = () => {
      const lines: string[] = [];
      lines.push(`montash doctor — ${ok ? "OK" : `${problems.length} problem(s)`}`);
      lines.push(`  bun       ${bun.version} ${bun.ok ? "[OK]" : "[TOO OLD]"}`);
      lines.push(`  platform  ${plat.os} ${plat.arch}${plat.wsl ? " (WSL)" : ""}`);
      if (ffmpeg.found) {
        lines.push(
          `  ffmpeg    ${String(ffmpeg.version)} (${String(ffmpeg.source)}: ${String(ffmpeg.path)}) ${ffmpeg.version_ok ? "[OK]" : "[OUTDATED]"}${ffmpeg.best_effort ? " best-effort" : ""}`,
        );
        const req = ffmpeg.required as { present: string[]; missing: string[] };
        const rec = ffmpeg.recommended as {
          present: string[];
          missing: string[];
        };
        lines.push(
          `  required  ${req.missing.length ? `MISSING: ${req.missing.join(", ")}` : `all present (${req.present.length})`}`,
        );
        lines.push(
          `  text      ${String(ffmpeg.text_engine)}${rec.missing.length ? ` (missing: ${rec.missing.join(", ")})` : ""}`,
        );
        const opt = ffmpeg.optional as string[];
        if (opt.length) lines.push(`  optional  ${opt.join(", ")}`);
      } else {
        lines.push("  ffmpeg    not found");
      }
      for (const p of problems) lines.push(`  [${p.code}] ${p.message}\n    hint: ${p.hint}`);
      return lines.join("\n");
    };

    if (!ok) {
      // 問題があっても診断結果は返す（終了コードは 3）
      const first = problems[0]!;
      throw new MontashError(first.code, first.message, {
        hint: first.hint,
        detail: result,
      });
    }
    return { result, warnings, human };
  },
});
