/**
 * `montash serve` — Web プレビューサーバ（docs/04 §13, docs/06 §3.1）
 *
 * フォアグラウンドで動き Ctrl-C で停止する。`--daemon` は未実装（E_NOT_IMPLEMENTED）。
 */
import { readFileSync } from "node:fs";
import { platform } from "node:os";
import { loadedPlugins } from "../../plugins/loader.ts";
import { getCommands } from "../../registry/commands.ts";
import {
  type AllowlistPlugin,
  FORBIDDEN_FLAGS,
  normalizeAllowlistCommand,
  type ResolvedAllowlist,
  resolveAllowlist,
} from "../../server/cli-exec.ts";
import { startServer } from "../../server/index.ts";
import { defineCommand } from "../define-command.ts";
import { errors, type Warning, warning } from "../errors.ts";

interface Args extends Record<string, unknown> {
  port: number;
  host: string;
  open: boolean;
  readOnly: boolean;
  dev: boolean;
  watch: boolean;
  daemon: boolean;
  autoPreview: boolean;
  allow?: (string | number)[];
  deny?: (string | number)[];
}

/**
 * `--allow` / `--deny` の値を正規化して検証する（docs/06 §3.3）。
 *
 * - `--allow a --allow b` の繰り返しと `--allow a,b` のカンマ区切りの両方を受ける
 * - 受け付けるのは **コマンドパス**（`checkout` / `effect set` のように 2 語まで。
 *   `checkAllowlist()` が `args[0]` と `args[0] args[1]` を照合するのに合わせる）
 * - 2 語目がフラグ（`reset --hard`）の場合は 1 語目をコマンドパスとして検証する
 * - 存在しないコマンドやサーバ固定のグローバルオプションは `E_USAGE` で弾く
 */
