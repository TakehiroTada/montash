import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CliExecutor, checkAllowlist, needsConfirm, resolveCliCommand } from "../../../src/server/cli-exec.ts";
import type { RunningServer } from "../../../src/server/index.ts";
import { boot, makeTempProject, removeTemp } from "./helpers.ts";

describe("allowlist / confirm rules", () => {
  test("matches args[0] and args[0] + ' ' + args[1]", () => {
    expect(checkAllowlist(["checkout", "o_0001"]).allowed).toBe(true);
    expect(checkAllowlist(["undo"]).allowed).toBe(true);
    expect(checkAllowlist(["assets", "remove", "x"])).toMatchObject({ allowed: true, matched: "assets remove" });
    expect(checkAllowlist(["reset", "--hard"])).toMatchObject({ allowed: true, matched: "reset --hard" });
    expect(checkAllowlist(["reset"]).allowed).toBe(false);
    expect(checkAllowlist(["assets", "list"]).allowed).toBe(false);
    expect(checkAllowlist(["doctor"]).allowed).toBe(false);
    expect(checkAllowlist(["clip", "trim", "c2"]).allowed).toBe(false);
    expect(checkAllowlist([]).allowed).toBe(false);
    expect(checkAllowlist(["--json"]).allowed).toBe(false);
  });

  test("server-fixed global options cannot be overridden", () => {
    expect(checkAllowlist(["checkout", "o_1", "-C", "/etc"]).allowed).toBe(false);
    expect(checkAllowlist(["checkout", "o_1", "--project=/etc"]).allowed).toBe(false);
    expect(checkAllowlist(["import", "x.mp4", "--ffmpeg-path", "/bin/sh"]).allowed).toBe(false);
  });

  test("needsConfirm for --force / --overwrite / reset / revert", () => {
    expect(needsConfirm(["assets", "remove", "x", "--force"])).toBe(true);
    expect(needsConfirm(["preview", "build", "--overwrite"])).toBe(true);
    expect(needsConfirm(["reset", "--hard"])).toBe(true);
    expect(needsConfirm(["revert", "k_1"])).toBe(true);
    expect(needsConfirm(["checkout", "o_1"])).toBe(false);
    expect(needsConfirm(["undo"])).toBe(false);
  });

  test("resolveCliCommand points at bun + src/cli/index.ts in development", () => {
    const cmd = resolveCliCommand();
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd[1]).toMatch(/src[\\/]cli[\\/]index\.ts$/);
  });
});

describe("POST /api/cli", () => {
  let dir: string;
  let srv: RunningServer;
  beforeAll(async () => {
    dir = makeTempProject();
    srv = await boot(dir);
  });
  afterAll(async () => {
    await srv.stop();
    removeTemp(dir);
  });

  const post = (body: unknown) =>
    fetch(`${srv.url}/api/cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("rejects commands outside the allowlist with 403 E_WEB_COMMAND_NOT_ALLOWED", async () => {
    const res = await post({ args: ["doctor"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_WEB_COMMAND_NOT_ALLOWED" } });
  });

  test("rejects malformed bodies with 400", async () => {
    expect((await post({ args: "checkout" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const res = await fetch(`${srv.url}/api/cli`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  test("destructive flags require confirm (409 E_CONFIRM_REQUIRED)", async () => {
    const res = await post({ args: ["assets", "remove", "clip_a", "--force"] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_CONFIRM_REQUIRED" } });
  });

  test("allowed command is spawned and the CLI JSON is passed through (200 even if the CLI fails)", async () => {
    const res = await post({ args: ["checkout", "o_0001"] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      error?: { code: string };
      exec: { args: string[]; actor: string; duration_ms: number; exit_code: number };
    };
    // checkout は未実装なので CLI 側は E_USAGE 系で失敗するが、JSON はそのまま透過される
    expect(body.ok).toBe(false);
    expect(body.error?.code).toMatch(/^E_/);
    expect(body.exec).toMatchObject({ args: ["checkout", "o_0001"], actor: "web" });
    expect(body.exec.exit_code).not.toBe(0);
  }, 15_000);

  test("confirm: true lets a destructive command through to the CLI", async () => {
    const res = await post({ args: ["assets", "remove", "clip_a", "--force"], confirm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, exec: { args: ["assets", "remove", "clip_a", "--force"] } });
  }, 15_000);

  test("runs are serialized (FIFO order, no overlap)", async () => {
    const seen: string[] = [];
    const exec = new CliExecutor({
      projectDir: dir,
      command: [
        process.execPath,
        "-e",
        "await Bun.sleep(80); console.log(JSON.stringify({ ok: true, argv: Bun.argv }))",
      ],
    });
    const started = performance.now();
    const runs = ["a", "b", "c"].map((x) =>
      exec
        .handle({ args: ["undo", x] }, "t")
        .then((r) =>
          seen.push(((r.body as { argv?: string[] }).argv ?? []).find((v) => ["a", "b", "c"].includes(v)) ?? "?"),
        ),
    );
    await Promise.all(runs);
    expect(seen).toEqual(["a", "b", "c"]);
    // 3 本が直列なら 80ms × 3 以上かかる（並列なら約 80ms）
    expect(performance.now() - started).toBeGreaterThanOrEqual(240);
  });

  test("read-only server answers 405", async () => {
    const ro = await boot(dir, { readOnly: true });
    try {
      const res = await fetch(`${ro.url}/api/cli`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: ["undo"] }),
      });
      expect(res.status).toBe(405);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_READ_ONLY" } });
      const al = (await (await fetch(`${ro.url}/api/cli/allowlist`)).json()) as { read_only: boolean };
      expect(al.read_only).toBe(true);
    } finally {
      await ro.stop();
    }
  });
});
