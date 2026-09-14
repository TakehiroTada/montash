import { loadProject } from "../../core/project.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import { buildProxy, proxyEligible, proxyState } from "../../ffmpeg/proxy.ts";
import { defineCommand } from "../define-command.ts";
import { ExitCode, errors, toMontashError, warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { requireAsset } from "./assets.ts";

export const proxyBuild = defineCommand({
  path: "proxy build",
  summary: "build H.264/AAC video and audio proxies",
  workflows: ["W-02"],
  mutates: true,
  positionals: [{ name: "ids", describe: "asset IDs", variadic: true }],
  options: {
    all: { type: "boolean", describe: "all video and audio assets" },
    force: { type: "boolean", describe: "rebuild ready proxies" },
    height: { type: "number", describe: "even video height (default: project setting)" },
    parallel: { type: "number", describe: "number of workers", default: 2 },
  },
  async handler(ctx, args) {
    const ids = (args.ids ?? []) as string[];
    if (Boolean(args.all) === ids.length > 0) throw errors.usage("use either --all or one or more asset IDs");
    const parallel = Number(args.parallel ?? 2);
    if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 32)
      throw errors.usage("--parallel must be an integer between 1 and 32");
    const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
    let failedCount = 0;
    const result = await runMutation(ctx, async ({ project, dir, before }) => {
      const assets = args.all
        ? Object.values(project.assets).filter(proxyEligible)
        : [...new Set(ids)].map((id) => requireAsset(project, id));
      if (assets.some((a) => !proxyEligible(a))) throw errors.usage("proxies are supported for video and audio assets");
      const results: Array<Awaited<ReturnType<typeof buildProxy>>> = [];
      const failed: Array<{ id: string; error: ReturnType<ReturnType<typeof toMontashError>["toJSON"]> }> = [];
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(parallel, assets.length) }, async () => {
          while (index < assets.length) {
            const asset = assets[index++]!;
            try {
              const proxy = await buildProxy(bins, dir, project, asset, {
                height: Number(args.height ?? project.settings.proxy.height),
                force: Boolean(args.force),
                dryRun: ctx.globals.dryRun,
              });
              results.push(proxy);
              if (!ctx.globals.dryRun)
                asset.derived = {
                  ...asset.derived,
                  proxy: {
                    state: proxy.state,
                    path: proxy.path,
                    built_at: proxy.skipped ? asset.derived?.proxy?.built_at : new Date().toISOString(),
                  },
                };
            } catch (e) {
              failed.push({ id: asset.id, error: toMontashError(e).toJSON() });
            }
          }
        }),
      );
      results.sort((a, b) => a.id.localeCompare(b.id));
      failedCount = failed.length;
      return {
        result: { proxies: results, failed, ...(ctx.globals.dryRun ? { dry_run: true } : {}) },
        summary: `build ${results.length} proxies`,
        changed: JSON.stringify(project.assets) !== JSON.stringify(before.assets),
        warnings: failed.map((f) => warning("W_PROXY_FAILED", `${f.id}: ${f.error.message}`)),
        human: results
          .map((p) => `${p.id}  ${ctx.globals.dryRun ? "planned" : p.state}${p.skipped ? " (cached)" : ""}`)
          .join("\n"),
      };
    });
    return { ...result, exitCode: failedCount ? ExitCode.IO : ExitCode.OK };
  },
});

export const proxyStatus = defineCommand({
  path: "proxy status",
  summary: "report ready, missing or stale proxies",
  workflows: ["W-02"],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const proxies = await Promise.all(
      Object.values(project.assets)
        .filter(proxyEligible)
        .map(async (a) => ({ id: a.id, state: await proxyState(dir, a, project) })),
    );
    return {
      result: { proxies },
      human: proxies.map((p) => `${p.id}  ${p.state}`).join("\n") || "no video/audio assets",
    };
  },
});
