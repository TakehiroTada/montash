/**
 * montash のエラー型と終了コード（docs/04 §1.6, §1.7）。
 *
 * すべてのコマンドは MontashError を投げる。cli/output.ts が JSON / テキストに整形する。
 * `hint` は「AI が次に何をすべきか」を書く（docs/10 §5）。
 */

export const ExitCode = {
  OK: 0,
  GENERAL: 1,
  USAGE: 2,
  EXTERNAL: 3,
  IO: 4,
  VALIDATION: 5,
  INTERRUPTED: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface MontashErrorOptions {
  hint?: string;
  detail?: Record<string, unknown>;
  exitCode?: ExitCode;
  cause?: unknown;
}

export class MontashError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly detail: Record<string, unknown> | undefined;
  readonly exitCode: ExitCode;

  constructor(code: string, message: string, opts: MontashErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "MontashError";
    this.code = code;
    this.hint = opts.hint;
    this.detail = opts.detail;
    this.exitCode = opts.exitCode ?? defaultExitCode(code);
  }

  toJSON(): { code: string; message: string; hint?: string; detail?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

/** コードのプレフィックスから既定の終了コードを決める（個別指定が無い場合） */
function defaultExitCode(code: string): ExitCode {
  if (code.startsWith("E_FFMPEG") || code === "E_BUN_TOO_OLD") return ExitCode.EXTERNAL;
  if (code === "E_USAGE" || code === "E_INVALID_TIME" || code === "E_UNKNOWN_COMMAND") return ExitCode.USAGE;
  if (code.endsWith("_MISSING") || code === "E_OUTPUT_EXISTS" || code === "E_PATH_OUTSIDE_PROJECT" || code === "E_IO") return ExitCode.IO;
  if (code === "E_VALIDATION_FAILED" || code === "E_STRICT") return ExitCode.VALIDATION;
  return ExitCode.GENERAL;
}

/** 警告（docs/04 §1.7）。失敗ではないが AI に伝えるべき情報 */
export interface Warning {
  code: string;
  message: string;
  hint?: string;
  detail?: Record<string, unknown>;
}

export function warning(code: string, message: string, extra: Omit<Warning, "code" | "message"> = {}): Warning {
  return { code, message, ...extra };
}

/** 任意の例外を MontashError に正規化する */
export function toMontashError(err: unknown): MontashError {
  if (err instanceof MontashError) return err;
  if (err instanceof Error) {
    return new MontashError("E_INTERNAL", err.message, { detail: { name: err.name, stack: err.stack }, cause: err });
  }
  return new MontashError("E_INTERNAL", String(err));
}

// ---- よく使うエラーのファクトリ ----

export const errors = {
  usage: (message: string, hint?: string) => new MontashError("E_USAGE", message, { hint, exitCode: ExitCode.USAGE }),
  projectNotFound: (searchedFrom: string) =>
    new MontashError("E_PROJECT_NOT_FOUND", `project.json not found (searched upward from ${searchedFrom})`, {
      hint: "Run `montash init <dir>` to create a project, or pass `-C <dir>` / set MONTASH_PROJECT.",
      detail: { searched_from: searchedFrom },
    }),
  projectExists: (dir: string) =>
    new MontashError("E_PROJECT_EXISTS", `project.json already exists in ${dir}`, {
      hint: "Use --force to overwrite (this discards the existing project), or choose another directory.",
      detail: { dir },
    }),
  ffmpegNotFound: (what: "ffmpeg" | "ffprobe") =>
    new MontashError("E_FFMPEG_NOT_FOUND", `${what} was not found on PATH`, {
      hint: "Run `bash scripts/install-deps.sh` (macOS: brew, Linux/WSL: static build), or pass --ffmpeg-path / set MONTASH_FFMPEG.",
      exitCode: ExitCode.EXTERNAL,
    }),
  notImplemented: (what: string) =>
    new MontashError("E_NOT_IMPLEMENTED", `${what} is not implemented yet`, { hint: "See docs/09-roadmap.md for the milestone." }),
};
