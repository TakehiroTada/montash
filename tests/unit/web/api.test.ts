import { afterEach, expect, test } from "bun:test";
import { refreshHistory, refreshProject, refreshStatus } from "../../../web/src/api.ts";
import { useStore } from "../../../web/src/store.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  useStore.setState({ project: null, history: null, status: null, logs: [] });
});

for (const [refresh, key] of [
  [refreshProject, "project"],
  [refreshStatus, "status"],
  [refreshHistory, "history"],
] as const) {
  test(`${key}: late older responses cannot replace a newer snapshot`, async () => {
    const pending: Array<(response: Response) => void> = [];
    globalThis.fetch = (() => new Promise<Response>((resolve) => pending.push(resolve))) as unknown as typeof fetch;
    const older = refresh();
    const newer = refresh();
    pending[1]!(Response.json({ name: "newer" }));
    await newer;
    pending[0]!(Response.json({ name: "older" }));
    await older;
    expect(useStore.getState()[key]).toMatchObject({ name: "newer" });
  });
}

test("network errors are logged instead of rejecting background refreshes", async () => {
  globalThis.fetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
  await refreshStatus();
  expect(useStore.getState().logs.at(-1)?.message).toContain("offline");
});
