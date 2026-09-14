/**
 * Web プレビューサーバ（docs/06 §3, docs/08 §3.4, docs/12 ADR-03）。
 *
 * `Bun.serve({ hostname, port, routes, fetch, websocket })` を組み立てる。
 *   - `/`            開発: web/index.html の HTML import（HMR）／本番: web/dist/index.html を Bun.file で配信
 *   - `/api/*`       読み取り API（project / status / history / cli/allowlist）
 *   - `POST /api/cli` 許可リスト制の CLI 実行（cli-exec.ts）
 *   - `/ws`          WebSocket push（server.publish("events", ...)）
 *   - その他         本番は web/dist の静的ファイル、無ければ 404 JSON
 *
 * この段階では project.json / 履歴ファイルを **そのまま透過** し、duration などの計算値は付けない
 * （project.json の構造は別担当が実装中。docs/06 §3.2 の「計算値」は後続で追加する）。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import pkg from "../../package.json";
import { CliExecutor, resolveCliCommand, type CliExecutorOptions } from "./cli-exec.ts";
import { createWatcher, hashProjectFile, HISTORY_DIR, watchTargets, type WatchMode, type Watcher } from "./watcher.ts";

export const SERVER_VERSION: string = pkg.version;

export interface StartServerOptions {
  projectDir: string;
  host: string;
  port: number;
  readOnly: boolean;
  open: boolean;
  dev: boolean;
  /** 監視モード。false で監視しない（`--no-watch`） */
  watch?: WatchMode | false;
  /** ログ出力先（既定: console.error）。テストでは差し替える */
  log?: (line: string) => void;
  /** テスト用に CliExecutor の設定を上書きする */
  cliExec?: Partial<CliExecutorOptions>;
}

export interface RunningServer {
  server: Bun.Server<undefined>;
  url: string;
  readOnly: boolean;
  watcher: Watcher | null;
  stop(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith("127.");
}

// ---------------------------------------------------------------------------
// レスポンスヘルパ
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const jsonError = (status: number, code: string, message: string, hint?: string): Response =>
  json({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } }, status);

const notFound = (what = "resource"): Response => jsonError(404, "E_NOT_FOUND", `${what} not found`);

/** JSONL を 1 行 1 オブジェクトとして読む。壊れた行は捨てる。無ければ [] */
function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 途中書き込みの行などは無視 */
    }
  }
  return out;
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 本番ビルドの成果物ディレクトリ。開発時は `<repo>/web/dist`、コンパイル済みバイナリでは
 * バイナリと同じ場所の `web/dist` を探す（埋め込みは未対応。docs/13 B-2）。
 */
export function resolveDistDir(): string | null {
  const candidates = [resolve(import.meta.dir, "../../web/dist"), resolve(dirname(process.execPath), "web/dist"), resolve(process.cwd(), "web/dist")];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return null;
}

/** コンパイル済み単一バイナリで動いているか（src/cli/index.ts がディスク上に無い） */
export function isCompiledBinary(): boolean {
  return resolveCliCommand().length === 1;
}

