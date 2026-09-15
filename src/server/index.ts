/**
 * Web プレビューサーバ（docs/06 §3, docs/08 §3.4, docs/12 ADR-03）。
 *
 * `Bun.serve({ hostname, port, routes, fetch, websocket })` を組み立てる。
 *   - `/`            開発: web/index.html の HTML import（HMR）／本番: web/dist/index.html を Bun.file で配信
 *   - `/api/*`       読み取り API（project / status / history / history/:id / history/diff / blame /
 *                    assets / specs / cli/allowlist）
 *   - `POST /api/cli` 許可リスト制の CLI 実行（cli-exec.ts）
 *   - `POST /api/upload` multipart 保存 → `import <path> --proxy`（assets.ts）
 *   - `/ws`          WebSocket push（server.publish("events", ...)）
 *   - その他         本番は web/dist の静的ファイル、無ければ 404 JSON
 *
 * project.json は透過し、履歴は HEAD / コミット所属 / pending / 分岐状態を解決して返す。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import pkg from "../../package.json";
import {
  assetsSnapshot,
  diffAssets,
  handleAssetDerived,
  handleAssetFile,
  handleAssetList,
  handleAssetProxy,
  handleAssetShow,
  hasAssetChanges,
  MAX_UPLOAD_BYTES,
  saveUpload,
  UPLOAD_OVERHEAD_BYTES,
} from "./assets.ts";
import { CliExecutor, type CliExecutorOptions, type ExecResult, resolveCliCommand } from "./cli-exec.ts";
import { computeProject, type SubtitleReader } from "./computed.ts";
import { readHistoryView } from "./history.ts";
import { type HistoryHttpDeps, handleBlame, handleHistoryDiff, handleHistoryShow } from "./history-api.ts";
import { PreviewCoordinator, servePreview } from "./preview.ts";
import { collectSpecs, type SpecsResponse } from "./specs.ts";
import { createWatcher, hashProjectFile, type Watcher, type WatchMode, watchTargets } from "./watcher.ts";

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
  autoPreview?: boolean;
  /** ログ出力先（既定: console.error）。テストでは差し替える */
  log?: (line: string) => void;
  /** CliExecutor の設定を上書きする（`serve` は合成済みの許可リストをここで渡す。テストでも使う） */
  cliExec?: Partial<CliExecutorOptions>;
  /** `POST /api/upload` の上限バイト数（既定 2GB。docs/13 A-5、`serve --max-upload`） */
  maxUploadBytes?: number;
  /** loopback 以外の `--host` でも書き込みを許す（docs/13 A-7、`serve --allow-remote-write`） */
  allowRemoteWrite?: boolean;
}

export interface RunningServer {
  server: Bun.Server<undefined>;
  url: string;
  readOnly: boolean;
  /** 実際に使う `POST /api/upload` の上限バイト数 */
  maxUploadBytes: number;
  watcher: Watcher | null;
  stop(): Promise<void>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || host.startsWith("127.");
}

/** 書き込み（`POST /api/cli` / `POST /api/upload`）を許すかの判定結果 */
export interface WriteAccess {
  readOnly: boolean;
  /** 起動ログに出す警告（無ければ null） */
  warning: { code: "W_REMOTE_HOST" | "W_REMOTE_WRITE"; message: string; hint: string } | null;
}

/**
 * docs/13 A-7: Web の `import <任意パス>` はローカルのどのファイルでも読めるので、
 * loopback 以外で listen するときは書き込みを止める（= 閲覧のみ）。
 *
 * 単一ユーザー・localhost 前提という設計はそのままに、LAN 公開を選んだときの既定を安全側に倒す。
 * 明示的に `--allow-remote-write` を渡したときだけ解除し、そのときは何が露出するかを警告する。
 */
export function resolveWriteAccess(host: string, readOnly: boolean, allowRemoteWrite = false): WriteAccess {
  if (isLoopback(host)) return { readOnly, warning: null };
  if (!allowRemoteWrite) {
    return {
      readOnly: true,
      warning: {
        code: "W_REMOTE_HOST",
        message: `listening on ${host} exposes this project to the network; forcing --read-only`,
        hint: "Bind to 127.0.0.1, or pass --allow-remote-write if you really want writes from the network.",
      },
    };
  }
  return {
    readOnly,
    warning: {
      code: "W_REMOTE_WRITE",
      message: `--allow-remote-write: anyone who can reach ${host} can run allowlisted commands, and \`import <path>\` reads any file this user can read`,
      hint: "Only use this on a trusted network, and prefer --host 127.0.0.1 with an SSH tunnel.",
    },
  };
}

// ---------------------------------------------------------------------------
// レスポンスヘルパ
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

