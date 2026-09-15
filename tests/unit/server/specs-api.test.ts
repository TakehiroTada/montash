/**
 * `GET /api/specs`（docs/06 §3.2, §3.6、計画 P3-2）。
 * Inspector のフォームはこの定義だけで組む（Web にコマンド表を持たない）ので、
 * 「`montash schema --json` と同じコマンド定義」「`effect presets` と同じパラメータ定義」
 * の 2 点を実際のレジストリと突き合わせて守る。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toSchema } from "../../../src/cli/define-command.ts";
import { getCommands } from "../../../src/registry/commands.ts";
import { effectRegistry } from "../../../src/registry/effects.ts";
import type { RunningServer } from "../../../src/server/index.ts";
import type { SpecsResponse } from "../../../src/server/specs.ts";
import { boot, makeTempProject, removeTemp } from "./helpers.ts";

describe("GET /api/specs", () => {
  let dir: string;
  let srv: RunningServer;
  let body: SpecsResponse;

  beforeAll(async () => {
    dir = makeTempProject();
    srv = await boot(dir);
    body = (await (await fetch(`${srv.url}/api/specs`)).json()) as SpecsResponse;
  });
  afterAll(async () => {
    await srv.stop();
    removeTemp(dir);
  });

  test("responds as read-only JSON with no-store (docs/06 §3.2 の作法)", async () => {
    const res = await fetch(`${srv.url}/api/specs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("commands are exactly `montash schema --json`", async () => {
    const expected = (await getCommands()).map(toSchema);
    expect(body.version).toEqual(expect.any(String));
    expect(body.commands).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(body.commands.map((c) => c.path)).toContain("clip trim");
    expect(body.commands.map((c) => c.path)).toContain("effect set");
  });

  test("each command carries what a form needs: positionals, options, examples", () => {
    const trim = body.commands.find((c) => c.path === "clip trim");
    expect(trim).toBeDefined();
    expect(trim?.mutates).toBe(true);
    expect(trim?.positionals[0]).toMatchObject({ name: "id", describe: "clip ID", required: true, type: "string" });
    expect(trim?.options.ripple).toBeDefined();
    expect(trim?.examples.length).toBeGreaterThan(0);
  });

  test("effects mirror the registry (`effect presets`), with typed params", () => {
    const names = body.effects.filter((e) => e.target === "video").map((e) => e.name);
    expect(names).toEqual(
      effectRegistry("video")
        .entries()
        .map((e) => e.name),
    );

    const color = body.effects.find((e) => e.name === "color");
    expect(color).toMatchObject({ target: "video", source: "builtin", requires: ["eq"] });
    // number（min/max 付き）→ スライダー、string の choices → セレクト、boolean → チェックボックス
    expect(color?.params.saturation).toEqual({ type: "number", describe: expect.any(String), min: 0, max: 3 });

    const mosaic = body.effects.find((e) => e.name === "mosaic");
    expect(mosaic?.params.mode).toMatchObject({ type: "string", choices: ["avg", "min", "max"], default: "avg" });

    const rotate = body.effects.find((e) => e.name === "rotate");
    expect(rotate?.params.fit).toMatchObject({ type: "boolean", default: true });
    expect(rotate?.params.angle).toMatchObject({ type: "string", required: true, choices: ["90", "180", "270"] });
  });

  test("`effect set` is not in the default allowlist, so the UI must disable the form", async () => {
    const allow = (await (await fetch(`${srv.url}/api/cli/allowlist`)).json()) as { allowlist: string[] };
    expect(allow.allowlist).not.toContain("effect set");
    expect(allow.allowlist).not.toContain("effect");
  });

  test("still served with --read-only (nothing is mutated)", async () => {
    const ro = await boot(dir, { readOnly: true });
    try {
      const res = await fetch(`${ro.url}/api/specs`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as SpecsResponse).effects.length).toBeGreaterThan(0);
    } finally {
      await ro.stop();
    }
  });
});