/** dist 配下の静的ファイル。ディレクトリトラバーサルを拒否する */
function serveStatic(distDir: string, pathname: string): Response | null {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return null;
  const abs = resolve(distDir, rel);
  if (!abs.startsWith(distDir + sep)) return null;
  if (!existsSync(abs)) return null;
  const file = Bun.file(abs);
  // ハッシュ付きファイル名は長期キャッシュ可
  const immutable = /-[a-z0-9]{8,}\.(js|css|woff2?|png|svg|map)$/i.test(rel);
  return new Response(file, { headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const projectDir = resolve(opts.projectDir);
  const targets = watchTargets(projectDir);

  // docs/13 A-7: loopback 以外で listen するときは書き込みを強制的に無効化する
  let readOnly = opts.readOnly;
  if (!isLoopback(opts.host)) {
    log(`warning [W_REMOTE_HOST]: listening on ${opts.host} exposes this project to the network; forcing --read-only`);
    readOnly = true;
  }

  const executor = new CliExecutor({ projectDir, ...opts.cliExec });

  const status = () => ({
    watching: watcher !== null,
    watch_mode: watcher?.mode ?? null,
    head: null,
    preview: { state: "missing" as const },
    server: { version: SERVER_VERSION, read_only: readOnly, dev: opts.dev, compiled: isCompiledBinary(), project_dir: projectDir },
  });

  const routes: Bun.Serve.RoutesWithUpgrade<undefined, string> = {
    "/api/project": {
      GET: () => {
        const p = readJsonFile(targets.project);
        if (p === undefined) return notFound("project.json");
        return json(p, 200, { etag: hashProjectFile(targets.project) ?? "" });
      },
    },
    "/api/status": { GET: () => json(status()) },
    "/api/history": {
      GET: () => {
        const tags = readJsonFile(join(projectDir, HISTORY_DIR, "tags.json"));
        return json({
          head: null,
          ops: readJsonl(targets.ops),
          commits: readJsonl(join(projectDir, HISTORY_DIR, "commits.jsonl")),
          tags: typeof tags === "object" && tags !== null ? tags : {},
          moves: readJsonl(targets.moves),
        });
      },
    },
    "/api/cli/allowlist": { GET: () => json({ allowlist: executor.allowlist, read_only: readOnly }) },
    "/api/cli": {
      POST: async (req, server) => {
        if (readOnly) return jsonError(405, "E_READ_ONLY", "server is running with --read-only", "Restart `montash serve` without --read-only (and on a loopback host).");
        let payload: unknown;
        try {
          payload = await req.json();
        } catch {
          return jsonError(400, "E_USAGE", "request body must be JSON");
        }
        const ua = req.headers.get("user-agent") ?? "unknown";
        const detail = `${ua.slice(0, 60)}#${Math.random().toString(36).slice(2, 8)}`;
        const res = await executor.handle(payload, detail);
        const args = (payload as { args?: unknown }).args;
        server.publish(
          "events",
          JSON.stringify({ type: "log", level: res.body.ok ? "info" : "error", actor: "web", message: `${Array.isArray(args) ? args.join(" ") : "?"} → ${res.body.ok ? "ok" : String((res.body.error as { code?: string } | undefined)?.code ?? "error")}` }),
        );
        return json(res.body, res.status);
      },
    },
    "/ws": (req, server) => {
      if (server.upgrade(req)) return undefined;
      return jsonError(400, "E_WS_UPGRADE_FAILED", "websocket upgrade failed");
    },
  };

  // ルート: 開発は HTML import（Bun がバンドル・HMR）、本番は web/dist。
  // コンパイル済み単一バイナリでは web/dist がディスク上に無いので、compile 時に埋め込まれた HTML import を使う
  // （`bun build --compile` は静的な import("*.html") をバンドルして埋め込む。docs/13 B-2 で確認）。
  let distDir: string | null = null;
  if (opts.dev || (isCompiledBinary() && resolveDistDir() === null)) {
    const mod = await import("../../web/index.html");
    routes["/"] = mod.default;
  } else {
    distDir = resolveDistDir();
    routes["/"] = () => {
      const dir = distDir ?? resolveDistDir();
      if (!dir) {
        return new Response("web/dist/index.html not found. Run `bun run build:web` first (or start with `montash serve --dev`).", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      distDir = dir;
      return new Response(Bun.file(join(dir, "index.html")), { headers: { "cache-control": "no-cache" } });
    };
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    development: opts.dev ? { hmr: true, console: true } : false,
    routes,
    fetch(req) {
      const url = new URL(req.url);
      if (!opts.dev) {
        const dir = distDir ?? resolveDistDir();
        if (dir) {
          const r = serveStatic(dir, url.pathname);
          if (r) return r;
        }
      }
      if (url.pathname.startsWith("/api/")) return notFound(`API ${url.pathname}`);
      return notFound(url.pathname);
    },
    websocket: {
      open(ws) {
        ws.subscribe("events");
        ws.send(JSON.stringify({ type: "hello", version: SERVER_VERSION, read_only: readOnly }));
      },
      message() {
        /* クライアント → サーバの送信は使わない（push のみ。docs/06 §3.4） */
      },
    },
  });

  const publish = (msg: Record<string, unknown>) => server.publish("events", JSON.stringify(msg));

  // 監視: project.json → project.changed、ops/moves → history.appended / history.moved
  let watcher: Watcher | null = null;
  if (opts.watch !== false) {
    watcher = await createWatcher({
      projectDir,
      mode: opts.watch ?? "auto",
      onEvent(ev) {
        if (ev.target === "project") {
          publish({ type: "project.changed", hash: hashProjectFile(targets.project), head: null, cause: "external" });
        } else if (ev.target === "ops") {
          publish({ type: "history.appended", ops: [], commits: [] });
        } else {
          publish({ type: "history.moved", from: null, to: null, actor: null });
        }
      },
    });
  }

  const url = `http://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${server.port}`;
  return {
    server,
    url,
    readOnly,
    watcher,
    async stop() {
      await watcher?.close();
      await server.stop(true);
    },
  };
}
