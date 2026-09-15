/**
 * `serve --allow/--deny` と プラグインの `webAllow` の合成（docs/06 §3.3、計画 P3-3）。
 *
 * 固定したい約束:
 *   1. フラグを渡さなければ許可リストは **従来と完全に同一**（順序込み）
 *   2. `--allow` は足し、`--deny` は引く。`--deny` は `--allow` にも `webAllow` にも勝つ
 *   3. 存在しないコマンドは `E_USAGE` で早期に弾く
 *   4. `GET /api/cli/allowlist` が出自（default / flag / plugin:<id>）を返す
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServeAllowlist, normalizeAllowlistFlag } from "../../../src/cli/commands/serve.ts";
import { MontashError } from "../../../src/cli/errors.ts";
import { clearLoadedPlugins, loadAllPlugins } from "../../../src/plugins/loader.ts";
import {
  type AllowlistEntry,
  CliExecutor,
  checkAllowlist,
  DEFAULT_ALLOWLIST,
  resolveAllowlist,
} from "../../../src/server/cli-exec.ts";
import { boot, makeTempProject, removeTemp } from "./helpers.ts";

const origins = (entries: readonly AllowlistEntry[], command: string): string[] | undefined =>
  entries.find((e) => e.command === command)?.origins;

describe("resolveAllowlist（既定）", () => {
  test("何も渡さなければ DEFAULT_ALLOWLIST と完全に同一（順序込み）", () => {
    expect(resolveAllowlist().allowlist).toEqual([...DEFAULT_ALLOWLIST]);
    expect(resolveAllowlist({}).denied).toEqual([]);
    expect(resolveAllowlist().entries.every((e) => e.origins.length === 1 && e.origins[0] === "default")).toBe(true);
  });

  test("CliExecutor も既定では従来どおりの許可リストを持つ", () => {
    const exec = new CliExecutor({ projectDir: "/tmp" });
    expect(exec.allowlist).toEqual([...DEFAULT_ALLOWLIST]);
    expect(exec.allowlistDetail.denied).toEqual([]);
    // 文字列配列を渡す従来の形も壊れない
    expect(new CliExecutor({ projectDir: "/tmp", allowlist: ["undo"] }).allowlist).toEqual(["undo"]);
  });
});

describe("resolveAllowlist（合成）", () => {
  test("--allow は足す（出自 flag）", () => {
    const r = resolveAllowlist({ allow: ["effect set"] });
    expect(r.allowlist).toEqual([...DEFAULT_ALLOWLIST, "effect set"]);
    expect(origins(r.entries, "effect set")).toEqual(["flag"]);
    expect(checkAllowlist(["effect", "set", "c1", "0"], r.allowlist)).toMatchObject({ allowed: true });
  });

  test("--deny は既定からも引く", () => {
    const r = resolveAllowlist({ deny: ["undo", "assets remove"] });
    expect(r.allowlist).not.toContain("undo");
    expect(r.allowlist).not.toContain("assets remove");
    expect(r.allowlist).toContain("redo");
    expect(r.denied).toEqual(["undo", "assets remove"]);
    expect(checkAllowlist(["undo"], r.allowlist).allowed).toBe(false);
  });

  test("プラグインの webAllow が足される（出自 plugin:<id>）", () => {
    const r = resolveAllowlist({ plugins: [{ id: "com.example.glow", webAllow: ["effect set", "checkout"] }] });
    expect(r.allowlist).toContain("effect set");
    expect(origins(r.entries, "effect set")).toEqual(["plugin:com.example.glow"]);
    // 既定にもあるコマンドは出自が並ぶ（重複はしない）
    expect(origins(r.entries, "checkout")).toEqual(["default", "plugin:com.example.glow"]);
    expect(r.allowlist.filter((c) => c === "checkout")).toHaveLength(1);
  });

  test("--deny は --allow にも webAllow にも勝つ", () => {
    const r = resolveAllowlist({
      plugins: [{ id: "com.example.glow", webAllow: ["effect set"] }],
      allow: ["effect set", "effect add"],
      deny: ["effect set"],
    });
    expect(r.allowlist).not.toContain("effect set");
    expect(r.allowlist).toContain("effect add");
    expect(r.denied).toEqual(["effect set"]);
  });

  test("語の区切りの空白は正規化される", () => {
    const r = resolveAllowlist({ allow: ["  effect   set "] });
    expect(r.allowlist).toContain("effect set");
  });
});

describe("--allow / --deny の検証", () => {
  test("コマンドパスを受ける（繰り返し / カンマ区切り）", async () => {
    expect(await normalizeAllowlistFlag(["effect set"], "--allow")).toEqual(["effect set"]);
    expect(await normalizeAllowlistFlag(["effect set,effect add"], "--allow")).toEqual(["effect set", "effect add"]);
    expect(await normalizeAllowlistFlag(["undo", "undo"], "--deny")).toEqual(["undo"]);
    // 2 語目がフラグなら 1 語目をコマンドとして検証する
    expect(await normalizeAllowlistFlag(["reset --hard"], "--deny")).toEqual(["reset --hard"]);
    expect(await normalizeAllowlistFlag([], "--allow")).toEqual([]);
  });

  test("存在しないコマンドは E_USAGE", async () => {
    for (const value of ["nope", "clip", "effect nope", "a b c", "--json"]) {
      const err = await normalizeAllowlistFlag([value], "--allow").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MontashError);
      expect((err as MontashError).code).toBe("E_USAGE");
    }
  });

  test("サーバ固定のグローバルオプションは許可できない", async () => {
    const err = await normalizeAllowlistFlag(["checkout --json"], "--allow").catch((e: unknown) => e);
    expect((err as MontashError).code).toBe("E_USAGE");
  });
});

describe("buildServeAllowlist（プラグイン込み）", () => {
  afterEach(() => {
    clearLoadedPlugins();
  });

  test("読み込み済みプラグインの webAllow が合成され、--deny が勝つ", async () => {
    const root = await mkdtemp(join(tmpdir(), "montash-allow-plugins-"));
    const dir = join(root, "com.example.allow");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "montash-plugin.json"),
      JSON.stringify({ id: "com.example.allow", apiVersion: 1, version: "1.0.0", webAllow: ["effect set", "undo"] }),
    );
    await writeFile(join(dir, "index.js"), "export default { register() {} };");
    const { failures } = await loadAllPlugins(null, { env: { MONTASH_PLUGIN_PATH: root } as NodeJS.ProcessEnv });
    expect(failures).toEqual([]);

    const merged = await buildServeAllowlist({});
    expect(merged.allowlist).toContain("effect set");
    expect(origins(merged.entries, "effect set")).toEqual(["plugin:com.example.allow"]);
    expect(origins(merged.entries, "undo")).toEqual(["default", "plugin:com.example.allow"]);

    const denied = await buildServeAllowlist({ deny: ["effect set"] });
    expect(denied.allowlist).not.toContain("effect set");
    expect(denied.denied).toEqual(["effect set"]);
  });

  test("プラグインが無く、フラグも無ければ既定と同一", async () => {
    expect((await buildServeAllowlist({})).allowlist).toEqual([...DEFAULT_ALLOWLIST]);
  });
});

describe("GET /api/cli/allowlist", () => {
  test("既定では従来と同じ内容を返しつつ、出自を添える", async () => {
    const dir = makeTempProject();
    const srv = await boot(dir);
    try {
      const body = (await (await fetch(`${srv.url}/api/cli/allowlist`)).json()) as {
        allowlist: string[];
        entries: AllowlistEntry[];
        denied: string[];
        read_only: boolean;
      };
      expect(body.allowlist).toEqual([...DEFAULT_ALLOWLIST]);
      expect(body.entries.map((e) => e.command)).toEqual(body.allowlist);
      expect(origins(body.entries, "checkout")).toEqual(["default"]);
      expect(body.denied).toEqual([]);
      expect(body.read_only).toBe(false);
    } finally {
      await srv.stop();
      removeTemp(dir);
    }
  });

  test("合成済みの許可リストが API と POST /api/cli の両方に効く", async () => {
    const dir = makeTempProject();
    const allowlist = resolveAllowlist({
      plugins: [{ id: "com.example.glow", webAllow: ["effect set"] }],
      allow: ["effect add"],
      deny: ["undo"],
    });
    const srv = await boot(dir, { cliExec: { allowlist } });
    try {
      const body = (await (await fetch(`${srv.url}/api/cli/allowlist`)).json()) as {
        allowlist: string[];
        entries: AllowlistEntry[];
        denied: string[];
      };
      expect(body.allowlist).toContain("effect set");
      expect(body.allowlist).toContain("effect add");
      expect(body.allowlist).not.toContain("undo");
      expect(origins(body.entries, "effect set")).toEqual(["plugin:com.example.glow"]);
      expect(origins(body.entries, "effect add")).toEqual(["flag"]);
      expect(body.denied).toEqual(["undo"]);

      const post = (args: string[]) =>
        fetch(`${srv.url}/api/cli`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ args }),
        });
      const res = await post(["undo"]);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_WEB_COMMAND_NOT_ALLOWED" } });
    } finally {
      await srv.stop();
      removeTemp(dir);
    }
  });

  test("--read-only の方が強い（--allow で足しても書き込みは 405）", async () => {
    const dir = makeTempProject();
    const allowlist = resolveAllowlist({ allow: ["effect set"] });
    const srv = await boot(dir, { readOnly: true, cliExec: { allowlist } });
    try {
      const res = await fetch(`${srv.url}/api/cli`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ args: ["effect", "set", "c1", "0", "--param", "x=1"] }),
      });
      expect(res.status).toBe(405);
      expect(await res.json()).toMatchObject({ ok: false, error: { code: "E_READ_ONLY" } });
      const body = (await (await fetch(`${srv.url}/api/cli/allowlist`)).json()) as {
        allowlist: string[];
        read_only: boolean;
      };
      // 許可リスト自体は返るが、書き込み API が閉じているので実行はできない
      expect(body.allowlist).toContain("effect set");
      expect(body.read_only).toBe(true);
    } finally {
      await srv.stop();
      removeTemp(dir);
    }
  });
});
