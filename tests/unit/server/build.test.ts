import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { boot, makeTempProject, removeTemp } from "./helpers.ts";

const root = resolve(import.meta.dir, "../../..");

test("bun run build:web produces web/dist/index.html and the server serves it", async () => {
  const proc = Bun.spawn([process.execPath, "run", "build:web"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => proc.kill(), 10_000);
  const code = await proc.exited;
  clearTimeout(timeout);
  if (code !== 0) console.error(await new Response(proc.stderr).text());
  expect(code).toBe(0);
  const index = resolve(root, "web/dist/index.html");
  expect(existsSync(index)).toBe(true);
  const html = readFileSync(index, "utf8");
  expect(html).toContain('<div id="root">');
  const js = html.match(/src="\.?\/?([^"]+\.js)"/)?.[1];
  const css = html.match(/href="\.?\/?([^"]+\.css)"/)?.[1];
  expect(js).toBeDefined();
  expect(css).toBeDefined();

  // 本番モードのサーバが dist を Bun.file で配信する（Content-Type は Bun.file の type）
  const dir = makeTempProject();
  const srv = await boot(dir);
  try {
    const page = await fetch(`${srv.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const jsRes = await fetch(`${srv.url}/${js}`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toContain("javascript");
    expect(jsRes.headers.get("cache-control")).toContain("immutable");
    const cssRes = await fetch(`${srv.url}/${css}`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toContain("text/css");
    // dist 外へのトラバーサルは 404
    expect((await fetch(`${srv.url}/..%2Fpackage.json`)).status).toBe(404);
  } finally {
    await srv.stop();
    removeTemp(dir);
  }
}, 30_000);
