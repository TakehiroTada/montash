/**
 * loopback 以外の `--host` での書き込み（docs/13 A-7）と、アップロード上限（docs/13 A-5）。
 *
 * - `--host` が loopback でなければ `--read-only` を強制する。`--allow-remote-write` で解除できる
 * - `POST /api/upload` の上限は起動時に決まり、`serve --max-upload <size>` で変えられる
 */
import { afterEach, describe, expect, test } from "bun:test";
import { MAX_UPLOAD_BYTES, parseUploadLimit } from "../../../src/server/assets.ts";
import { type RunningServer, resolveWriteAccess } from "../../../src/server/index.ts";
import { boot, makeTempProject, removeTemp } from "./helpers.ts";

let dir: string | undefined;
let srv: RunningServer | undefined;

afterEach(async () => {
  await srv?.stop();
  srv = undefined;
  if (dir) removeTemp(dir);
  dir = undefined;
});

/** 0.0.0.0 で listen していても、テストからは loopback 経由で叩く */
const local = (s: RunningServer): string => `http://127.0.0.1:${s.server.port}`;

const postCli = (base: string, args: string[]): Promise<Response> =>
  fetch(`${base}/api/cli`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });

describe("resolveWriteAccess (docs/13 A-7)", () => {
  test("loopback hosts keep whatever --read-only said", () => {
    expect(resolveWriteAccess("127.0.0.1", false)).toEqual({ readOnly: false, warning: null });
    expect(resolveWriteAccess("localhost", true)).toEqual({ readOnly: true, warning: null });
    expect(resolveWriteAccess("::1", false, true)).toEqual({ readOnly: false, warning: null });
  });

  test("non-loopback forces read-only and warns W_REMOTE_HOST", () => {
    const access = resolveWriteAccess("0.0.0.0", false);
    expect(access.readOnly).toBe(true);
    expect(access.warning).toMatchObject({ code: "W_REMOTE_HOST" });
    expect(access.warning?.hint).toContain("--allow-remote-write");
  });

  test("--allow-remote-write lifts the forcing but still warns W_REMOTE_WRITE", () => {
    const access = resolveWriteAccess("192.168.1.2", false, true);
    expect(access.readOnly).toBe(false);
    expect(access.warning).toMatchObject({ code: "W_REMOTE_WRITE" });
    expect(access.warning?.message).toContain("import <path>");
    // 明示の --read-only は当然そのまま
    expect(resolveWriteAccess("192.168.1.2", true, true).readOnly).toBe(true);
  });
});

test("a non-loopback --host refuses writes (405 E_READ_ONLY)", async () => {
  dir = makeTempProject();
  const logs: string[] = [];
  srv = await boot(dir, { host: "0.0.0.0", log: (l) => logs.push(l) });
  expect(srv.readOnly).toBe(true);
  expect(logs.join("\n")).toContain("W_REMOTE_HOST");

  const base = local(srv);
  const res = await postCli(base, ["undo"]);
  expect(res.status).toBe(405);
  expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_READ_ONLY" } });

  const form = new FormData();
  form.append("file", new File(["x"], "a.txt", { type: "text/plain" }));
  const upload = await fetch(`${base}/api/upload`, { method: "POST", body: form });
  expect(upload.status).toBe(405);
  expect(await upload.json()).toMatchObject({ ok: false, error: { code: "E_READ_ONLY" } });

  // 読み取りは通る。allowlist の形（web が読む）は変えない
  const allowlist = (await (await fetch(`${base}/api/cli/allowlist`)).json()) as Record<string, unknown>;
  expect(Object.keys(allowlist).sort()).toEqual(["allowlist", "denied", "entries", "read_only"]);
  expect(allowlist.read_only).toBe(true);
});

test("--allow-remote-write re-enables writes on a non-loopback --host", async () => {
  dir = makeTempProject();
  const logs: string[] = [];
  srv = await boot(dir, { host: "0.0.0.0", allowRemoteWrite: true, log: (l) => logs.push(l) });
  expect(srv.readOnly).toBe(false);
  expect(logs.join("\n")).toContain("W_REMOTE_WRITE");

  const res = await postCli(local(srv), ["undo"]);
  // 405 で門前払いされず、CLI まで届いている（履歴が無いので undo 自体は失敗してよい）
  expect(res.status).not.toBe(405);
  expect((await res.json()) as { error?: { code?: string } }).not.toMatchObject({ error: { code: "E_READ_ONLY" } });

  expect(((await (await fetch(`${local(srv)}/api/cli/allowlist`)).json()) as { read_only: boolean }).read_only).toBe(
    false,
  );
}, 20_000);

describe("parseUploadLimit (serve --max-upload)", () => {
  test("accepts byte counts and binary units", () => {
    expect(parseUploadLimit("2G")).toBe(MAX_UPLOAD_BYTES);
    expect(parseUploadLimit("2GB")).toBe(2 * 1024 ** 3);
    expect(parseUploadLimit("2GiB")).toBe(2 * 1024 ** 3);
    expect(parseUploadLimit("512M")).toBe(512 * 1024 ** 2);
    expect(parseUploadLimit("1.5g")).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseUploadLimit("64k")).toBe(65536);
    expect(parseUploadLimit("1048576")).toBe(1048576);
    expect(parseUploadLimit(" 100 MB ")).toBe(100 * 1024 ** 2);
  });

  test("rejects anything that is not a positive size", () => {
    for (const bad of ["", "0", "-1", "2X", "two", "1e9", "2 GB extra", "NaN"]) {
      expect(parseUploadLimit(bad)).toBeNull();
    }
  });
});

test("an upload over the limit is E_UPLOAD_TOO_LARGE and points at path import", async () => {
  dir = makeTempProject();
  srv = await boot(dir, { maxUploadBytes: parseUploadLimit("64k") as number });
  expect(srv.maxUploadBytes).toBe(65536);
  // 上限は起動時に決まり、/api/status から見える（Web が送信前に確かめられる）
  const status = (await (await fetch(`${srv.url}/api/status`)).json()) as { server: { max_upload_bytes: number } };
  expect(status.server.max_upload_bytes).toBe(65536);

  const form = new FormData();
  form.append("file", new File(["y".repeat(70_000)], "big.bin", { type: "application/octet-stream" }));
  const res = await fetch(`${srv.url}/api/upload`, { method: "POST", body: form });
  expect(res.status).toBe(413);
  const body = (await res.json()) as { ok: boolean; error: { code: string; hint: string } };
  expect(body.ok).toBe(false);
  expect(body.error.code).toBe("E_UPLOAD_TOO_LARGE");
  expect(body.error.hint).toContain("montash import <path>");
  expect(body.error.hint).toContain("取り込み");
});

test("the default limit is 2GB and Bun's body cap leaves room for the multipart envelope", async () => {
  dir = makeTempProject();
  srv = await boot(dir);
  expect(srv.maxUploadBytes).toBe(MAX_UPLOAD_BYTES);
  expect(MAX_UPLOAD_BYTES).toBe(2 * 1024 ** 3);
  // Bun の既定（128MB）のままだと 2GB のアップロードが本文を読む前に落ちる
  expect(MAX_UPLOAD_BYTES).toBeGreaterThan(128 * 1024 ** 2);
});