export async function normalizeAllowlistFlag(values: readonly (string | number)[], flag: string): Promise<string[]> {
  const raw = values
    .flatMap((v) => String(v).split(","))
    .map(normalizeAllowlistCommand)
    .filter((v) => v !== "");
  if (raw.length === 0) return [];
  const paths = new Set((await getCommands()).map((c) => c.path));
  const hint = `Pass a command path of up to 2 words, e.g. ${flag} "effect set". Run \`montash help\` for the list.`;
  const out: string[] = [];
  for (const value of raw) {
    const words = value.split(" ");
    const flagWord = words.length === 2 && words[1]?.startsWith("-") ? words[1] : null;
    if (flagWord !== null && FORBIDDEN_FLAGS.has(flagWord.split("=")[0] ?? flagWord)) {
      throw errors.usage(`${flag} "${value}": ${flagWord} is fixed by the server and cannot be allowed`, hint);
    }
    const path = flagWord !== null ? (words[0] as string) : value;
    if (words.length > 2 || path.startsWith("-") || !paths.has(path)) {
      throw errors.usage(`unknown command for ${flag}: "${value}"`, hint);
    }
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** 読み込み済みプラグインの `webAllow` 宣言 */
function pluginAllowSources(): AllowlistPlugin[] {
  return loadedPlugins()
    .filter((p) => (p.manifest.webAllow?.length ?? 0) > 0)
    .map((p) => ({ id: p.manifest.id, webAllow: p.manifest.webAllow }));
}

/** `serve` の許可リストを組み立てる（既定 + プラグイン + `--allow` − `--deny`） */
export async function buildServeAllowlist(args: Pick<Args, "allow" | "deny">): Promise<ResolvedAllowlist> {
  const allow = await normalizeAllowlistFlag(args.allow ?? [], "--allow");
  const deny = await normalizeAllowlistFlag(args.deny ?? [], "--deny");
  return resolveAllowlist({ plugins: pluginAllowSources(), allow, deny });
}

function isWsl(): boolean {
  if (platform() !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/** OS 既定のブラウザで URL を開く（docs/08 §4.4）。失敗しても serve 自体は続ける */
export async function openBrowser(url: string): Promise<boolean> {
  const candidates: string[][] = [];
  if (platform() === "darwin") candidates.push(["open", url]);
  else if (platform() === "win32") candidates.push(["cmd.exe", "/c", "start", "", url]);
  else if (isWsl()) candidates.push(["wslview", url], ["cmd.exe", "/c", "start", "", url], ["xdg-open", url]);
  else candidates.push(["xdg-open", url]);
  for (const cmd of candidates) {
    try {
      const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      if ((await proc.exited) === 0) return true;
    } catch {
      /* 次の候補へ */
    }
  }
  return false;
}

export const serve = defineCommand<Args>({
  path: "serve",
  summary: "start the local web preview server (Ctrl-C to stop)",
  description:
    "Serves the web UI, read-only APIs and a WebSocket that pushes project.json / history changes. Web actions run `montash` as a child process (MONTASH_ACTOR=web) restricted by an allowlist.",
  workflows: ["W-02", "W-04", "W-16"],
  options: {
    port: { type: "number", describe: "TCP port (0 = random)", default: 7788 },
    host: { type: "string", describe: "bind address. Non-loopback forces --read-only", default: "127.0.0.1" },
    open: { type: "boolean", describe: "open the URL in the default browser", default: false },
    "read-only": { type: "boolean", describe: "disable POST /api/cli (viewing only)", default: false },
    allow: {
      type: "array",
      describe: 'add a command to the web allowlist (repeatable or comma-separated, e.g. --allow "effect set")',
    },
    deny: {
      type: "array",
      describe: "remove a command from the web allowlist; wins over --allow and plugin webAllow",
    },
    dev: {
      type: "boolean",
      describe: "serve web/index.html via Bun's HTML import with HMR instead of web/dist",
      default: false,
    },
    watch: { type: "boolean", describe: "watch project.json and history (use --no-watch to disable)", default: true },
    "auto-preview": {
      type: "boolean",
      describe: "automatically rebuild preview (use --no-auto-preview to disable)",
      default: true,
    },
    daemon: { type: "boolean", describe: "run in the background (not implemented yet)", default: false },
  },
  examples: [
    { cmd: "montash serve --open", note: "start and open the browser" },
    { cmd: "montash serve --port 8080 --read-only" },
    { cmd: 'montash serve --allow "effect set" --deny "reset --hard"', note: "adjust the web allowlist" },
    { cmd: "montash serve --dev", note: "frontend development with HMR" },
  ],
  async handler(ctx, args) {
    if (args.daemon) throw errors.notImplemented("serve --daemon");
    if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)
      throw errors.usage(`invalid --port ${String(args.port)}`, "Use 0-65535.");
    // 許可リストの検証はプロジェクト解決より先（引数の誤りは即 E_USAGE で返す）
    const allowlist = await buildServeAllowlist(args);
    const projectDir = ctx.requireProjectDir();
    const warnings: Warning[] = [];

    const running = await startServer({
      projectDir,
      host: args.host,
      port: args.port,
      readOnly: args.readOnly,
      open: args.open,
      dev: args.dev,
      watch: args.watch ? "auto" : false,
      autoPreview: args.autoPreview,
      cliExec: { allowlist },
      log: (l) => ctx.stderr(`${l}\n`),
    });
    // --read-only は書き込み API そのものを閉じるので、--allow で足した分も実行されない（docs/06 §3.3）
    if (running.readOnly && (args.allow?.length ?? 0) > 0) {
      warnings.push(
        warning("W_ALLOWLIST_IGNORED", "--allow has no effect while the server is read-only", {
          hint: "Drop --read-only (and bind to a loopback host) to let the web UI run commands.",
        }),
      );
    }
    if (running.readOnly && !args.readOnly) {
      warnings.push(
        warning("W_REMOTE_HOST", `--host ${args.host} is not loopback; --read-only was forced`, {
          hint: "Bind to 127.0.0.1 to allow web actions.",
        }),
      );
    }

    const info = {
      url: running.url,
      project_dir: projectDir,
      read_only: running.readOnly,
      dev: args.dev,
      watching: running.watcher !== null,
      watch_mode: running.watcher?.mode ?? null,
      allowlist: allowlist.allowlist,
      allowlist_entries: allowlist.entries,
      allowlist_denied: allowlist.denied,
    };
    if (ctx.globals.json) {
      ctx.stdout(`${JSON.stringify({ type: "listening", ...info })}\n`);
    } else if (!ctx.globals.quiet) {
      ctx.stderr(
        `montash serve — ${running.url}\n  project: ${projectDir}\n  mode: ${args.dev ? "dev (HMR)" : "web/dist"}${running.readOnly ? " · read-only" : ""}${running.watcher ? ` · watching (${running.watcher.mode})` : " · not watching"}\n  Ctrl-C to stop\n`,
      );
    }

    if (args.open) {
      const ok = await openBrowser(running.url);
      if (!ok)
        warnings.push(
          warning("W_OPEN_FAILED", `could not open a browser for ${running.url}`, { hint: "Open the URL manually." }),
        );
    }

    // Ctrl-C / SIGTERM まで待つ
    const signal = await new Promise<string>((res) => {
      const onSig = (s: string) => () => res(s);
      process.once("SIGINT", onSig("SIGINT"));
      process.once("SIGTERM", onSig("SIGTERM"));
    });
    await running.stop();
    if (signal === "SIGINT" && !ctx.globals.json && !ctx.globals.quiet) ctx.stderr("\n");
    return { result: { ...info, stopped_by: signal }, warnings, human: `stopped (${signal})` };
  },
});
