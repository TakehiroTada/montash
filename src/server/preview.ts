/**
 * プレビューの HTTP 配信と自動ビルドのスケジューリング（docs/06 §3.2, §3.4, §3.5）。
 *
 * - `GET /preview/timeline.mp4`（Range 対応、`ETag` = project_hash）と `GET /preview/timeline.json`。
 * - `project.json` の変更をデバウンス（既定 1500ms）してから `montash preview build` を子プロセスで実行する。
 *   ビルド中にさらに変更があれば SIGTERM でキャンセルして最初からやり直す。
 * - `.montash/preview/` は CLI からも書き換わる（人が `montash preview build` を打つ）ので、
 *   状態は定期的に読み直して差分があるときだけ WebSocket に `preview.state` を push する。
 */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { timelineDurationF } from "../core/assets.ts";
import { loadProject, projectPaths } from "../core/project.ts";
import type { Fps } from "../core/schema.ts";
import { readPreviewManifest, readPreviewStatus } from "../ffmpeg/preview.ts";
import { resolveCliCommand } from "./cli-exec.ts";

/** `GET /api/status` の `preview`（web/src/store.ts の StatusLike.preview と同じ形） */
export interface PreviewStatusView {
  state: "missing" | "building" | "ready" | "stale";
  url?: string;
  duration_f?: number;
  fps?: Fps;
  /** 0〜1 */
  progress?: number;
  error?: string;
  hash?: string;
}

/** 状態が変わるたびに再ビルドを予約し、進行中のビルドは打ち切る */
export class PreviewCoordinator {
  private timer?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private child?: ReturnType<typeof Bun.spawn>;
  private running: Promise<void> = Promise.resolve();
  private generation = 0;
  private stopped = false;
  private lastStatus = "";
  private error?: string;
  private polling = false;

  constructor(
    private readonly dir: string,
    private readonly auto: boolean,
    private readonly publish: (event: Record<string, unknown>) => void,
    private readonly log: (line: string) => void,
    private readonly command: string[] = resolveCliCommand(),
  ) {}

  async status(): Promise<PreviewStatusView> {
    try {
      const project = await loadProject(this.dir);
      if (!timelineDurationF(project)) return { state: "missing" };
      const state = await readPreviewStatus(project, this.dir);
      const manifest = state.manifest;
      return {
        state: state.state,
        ...(manifest && state.path
          ? {
              // ?v= はブラウザのキャッシュを跨がせないための版指定（docs/06 §2.2）
              url: `/preview/timeline.mp4?v=${encodeURIComponent(manifest.project_hash)}`,
              duration_f: manifest.duration_f,
              fps: manifest.fps,
              hash: manifest.project_hash,
            }
          : {}),
        ...(state.progress?.percent != null ? { progress: state.progress.percent / 100 } : {}),
        ...(this.error && state.state !== "ready" ? { error: this.error } : {}),
      };
    } catch {
      return { state: "missing", ...(this.error ? { error: this.error } : {}) };
    }
  }

  start(): void {
    // CLI から手で実行されたビルドも観測する（--no-watch や --no-auto-preview でも）
    this.poll = setInterval(() => void this.notify(), 500);
    this.changed();
  }

  private async notify(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const state = await this.status();
      const encoded = JSON.stringify(state);
      if (encoded !== this.lastStatus && !this.stopped) {
        this.lastStatus = encoded;
        this.publish({ type: "preview.state", ...state });
      }
    } finally {
      this.polling = false;
    }
  }

  /** project.json が変わった（または CLI 実行が成功した）ことを伝える */
  changed(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    this.error = undefined;
    this.child?.kill("SIGTERM");
    void this.notify();
    if (!this.auto) return;
    void loadProject(this.dir)
      .then((project) => {
        if (
          this.stopped ||
          generation !== this.generation ||
          !project.settings.preview.auto_build ||
          !timelineDurationF(project)
        )
          return;
        this.timer = setTimeout(() => {
          this.running = this.running.then(async () => {
            if (this.stopped || generation !== this.generation) return;
            await this.build(generation);
          });
        }, project.settings.preview.debounce_ms);
      })
      .catch(() => {});
  }

  private async build(generation: number): Promise<void> {
    try {
      const proc = Bun.spawn([...this.command, "preview", "build", "--json", "-C", this.dir], {
        cwd: this.dir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, MONTASH_ACTOR: "system" },
      });
      this.child = proc;
      const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      // キャンセル（世代が進んだ）ときの非 0 終了は失敗として報告しない
      if (code !== 0 && generation === this.generation && !this.stopped) {
        let message = `preview build failed (exit ${code})`;
        try {
          message = JSON.parse(output.trim().split("\n").at(-1) ?? "").error?.message ?? message;
        } catch {
          /* JSON で無ければ既定の文言 */
        }
        this.error = message;
        this.log(message);
      }
    } catch (error) {
      if (!this.stopped && generation === this.generation) {
        this.error = String(error);
        this.log(this.error);
      }
    } finally {
      this.child = undefined;
      await this.notify();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.child?.kill("SIGTERM");
    await this.running;
  }
}

// ---------------------------------------------------------------------------
// HTTP 配信（docs/06 §3.2）
// ---------------------------------------------------------------------------

/** 配信できるファイル名 → content-type。それ以外は 404（プレビューキャッシュの外は決して読まない） */
const SERVABLE: Record<string, string> = {
  "timeline.mp4": "video/mp4",
  "audio.m4a": "audio/mp4",
};

function rangeNotSatisfiable(headers: Record<string, string>, size: number): Response {
  return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
}

/**
 * `/preview/*` を配信する。`timeline.mp4` は Range（`Bun.file().slice()`）と `ETag`（= project_hash）に対応し、
 * `timeline.json` はマニフェストをそのまま返す。
 */
export async function servePreview(dir: string, req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405 });
  const name = new URL(req.url).pathname.slice("/preview/".length);
  const manifest = await readPreviewManifest(dir);

  if (name === "timeline.json") {
    if (!manifest) return new Response(null, { status: 404 });
    const body = req.method === "HEAD" ? null : JSON.stringify(manifest);
    return new Response(body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        etag: `"${manifest.project_hash}"`,
      },
    });
  }

  const type = SERVABLE[name];
  if (!type || !manifest) return new Response(null, { status: 404 });
  const path = join(projectPaths(dir).previewDir, name);
  // シンボリックリンク経由でキャッシュ外のファイルを読ませない
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return new Response(null, { status: 404 });

  const etag = `"${manifest.project_hash}"`;
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    etag,
    // 版は ?v= で切り替わるので、本体は毎回検証させる
    "cache-control": "no-cache",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  let start = 0;
  let end = info.size - 1;
  let status = 200;
  const range = req.headers.get("range");
  const ifRange = req.headers.get("if-range");
  if (range && req.method !== "HEAD" && (!ifRange || ifRange === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return rangeNotSatisfiable(headers, info.size);
    start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size)
      return rangeNotSatisfiable(headers, info.size);
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
  }
  headers["content-length"] = String(end - start + 1);
  return new Response(req.method === "HEAD" ? null : Bun.file(path).slice(start, end + 1), { status, headers });
}
