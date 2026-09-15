/** サーバテスト共通: 一時プロジェクトディレクトリと起動ヘルパ */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningServer, type StartServerOptions, startServer } from "../../../src/server/index.ts";

export const SAMPLE_PROJECT = {
  schema_version: 2,
  name: "test-project",
  settings: { fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 } },
  assets: {},
  tracks: [
    {
      id: "V1",
      kind: "video",
      name: "V1",
      clips: [{ id: "c1", type: "media", asset: "a", start_f: 0, in_f: 0, out_f: 90, speed: 1 }],
    },
  ],
};

export function makeTempProject(withProjectJson = true): string {
  const dir = mkdtempSync(join(tmpdir(), "montash-srv-"));
  if (withProjectJson) writeFileSync(join(dir, "project.json"), JSON.stringify(SAMPLE_PROJECT));
  mkdirSync(join(dir, ".montash", "history"), { recursive: true });
  return dir;
}

export function removeTemp(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export async function boot(projectDir: string, over: Partial<StartServerOptions> = {}): Promise<RunningServer> {
  return startServer({
    projectDir,
    host: "127.0.0.1",
    port: 0,
    readOnly: false,
    open: false,
    dev: false,
    watch: false,
    autoPreview: false,
    log: () => {},
    ...over,
  });
}

/** WebSocket を開き、hello 受信までの Promise と、次に来るメッセージを type で待つ関数を返す */
export async function openWs(url: string): Promise<{
  ws: WebSocket;
  hello: Record<string, unknown>;
  next(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}> {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`);
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<{ type: string; res: (m: Record<string, unknown>) => void }> = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.res(msg);
    else queue.push(msg);
  };
  const next = (type: string, timeoutMs = 3000): Promise<Record<string, unknown>> => {
    const qi = queue.findIndex((m) => m.type === type);
    if (qi >= 0) return Promise.resolve(queue.splice(qi, 1)[0]!);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting for ws message "${type}"`)), timeoutMs);
      waiters.push({
        type,
        res: (m) => {
          clearTimeout(t);
          res(m);
        },
      });
    });
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(e);
  });
  const hello = await next("hello");
  return { ws, hello, next };
}
