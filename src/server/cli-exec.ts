/**
 * POST /api/cli の実行基盤（docs/06 §3.3, docs/08 §3.1b, §4.5）。
 *
 * - 許可リスト照合（`args[0]` と `args[0] + " " + args[1]` を照合）
 * - 破壊的操作の confirm 必須判定（`--force` / `--overwrite` / `reset` / `revert`）
 * - 直列キュー（同時実行しない）
 * - `montash` を **同じランタイムで子プロセス実行**（開発: `bun src/cli/index.ts`、コンパイル済み: 自分自身）
 *
 * 「開発 / コンパイル済み」の切替はこのファイルに閉じ込める（docs/12 ADR-03）。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** 既定の許可リスト（docs/06 §3.3）。`"reset --hard"` のように 2 語で照合するものを含む */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  // 履歴移動
  "checkout",
  "undo",
  "redo",
  "tag",
  "tag delete",
  "revert",
  "reset --hard",
  // 素材管理
  "import",
  "assets set",
  "assets set-text",
  "assets new-text",
  "assets remove",
  "assets relink",
  "proxy build",
  // 補助
  "preview build",
  "validate",
];

/** サーバ側で固定し、クライアントからの上書きを禁止するグローバルオプション（docs/08 §4.5） */
export const FORBIDDEN_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "--project",
  "--ffmpeg-path",
  "--ffprobe-path",
  "--json",
  "--yes",
  "-y",
]);

// ---------------------------------------------------------------------------
// 許可リストの合成（docs/06 §3.3）
//
//   既定（DEFAULT_ALLOWLIST） + プラグインの webAllow + `serve --allow`  −  `serve --deny`
//
// `--deny` は最後に引くので `--allow` にも `webAllow` にも勝つ（利用者の明示指定が最優先）。
// ---------------------------------------------------------------------------

/** 許可リスト 1 エントリの出自。`"default"` / `"flag"` / `"plugin:<id>"` */
export type AllowlistOrigin = "default" | "flag" | `plugin:${string}`;

export interface AllowlistEntry {
  /** 照合に使うコマンド（`"checkout"` / `"assets set"` のように 2 語まで） */
  command: string;
  /** 出自。同じコマンドが複数の出自から来た場合は追加順に並ぶ */
  origins: AllowlistOrigin[];
}

export interface ResolvedAllowlist {
  /** 照合に使うコマンド配列（従来の `allowlist` と同じ形・同じ順） */
  allowlist: string[];
  /** 出自つきの内訳（`allowlist` と同じ順） */
  entries: AllowlistEntry[];
  /** `--deny` で取り除かれたコマンド */
  denied: string[];
}

/** 許可リストに `webAllow` を提供するプラグイン（`src/plugins` に依存しないための最小形） */
export interface AllowlistPlugin {
  id: string;
  webAllow?: readonly string[];
}

export interface AllowlistSources {
  /** 土台になる許可リスト（既定: `DEFAULT_ALLOWLIST`） */
  base?: readonly string[];
  /** プラグインのマニフェスト宣言（`webAllow`） */
  plugins?: readonly AllowlistPlugin[];
  /** `serve --allow` で足すコマンド */
  allow?: readonly string[];
  /** `serve --deny` で引くコマンド。`allow` / `webAllow` より強い */
  deny?: readonly string[];
}

/** 前後の空白を落とし、語の区切りを 1 つの空白にそろえる */
export function normalizeAllowlistCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * 許可リストを合成する。何も渡さなければ `DEFAULT_ALLOWLIST` と完全に同一（順序込み）。
 */
