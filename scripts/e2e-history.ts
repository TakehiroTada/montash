/** W-16: real browser → POST /api/cli → persisted HEAD → refreshed UI. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../src/server/index.ts";

const dir = await mkdtemp(join(tmpdir(), "montash-w16-"));
const cliPath = resolve(import.meta.dir, "../src/cli/index.ts");
async function cli(...args: string[]) {
  const proc = Bun.spawn([process.execPath, cliPath, "-C", dir, "--json", ...args], { stdout: "pipe", stderr: "pipe" });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  assert.equal(code, 0, text);
  return JSON.parse(text);
}

await cli("init", dir);
await cli("project", "set", "name", "second-state");
const server = await startServer({
  projectDir: dir,
  host: "127.0.0.1",
  port: 0,
  readOnly: false,
  open: false,
  dev: false,
  watch: "poll",
  log: () => {},
});
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  const headIs = (id: string) =>
    page.waitForFunction((expected) => document.querySelector(".history .mono")?.textContent === expected, id);
  await headIs("o_0002");
  const canvas = page.locator(".history canvas");
  const bounds = await canvas.boundingBox();
  assert.ok(bounds);
  await canvas.click({ position: { x: 24, y: Math.round(bounds.height / 2) } });
  await headIs("o_0001");
  assert.equal((await cli("status")).head.op, "o_0001");
  assert.match(await page.locator("header").innerText(), /montash/);
  await page.keyboard.press("]");
  await headIs("o_0002");
  await page.keyboard.press("[");
  await headIs("o_0001");
  await page.keyboard.press("]");
  await headIs("o_0002");
  await cli("commit", "-m", "browser reviewed");
  await page.waitForFunction(() => !document.querySelector(".history .bar")?.textContent?.includes("pending"));
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page.getByText("k_0001: browser reviewed").first().waitFor();
  await cli("tag", "browser-tag");
  await page.getByText("browser-tag", { exact: true }).waitFor();
  const history = await (await page.request.get(`${server.url}/api/history`)).json();
  assert.equal(history.moves.at(-1).actor, "web");
  assert.deepEqual(errors, []);

  // Refresh after a Web command must also work with file watching disabled.
  const manual = await startServer({
    projectDir: dir,
    host: "127.0.0.1",
    port: 0,
    readOnly: false,
    open: false,
    dev: false,
    watch: false,
    log: () => {},
  });
  try {
    await page.goto(manual.url);
    await headIs("o_0002");
    await page.keyboard.press("[");
    await headIs("o_0001");
    assert.equal((await cli("status")).head.op, "o_0001");
  } finally {
    await manual.stop();
  }
  console.log("W-16: canvas checkout, keyboard undo/redo, commit/tag refresh, actor=web and --no-watch passed");
} finally {
  await browser.close();
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}