const jsonError = (status: number, code: string, message: string, hint?: string): Response =>
  json({ ok: false, error: { code, message, ...(hint ? { hint } : {}) } }, status);

const notFound = (what = "resource"): Response => jsonError(404, "E_NOT_FOUND", `${what} not found`);

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
  const candidates = [
    resolve(import.meta.dir, "../../web/dist"),
    resolve(dirname(process.execPath), "web/dist"),
    resolve(process.cwd(), "web/dist"),
  ];
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
  return new Response(file, {
    headers: { "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" },
  });
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((l: string) => console.error(l));
  const projectDir = resolve(opts.projectDir);
  const targets = watchTargets(projectDir);

  // docs/13 A-7: loopback 以外で listen するときは書き込みを既定で無効化する（`--allow-remote-write` で解除）
  const access = resolveWriteAccess(opts.host, opts.readOnly, opts.allowRemoteWrite);
  const readOnly = access.readOnly;
  if (access.warning) log(`warning [${access.warning.code}]: ${access.warning.message}`);

  const executor = new CliExecutor({ projectDir, ...opts.cliExec });
  const maxUploadBytes = opts.maxUploadBytes ?? MAX_UPLOAD_BYTES;

  const send = (msg: Record<string, unknown>) => server.publish("events", JSON.stringify(msg));

  // --- assets.changed（docs/06 §3.4）: project.json の assets キーの差分で判定する ---
  let assetsSnap = assetsSnapshot(readJsonFile(targets.project) as { assets?: Record<string, unknown> } | undefined);
  const publishAssetsChanged = () => {
    const next = assetsSnapshot(readJsonFile(targets.project) as { assets?: Record<string, unknown> } | undefined);
    const diff = diffAssets(assetsSnap, next);
    assetsSnap = next;
    if (hasAssetChanges(diff)) send({ type: "assets.changed", ...diff });
  };

  // --- 長時間コマンドはジョブとして進捗を push する（docs/06 §3.3, §3.4） ---
  const LONG_RUNNING: Record<string, "import" | "proxy"> = { import: "import", "proxy build": "proxy" };
  let jobSeq = 0;
  const jobKind = (args: readonly string[]): "import" | "proxy" | null =>
    LONG_RUNNING[`${args[0]} ${args[1]}`] ?? LONG_RUNNING[String(args[0])] ?? null;

  /** 書き込み系（`POST /api/cli` / `POST /api/upload`）は --read-only で 405（docs/06 §3.1） */
  const requireWritable = (): Response | null =>
    readOnly
      ? jsonError(
          405,
          "E_READ_ONLY",
          "server is running with --read-only",
          "Restart `montash serve` without --read-only (and on a loopback host).",
        )
      : null;

  /** 履歴に残すクライアント識別子（UA + 乱数。docs/06 §3.3） */
  const clientDetail = (req: Request): string =>
    `${(req.headers.get("user-agent") ?? "unknown").slice(0, 60)}#${Math.random().toString(36).slice(2, 8)}`;

  const tooLarge = (bytes: number): Response =>
    jsonError(
      413,
      "E_UPLOAD_TOO_LARGE",
      `upload is ${bytes} bytes; the limit is ${maxUploadBytes} bytes`,
      "Import the file by path instead: `montash import <path> --proxy` (the web UI's 「+ 取り込み」 accepts a path).",
    );

  const assetsDeps = { projectDir, json, jsonError };
  const historyDeps: HistoryHttpDeps = { projectDir, json, jsonError };

  // 字幕クリップの尺は素材ファイルにしか無い。mtime をキーに読み取りを覚えておく（docs/13 D-1）
  const subtitleCache = new Map<string, { mtimeMs: number; source: string }>();
  /** `project` の `assets` に載っている素材だけを読む（`/api/assets/:id/file` と同じ範囲） */
  const subtitleReader =
    (project: unknown): SubtitleReader =>
    (assetId) => {
      const assets = (project as { assets?: Record<string, { path?: unknown }> } | null)?.assets;
      const path = assets?.[assetId]?.path;
      if (typeof path !== "string" || path === "") return null;
      const full = isAbsolute(path) ? path : resolve(projectDir, path);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        return null;
      }
      const hit = subtitleCache.get(full);
      if (hit && hit.mtimeMs === mtimeMs) return hit.source;
      try {
        const source = readFileSync(full, "utf8");
        subtitleCache.set(full, { mtimeMs, source });
        return source;
      } catch {
        return null;
      }
    };

  /** CLI を実行し、ログ・ジョブ・素材差分の push までを行う（`/api/cli` と `/api/upload` が共有する） */
  const runCli = async (
    payload: { args: string[]; confirm?: boolean },
    detail: string,
    job?: { id: string; kind: "import" | "proxy" | "upload" },
  ): Promise<ExecResult> => {
    const kind = job?.kind ?? jobKind(payload.args);
    const jobId = job?.id ?? (kind ? `j_${++jobSeq}` : null);
    if (kind && jobId && !job)
      send({ type: "job.progress", job_id: jobId, kind, percent: 0, message: payload.args.join(" ") });
    const res = await executor.handle(payload, detail);
    send({
      type: "log",
      level: res.body.ok ? "info" : "error",
      actor: "web",
      message: `${payload.args.join(" ")} → ${res.body.ok ? "ok" : String((res.body.error as { code?: string } | undefined)?.code ?? "error")}`,
    });
    if (kind && jobId)
      send({ type: "job.done", job_id: jobId, kind, ok: res.body.ok === true, result: res.body.result ?? null });
    if (res.body.ok) {
      preview.changed();
      publishAssetsChanged();
    }
    return res;
  };

  const preview = new PreviewCoordinator(
    projectDir,
    opts.autoPreview !== false,
    (msg) => server.publish("events", JSON.stringify(msg)),
    log,
  );

  let specsCache: SpecsResponse | null = null;
  const specs = async (): Promise<SpecsResponse> => {
    specsCache ??= await collectSpecs(SERVER_VERSION);
    return specsCache;
  };

  const status = async () => ({
    watching: watcher !== null,
    watch_mode: watcher?.mode ?? null,
    head: readHistoryView(projectDir, readJsonFile(targets.project)).state,
    preview: await preview.status(),
    server: {
      version: SERVER_VERSION,
      read_only: readOnly,
      dev: opts.dev,
      compiled: isCompiledBinary(),
      project_dir: projectDir,
      max_upload_bytes: maxUploadBytes,
    },
  });

  const routes: Bun.Serve.RoutesWithUpgrade<undefined, string> = {
    "/api/project": {
      GET: () => {
        const p = readJsonFile(targets.project);
        if (p === undefined) return notFound("project.json");
        // project.json は透過しつつ、描画に要る派生値（start_f / end_f / duration_f）を添える。
        // クリップ種別ごとに長さの持ち方が違うので、算出はここ 1 箇所に寄せる（docs/13 D-1）
        const body =
          typeof p === "object" && p !== null && !Array.isArray(p)
            ? { ...p, computed: computeProject(p, subtitleReader(p)) }
            : p;
        return json(body, 200, { etag: hashProjectFile(targets.project) ?? "" });
      },
    },
    "/api/status": { GET: async () => json(await status()) },
    "/api/history": {
      GET: () => {
        return json(readHistoryView(projectDir).history);
      },
    },
    // 履歴の読み取り（docs/06 §3.2, docs/13 D-10）。CLI の show / diff / blame と同じ結果を返す。
    // `/api/history/diff` は静的ルートなので `/api/history/:id` より先に一致する（Bun のルータの規則）
    "/api/history/diff": { GET: (req) => handleHistoryDiff(historyDeps, new URL(req.url)) },
    "/api/history/:id": {
      GET: (req) => handleHistoryShow(historyDeps, String(req.params.id ?? ""), new URL(req.url)),
    },
    "/api/blame/:elementId": {
      GET: (req) => handleBlame(historyDeps, String(req.params.elementId ?? ""), new URL(req.url)),
    },
    // コマンド定義 + エフェクトのパラメータ定義（docs/06 §3.2, §3.6）。Inspector のフォームはこれで組む。
    // 起動中は不変（プラグインのロードは起動時に済んでいる）なので 1 度だけ組み立てて使い回す
    "/api/specs": { GET: async () => json(await specs()) },
    // `allowlist` は従来どおりの文字列配列。`entries` / `denied` は合成の内訳（docs/06 §3.3）
    "/api/cli/allowlist": {
      GET: () =>
        json({
          allowlist: executor.allowlist,
          entries: executor.allowlistDetail.entries,
          denied: executor.allowlistDetail.denied,
          read_only: readOnly,
        }),
    },
    "/api/cli": {
      POST: async (req) => {
        const denied = requireWritable();
        if (denied) return denied;
        let payload: unknown;
        try {
          payload = await req.json();
        } catch {
          return jsonError(400, "E_USAGE", "request body must be JSON");
        }
        const body = (payload ?? {}) as { args?: unknown; confirm?: unknown };
        // 検証（args が string[] か）は CliExecutor に任せる。ここでは push 用に取り出すだけ。
        const args = Array.isArray(body.args) && body.args.every((a) => typeof a === "string") ? body.args : null;
        if (args === null) return json((await executor.handle(payload, clientDetail(req))).body, 400);
        const res = await runCli({ args, confirm: body.confirm === true }, clientDetail(req));
        return json(res.body, res.status);
      },
    },
    "/api/assets": { GET: () => handleAssetList(assetsDeps) },
    "/api/assets/:id": { GET: (req) => handleAssetShow(assetsDeps, String(req.params.id ?? "")) },
    "/api/assets/:id/file": { GET: (req) => handleAssetFile(assetsDeps, String(req.params.id ?? ""), req) },
    "/api/assets/:id/proxy.mp4": { GET: (req) => handleAssetProxy(assetsDeps, String(req.params.id ?? ""), req) },
    // 派生物（docs/05 §12、docs/06 §3.2）。生成していなければ 404
    "/api/assets/:id/thumbs.json": {
      GET: (req) => handleAssetDerived(assetsDeps, String(req.params.id ?? ""), "thumbs.json", req),
    },
    "/api/assets/:id/thumbs.jpg": {
      GET: (req) => handleAssetDerived(assetsDeps, String(req.params.id ?? ""), "thumbs.jpg", req),
    },
    "/api/assets/:id/waveform.json": {
      GET: (req) => handleAssetDerived(assetsDeps, String(req.params.id ?? ""), "waveform.json", req),
    },
    "/api/upload": {
      POST: async (req) => {
        const denied = requireWritable();
        if (denied) return denied;
        const declared = Number(req.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > maxUploadBytes) return tooLarge(declared);
        let form: FormData;
        try {
          form = await req.formData();
        } catch (e) {
          return jsonError(400, "E_USAGE", `multipart/form-data expected: ${String(e)}`);
        }
        const file = form.get("file");
        if (!(file instanceof File) || file.name === "")
          return jsonError(400, "E_USAGE", 'multipart field "file" (with a filename) is required');
        if (file.size > maxUploadBytes) return tooLarge(file.size);

        const jobId = `j_${++jobSeq}`;
        send({ type: "job.progress", job_id: jobId, kind: "upload", percent: 0, message: file.name });
        let saved: Awaited<ReturnType<typeof saveUpload>>;
        try {
          saved = await saveUpload(projectDir, file);
        } catch (e) {
          send({ type: "job.done", job_id: jobId, kind: "upload", ok: false, result: null });
          return jsonError(500, "E_IO", `cannot save the upload: ${String(e)}`);
        }
        send({
          type: "job.progress",
          job_id: jobId,
          kind: "upload",
          percent: 50,
          message: `importing ${saved.relative}`,
        });
        // 保存したら登録は CLI に任せる（docs/06 §1.1: Web の状態変更は必ずコマンド発行）
        const res = await runCli({ args: ["import", saved.path, "--proxy"] }, clientDetail(req), {
          id: jobId,
          kind: "upload",
        });
        return json({ ...res.body, upload: saved }, res.status);
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
        return new Response(
          "web/dist/index.html not found. Run `bun run build:web` first (or start with `montash serve --dev`).",
          { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
        );
      }
      distDir = dir;
      return new Response(Bun.file(join(dir, "index.html")), { headers: { "cache-control": "no-cache" } });
    };
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    // Bun の既定（128MB）では 2GB のアップロードが通らない。上限ちょうどにすると本文を読む前に
    // 素の 413 になるので、multipart の枠のぶんだけ広げて `E_UPLOAD_TOO_LARGE` を返せるようにする
    maxRequestBodySize: maxUploadBytes + UPLOAD_OVERHEAD_BYTES,
    development: opts.dev ? { hmr: true, console: true } : false,
    routes,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/preview/")) return servePreview(projectDir, req);
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
          preview.changed();
          publishAssetsChanged();
          publish({
            type: "project.changed",
            hash: hashProjectFile(targets.project),
            head: readHistoryView(projectDir).state,
            cause: "external",
          });
        } else {
          const view = readHistoryView(projectDir);
          if (ev.target === "moves" || ev.target === "head") {
            const lastMove = view.history.moves.at(-1);
            const move = lastMove?.to === view.history.head ? lastMove : undefined;
            publish({
              type: "history.moved",
              from: move?.from ?? null,
              to: view.history.head,
              actor: move?.actor ?? null,
            });
          } else {
            publish({ type: "history.appended", ops: view.history.ops, commits: view.history.commits });
          }
        }
      },
    });
  }

  preview.start();

  const url = `http://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${server.port}`;
  return {
    server,
    url,
    readOnly,
    maxUploadBytes,
    watcher,
    async stop() {
      await watcher?.close();
      await preview.stop();
      await server.stop(true);
    },
  };
}