export function resolveAllowlist(src: AllowlistSources = {}): ResolvedAllowlist {
  const denied: string[] = [];
  for (const raw of src.deny ?? []) {
    const command = normalizeAllowlistCommand(raw);
    if (command !== "" && !denied.includes(command)) denied.push(command);
  }
  const denySet = new Set(denied);

  const byCommand = new Map<string, AllowlistEntry>();
  const add = (raw: string, origin: AllowlistOrigin): void => {
    const command = normalizeAllowlistCommand(raw);
    if (command === "" || denySet.has(command)) return;
    const found = byCommand.get(command);
    if (found) {
      if (!found.origins.includes(origin)) found.origins.push(origin);
      return;
    }
    byCommand.set(command, { command, origins: [origin] });
  };

  for (const command of src.base ?? DEFAULT_ALLOWLIST) add(command, "default");
  for (const plugin of src.plugins ?? [])
    for (const command of plugin.webAllow ?? []) add(command, `plugin:${plugin.id}`);
  for (const command of src.allow ?? []) add(command, "flag");

  const entries = [...byCommand.values()];
  return { allowlist: entries.map((e) => e.command), entries, denied };
}

export interface AllowCheck {
  allowed: boolean;
  /** 一致した許可リストのエントリ */
  matched?: string;
  /** 拒否理由（許可リスト外 / 禁止フラグ） */
  reason?: string;
}

/** 許可リスト照合。`args[0]`、`args[0] args[1]` のいずれかが含まれれば許可 */
export function checkAllowlist(args: readonly string[], allowlist: readonly string[] = DEFAULT_ALLOWLIST): AllowCheck {
  const [a0, a1] = args;
  if (typeof a0 !== "string" || a0.length === 0 || a0.startsWith("-")) {
    return { allowed: false, reason: "args[0] must be a command name" };
  }
  for (const a of args) {
    if (typeof a !== "string") return { allowed: false, reason: "args must be strings" };
    const flag = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (FORBIDDEN_FLAGS.has(flag)) return { allowed: false, reason: `global option ${flag} is fixed by the server` };
  }
  const two = typeof a1 === "string" ? `${a0} ${a1}` : null;
  if (two !== null && allowlist.includes(two)) return { allowed: true, matched: two };
  if (allowlist.includes(a0)) return { allowed: true, matched: a0 };
  return { allowed: false, reason: `"${two ?? a0}" is not in the allowlist` };
}

/** 破壊的操作かどうか（confirm: true が必要） */
export function needsConfirm(args: readonly string[]): boolean {
  const [a0] = args;
  if (a0 === "reset" || a0 === "revert") return true;
  return args.some(
    (a) => a === "--force" || a === "--overwrite" || a.startsWith("--force=") || a.startsWith("--overwrite="),
  );
}

/**
 * `montash` を起動するコマンド列の先頭部分を返す。
 * - 開発（`bun src/cli/index.ts ...`）: `[bun, <repo>/src/cli/index.ts]`
 * - コンパイル済み単一バイナリ: `[process.execPath]`（自分自身。`src/cli/index.ts` はディスク上に無い）
 */
export function resolveCliCommand(): string[] {
  const entry = resolve(import.meta.dir, "../cli/index.ts");
  if (existsSync(entry)) return [process.execPath, entry];
  return [process.execPath];
}

export interface ExecResult {
  /** HTTP ステータス（CLI の成否には依存しない。spawn 自体の失敗のみ 500） */
  status: number;
  body: Record<string, unknown>;
}

export interface CliExecutorOptions {
  projectDir: string;
  /** 許可リスト。文字列配列（従来どおり）か、出自つきの `resolveAllowlist()` の戻り値 */
  allowlist?: readonly string[] | ResolvedAllowlist;
  /** 1 コマンドのタイムアウト（ms）。docs/06 §3.3 は 60 秒 */
  timeoutMs?: number;
  /** テスト用: spawn するコマンド列の先頭を差し替える */
  command?: string[];
  env?: Record<string, string | undefined>;
}

export class CliExecutor {
  readonly allowlist: readonly string[];
  /** 出自つきの許可リスト（`GET /api/cli/allowlist` が返す） */
  readonly allowlistDetail: ResolvedAllowlist;
  private readonly projectDir: string;
  private readonly timeoutMs: number;
  private readonly command: string[];
  private readonly env: Record<string, string | undefined>;
  /** 直列キュー: 直前の実行の完了を待ってから次を始める */
  private tail: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(opts: CliExecutorOptions) {
    this.projectDir = opts.projectDir;
    this.allowlistDetail = toResolvedAllowlist(opts.allowlist);
    this.allowlist = this.allowlistDetail.allowlist;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.command = opts.command ?? resolveCliCommand();
    this.env = opts.env ?? process.env;
  }

