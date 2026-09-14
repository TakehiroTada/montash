/**
 * `montash ids rebuild` — `.montash/ids.json` を現在の project.json と履歴 object 群から再構築する
 * （docs/04 §15, ADR-13）。project.json は変更しないので op は作らない。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { rebuildIds } from "../../core/ids.ts";
import { loadProject, projectPaths } from "../../core/project.ts";
import { defineCommand } from "../define-command.ts";
import { type Warning, warning } from "../errors.ts";
import { currentHead } from "../mutate.ts";

/** `.montash/history/objects/*.json` を全部読む（壊れているものは skipped に数える） */
async function readHistoryObjects(dir: string): Promise<{ objects: unknown[]; skipped: string[] }> {
  const objectsDir = join(projectPaths(dir).historyDir, "objects");
  let names: string[];
  try {
    names = await readdir(objectsDir);
  } catch {
    return { objects: [], skipped: [] };
  }
  const objects: unknown[] = [];
  const skipped: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      objects.push(JSON.parse(await readFile(join(objectsDir, name), "utf8")));
    } catch {
      skipped.push(name);
    }
  }
  return { objects, skipped };
}

export const idsRebuild = defineCommand<Record<string, unknown>>({
  path: "ids rebuild",
  summary: "rebuild .montash/ids.json counters from project.json and every history object",
  description: "Counters never go backwards: the result is max(existing counter, highest used id + 1) per prefix.",
  examples: [{ cmd: "montash ids rebuild --json" }],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const { objects, skipped } = await readHistoryObjects(dir);
    const ids = await rebuildIds(dir, project, objects);
    const warnings: Warning[] = [];
    if (skipped.length > 0) {
      warnings.push(
        warning(
          "W_HISTORY_OBJECT_UNREADABLE",
          `${skipped.length} history object(s) could not be parsed and were skipped`,
          {
            hint: "Run `montash history verify`.",
            detail: { skipped },
          },
        ),
      );
    }
    const head = await currentHead(dir);
    const result = { counters: ids.counters, objects_scanned: objects.length, ids_file: projectPaths(dir).idsFile };
    const human = `ids rebuilt from project.json and ${objects.length} history object(s): ${Object.entries(ids.counters)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`;
    return { result, warnings, op: null, commit: null, head, human };
  },
});
