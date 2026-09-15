/**
 * checkout の「元に戻す」トースト（docs/06 §2.7、docs/13 D-8）。
 * 取り消しも必ず `POST /api/cli` の `montash checkout <id>` として出ることを確かめる（docs/06 §1.1）。
 */
import { afterEach, expect, test } from "bun:test";
import { checkout } from "../../../web/src/cli-client.ts";
import { useStore } from "../../../web/src/store.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  useStore.setState({ project: null, history: null, status: null, logs: [], toasts: [] });
});

/** `POST /api/cli` の引数だけ記録し、他（refresh 系 GET）は空 JSON を返す */
function recordCli(): string[][] {
  const calls: string[][] = [];
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    if (typeof input === "string" && input === "/api/cli" && init?.body) {
      calls.push((JSON.parse(String(init.body)) as { args: string[] }).args);
      return Promise.resolve(Response.json({ ok: true, exec: { args: [], duration_ms: 1, exit_code: 0 } }));
    }
    return Promise.resolve(Response.json({}));
  }) as unknown as typeof fetch;
  return calls;
}

test("checkout toast carries an undo that re-issues `checkout <previous head>`", async () => {
  const calls = recordCli();
  await checkout("o_0001", {
    toastMs: 12_000,
    action: { label: "元に戻す（checkout o_0042）", run: () => void checkout("o_0042") },
  });

  expect(calls).toEqual([["checkout", "o_0001"]]);
  const toast = useStore.getState().toasts.at(-1);
  expect(toast?.text).toContain("montash checkout o_0001");
  expect(toast?.action?.label).toContain("o_0042");

  await toast?.action?.run();
  expect(calls).toEqual([
    ["checkout", "o_0001"],
    ["checkout", "o_0042"],
  ]);
});

test("a failed checkout gets the error toast, without an undo button", async () => {
  globalThis.fetch = (() =>
    Promise.resolve(
      Response.json({ ok: false, error: { code: "E_NOT_FOUND", message: "no such ref" } }, { status: 404 }),
    )) as unknown as typeof fetch;
  await checkout("nope", { action: { label: "元に戻す", run: () => {} } });
  const toast = useStore.getState().toasts.at(-1);
  expect(toast?.level).toBe("error");
  expect(toast?.action).toBeUndefined();
});
