/**
 * W-04（docs/03）のサーバ／ブラウザ側:
 *   自動プレビュー生成 → `/preview/*` の Range 配信 → 編集による再生成 → `--no-auto-preview`。
 *
 * ブラウザ検証（実再生・再生位置の保持）は chromium がインストールされているときだけ実行する
 * （`bunx playwright install chromium`）。CLI だけの検証は tests/workflows/W-04.sh 側にある。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureFixtures } from "../src/ffmpeg/fixtures.ts";
import { locateBinaries } from "../src/ffmpeg/locate.ts";
import { type RunningServer, startServer } from "../src/server/index.ts";

const dir = await mkdtemp(join(tmpdir(), "montash-w04-"));
const cliPath = resolve(import.meta.dir, "../src/cli/index.ts");
async function cli(...args: string[]) {
  const proc = Bun.spawn([process.execPath, cliPath, "-C", dir, "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  assert.equal(code, 0, `${args.join(" ")}\n${text}\n${stderr}`);
  return JSON.parse(text);
}
async function until<T>(what: string, probe: () => Promise<T | null>, timeoutMs = 90000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const fixtures = await ensureFixtures(locateBinaries());
await cli("init", dir, "--resolution", "640x360");
await cli("import", fixtures.a!);
// 90 フレーム = 3 秒
await cli("clip", "add", "--asset", "a", "--in", "f:0", "--duration", "f:90");

const boot = (over: Record<string, unknown> = {}): Promise<RunningServer> =>
  startServer({
    projectDir: dir,
    host: "127.0.0.1",
    port: 0,
    readOnly: false,
    open: false,
    dev: false,
    watch: "poll",
    log: () => {},
    ...over,
  });

const previewOf = async (server: RunningServer) =>
  (await (await fetch(`${server.url}/api/status`)).json()).preview as {
    state: string;
    url?: string;
    duration_f?: number;
    fps?: { num: number; den: number };
    progress?: number;
    error?: string;
  };

let server = await boot();
try {
  // 1. serve 起動 → デバウンス後に自動ビルド → /api/status が docs/06 §3.2 の形で ready になる
  const ready = await until("the first automatic preview build", async () => {
    const preview = await previewOf(server);
    return preview.state === "ready" ? preview : null;
  });
  assert.equal(ready.duration_f, 90);
  assert.deepEqual(ready.fps, { num: 30, den: 1 });
  assert.match(ready.url ?? "", /^\/preview\/timeline\.mp4\?v=sha1/);

  // 2. Range 配信と ETag（= project_hash）
  const full = await fetch(`${server.url}${ready.url}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  const etag = full.headers.get("etag")!;
  assert.match(etag, /^"sha1:[0-9a-f]{40}"$/);
  const size = Number(full.headers.get("content-length"));
  assert.ok(size > 0);
  await full.body?.cancel();
  const ranged = await fetch(`${server.url}${ready.url}`, { headers: { range: "bytes=0-99" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 0-99/${size}`);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${server.url}${ready.url}`, { headers: { "if-none-match": etag } })).status, 304);

  // 3. マニフェスト（docs/05 §12）
  const manifest = await (await fetch(`${server.url}/preview/timeline.json`)).json();
  assert.equal(manifest.duration_f, 90);
  assert.equal(manifest.audio.path, "audio.m4a");
  assert.ok(manifest.video_segments.length >= 1, "manifest lists cached video segments");
  assert.equal(`"${manifest.project_hash}"`, etag, "ETag is the project hash");

  // 4. 編集 → デバウンス後に自動再ビルド（新しい版が配信される）
  await cli("project", "set", "name", "w04-edited");
  const rebuilt = await until("the automatic rebuild after an edit", async () => {
    const preview = await previewOf(server);
    return preview.state === "ready" && preview.url !== ready.url ? preview : null;
  });
  assert.ok(rebuilt.url);
  assert.equal((await fetch(`${server.url}${rebuilt.url}`, { headers: { range: "bytes=0-9" } })).status, 206);

  // 5. ブラウザでの実再生（chromium があるときだけ）
  let chromium: typeof import("playwright").chromium | null = null;
  try {
    ({ chromium } = await import("playwright"));
    chromium.executablePath();
  } catch {
    chromium = null;
  }
  if (chromium && (await Bun.file(resolve(import.meta.dir, "../web/dist/index.html")).exists())) {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(server.url);
      await page.waitForFunction(
        () => {
          const video = document.querySelector("video");
          return video && video.readyState >= 2 && Math.abs(video.duration - 3) < 0.15;
        },
        undefined,
        { timeout: 60000 },
      );
      await page.getByRole("button", { name: "play", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("video")!.currentTime > 0.15, undefined, {
        timeout: 15000,
      });
      await page.getByRole("button", { name: "pause", exact: true }).click();
      const at = await page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
      await cli("project", "set", "name", "w04-browser");
      await page.waitForFunction(
        async (old) => {
          const preview = (await (await fetch("/api/status")).json()).preview;
          return preview.state === "ready" && preview.url !== old;
        },
        rebuilt.url,
        { timeout: 90000 },
      );
      const after = await page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
      assert.ok(Math.abs(after - at) < 0.25, `regeneration keeps the transport position (${at} → ${after})`);
      assert.deepEqual(errors, []);
      console.log("W-04 browser: playback and position-preserving regeneration passed");
    } finally {
      await browser.close();
    }
  } else {
    console.log("W-04 browser: skipped (run `bun run build:web` and `bunx playwright install chromium`)");
  }

  // 6. --no-auto-preview では自動生成しない（外部で作られたプレビューは観測する）
  await server.stop();
  server = await boot({ autoPreview: false });
  await cli("project", "set", "name", "w04-manual");
  await Bun.sleep(2500);
  assert.equal((await previewOf(server)).state, "stale", "--no-auto-preview leaves the rebuild to the operator");
  await cli("preview", "build");
  await until("the manually built preview", async () => ((await previewOf(server)).state === "ready" ? true : null));

  console.log("W-04 server: auto build, range delivery, manifest, rebuild and --no-auto-preview passed");
} finally {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}