  /** リクエスト本体を検証し、許可されていればキューに入れて実行する */
  async handle(payload: unknown, clientDetail: string): Promise<ExecResult> {
    const body = (payload ?? {}) as { args?: unknown; confirm?: unknown };
    if (!Array.isArray(body.args) || body.args.length === 0 || !body.args.every((a) => typeof a === "string")) {
      return fail(400, "E_USAGE", "body must be { args: string[], confirm?: boolean }");
    }
    const args = body.args as string[];
    const check = checkAllowlist(args, this.allowlist);
    if (!check.allowed) {
      return fail(403, "E_WEB_COMMAND_NOT_ALLOWED", `command not allowed from web: ${check.reason ?? args.join(" ")}`, {
        hint: "Run this command from the CLI instead. See GET /api/cli/allowlist for what the web UI may run.",
        detail: { args, allowlist: this.allowlist },
      });
    }
    if (needsConfirm(args) && body.confirm !== true) {
      return fail(409, "E_CONFIRM_REQUIRED", "this operation is destructive and requires confirmation", {
        hint: "Resend with { confirm: true } after the user confirms.",
        detail: { args },
      });
    }
    return this.enqueue(() => this.spawn(args, clientDetail));
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async spawn(args: string[], clientDetail: string): Promise<ExecResult> {
    const id = ++this.seq;
    const full = [...this.command, ...args, "--json", "--yes", "-C", this.projectDir];
    const started = performance.now();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(full, {
        cwd: this.projectDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...this.env, MONTASH_ACTOR: "web", MONTASH_ACTOR_DETAIL: clientDetail, MONTASH_JSON: "1" },
      });
    } catch (e) {
      return fail(500, "E_CLI_SPAWN_FAILED", `failed to spawn montash: ${String(e)}`, { detail: { command: full } });
    }
    const timer = setTimeout(() => proc.kill("SIGTERM"), this.timeoutMs);
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const durationMs = Math.round(performance.now() - started);
    const exec = {
      id: `x_${id}`,
      args,
      actor: "web",
      actor_detail: clientDetail,
      duration_ms: durationMs,
      exit_code: exitCode,
    };

    // CLI の --json 出力は 1 行 1 JSON。最後の非空行を採用する
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const last = lines.at(-1);
    if (last === undefined) {
      const code = exitCode === null || exitCode === 143 ? "E_CLI_TIMEOUT" : "E_CLI_OUTPUT_INVALID";
      return fail(500, code, `montash produced no JSON output (exit ${String(exitCode)})`, {
        detail: { ...exec, stderr_tail: tail(stderr) },
      });
    }
    try {
      const json = JSON.parse(last) as Record<string, unknown>;
      return { status: 200, body: { ...json, exec } };
    } catch {
      return fail(500, "E_CLI_OUTPUT_INVALID", "montash output was not JSON", {
        detail: { ...exec, stdout_tail: tail(stdout), stderr_tail: tail(stderr) },
      });
    }
  }
}

/** `allowlist` オプション（配列 / 解決済み / 未指定）を解決済みの形にそろえる */
function toResolvedAllowlist(allowlist: CliExecutorOptions["allowlist"]): ResolvedAllowlist {
  if (allowlist === undefined) return resolveAllowlist();
  if (Array.isArray(allowlist)) return resolveAllowlist({ base: allowlist as readonly string[] });
  return allowlist as ResolvedAllowlist;
}

function tail(s: string, n = 20): string[] {
  return s.split("\n").filter(Boolean).slice(-n);
}

function fail(
  status: number,
  code: string,
  message: string,
  extra: { hint?: string; detail?: Record<string, unknown> } = {},
): ExecResult {
  return { status, body: { ok: false, error: { code, message, ...extra } } };
}
