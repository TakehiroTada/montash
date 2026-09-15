import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, saveProject } from "../../../src/core/project.ts";
import { ClipSchema } from "../../../src/core/schema.ts";
import { PreviewCoordinator } from "../../../src/server/preview.ts";

async function setup(auto = true) {
  const dir = await mkdtemp(join(tmpdir(), "montash-preview-schedule-"));
  const project = createProject({
    name: "scheduler",
    fps: { num: 30, den: 1 },
    resolution: { width: 640, height: 360 },
  });
  project.settings.preview.debounce_ms = 30;
  project.settings.preview.auto_build = auto;
  project.tracks[0]!.clips.push(ClipSchema.parse({ id: "c1", asset: "unused", start_f: 0, in_f: 0, out_f: 90 }));
  await saveProject(dir, project);
  const worker = join(dir, "worker.ts");
  await writeFile(
    worker,
    `
    import { appendFileSync } from "node:fs";
    const log = ${JSON.stringify(join(dir, "events"))};
    const record = (event) => appendFileSync(log, event + "\\n");
    process.on("SIGTERM", () => { record("cancel"); process.exit(0); });
    record("start");
    setTimeout(() => { record("end"); process.exit(0); }, 1000);
  `,
  );
  return {
    dir,
    command: [process.execPath, worker],
    events: async () =>
      (await readFile(join(dir, "events"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
  };
}
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("scheduler did not reach expected state");
    await Bun.sleep(20);
  }
}

test("edits cancel the active build and debounce its replacement; shutdown awaits cancellation", async () => {
  const { dir, command, events } = await setup();
  const coordinator = new PreviewCoordinator(
    dir,
    true,
    () => {},
    () => {},
    command,
  );
  try {
    coordinator.start();
    await until(async () => (await events()).includes("start"));
    coordinator.changed();
    coordinator.changed();
    coordinator.changed();
    await until(async () => (await events()).filter((v) => v === "start").length === 2);
    await coordinator.stop();
    expect(await events()).toEqual(["start", "cancel", "start", "cancel"]);
  } finally {
    await coordinator.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("server and project auto-preview switches both suppress generation", async () => {
  for (const [serverAuto, projectAuto] of [
    [false, true],
    [true, false],
  ]) {
    const { dir, command, events } = await setup(projectAuto);
    const coordinator = new PreviewCoordinator(
      dir,
      serverAuto!,
      () => {},
      () => {},
      command,
    );
    try {
      coordinator.start();
      coordinator.changed();
      await Bun.sleep(150);
      expect(await events()).toEqual([]);
    } finally {
      await coordinator.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
