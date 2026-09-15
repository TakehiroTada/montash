/**
 * プロキシと派生データの生成（docs/04 §4 `proxy build|status`、docs/07 §10、W-02）。
 *
 * 対象は素材の種別で決まる: 動画 = プロキシ + サムネイル + （音声があれば）波形、
 * 音声 = プロキシ + 波形、画像 = サムネイルのみ。字幕・テキストは対象外。
 */
import { loadProject } from "../../core/project.ts";
import type { Asset, Project } from "../../core/schema.ts";
import { locateBinaries } from "../../ffmpeg/locate.ts";
import {
  buildProxy,
  buildThumbs,
  buildWaveform,
  type DerivedKind,
  type DerivedResult,
  derivedEligible,
  derivedStateOf,
  proxyEligible,
  proxyState,
} from "../../ffmpeg/proxy.ts";
import { defineCommand } from "../define-command.ts";
import { ExitCode, errors, toMontashError, warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { requireAsset } from "./assets.ts";

/** 要求された派生物のうち、この素材に作れるもの（1 つも無ければ空） */
function requestedKinds(asset: Asset, thumbs: boolean, waveform: boolean): DerivedKind[] {
  const kinds: DerivedKind[] = [];
  if (thumbs && derivedEligible(asset, "thumbs")) kinds.push("thumbs");
  if (waveform && derivedEligible(asset, "waveform")) kinds.push("waveform");
  return kinds;
}

/** `proxy build` の対象になり得る素材か（プロキシか、要求された派生物のどれかを作れる） */
function buildable(asset: Asset, thumbs: boolean, waveform: boolean): boolean {
  return proxyEligible(asset) || requestedKinds(asset, thumbs, waveform).length > 0;
}

export const proxyBuild = defineCommand({
  path: "proxy build",
  summary: "build H.264/AAC proxies and optional thumbnails and waveforms",
  workflows: ["W-02"],
  mutates: true,
  positionals: [{ name: "ids", describe: "asset IDs", variadic: true }],
  options: {
    all: { type: "boolean", describe: "all assets that can have a proxy or the requested derivatives" },
    force: { type: "boolean", describe: "rebuild ready proxies" },
    height: { type: "number", describe: "even video height (default: project setting)" },
    thumbs: { type: "boolean", describe: "also build the thumbnail sprite (video and image assets)" },
    waveform: { type: "boolean", describe: "also build the waveform (audio, and video with sound)" },
    parallel: { type: "number", describe: "number of workers", default: 2 },
  },
  examples: [{ cmd: "montash proxy build --all --thumbs --waveform", note: "W-02: proxies and browsable previews" }],
  async handler(ctx, args) {
    const ids = (args.ids ?? []) as string[];
    if (Boolean(args.all) === ids.length > 0) throw errors.usage("use either --all or one or more asset IDs");
    const parallel = Number(args.parallel ?? 2);
    if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 32)
      throw errors.usage("--parallel must be an integer between 1 and 32");
    const wantThumbs = Boolean(args.thumbs);
    const wantWaveform = Boolean(args.waveform);
    const bins = locateBinaries({ ...ctx.globals, env: ctx.env });
    let failedCount = 0;
    const result = await runMutation(ctx, async ({ project, dir, before }) => {
      const assets = args.all
        ? Object.values(project.assets).filter((a) => buildable(a, wantThumbs, wantWaveform))
        : [...new Set(ids)].map((id) => requireAsset(project, id));
      const unsupported = assets.find((a) => !buildable(a, wantThumbs, wantWaveform));
      if (unsupported)
        throw errors.usage(
          `nothing to build for ${unsupported.type} asset ${unsupported.id}`,
          "Proxies cover video and audio; --thumbs covers video and images; --waveform covers audio and video with sound.",
        );
      const proxies: Array<Awaited<ReturnType<typeof buildProxy>>> = [];
      const derived: DerivedResult[] = [];
      const failed: Array<{ id: string; error: ReturnType<ReturnType<typeof toMontashError>["toJSON"]> }> = [];
      const dryRun = ctx.globals.dryRun;
      let index = 0;
      await Promise.all(
        Array.from({ length: Math.min(parallel, assets.length) }, async () => {
          while (index < assets.length) {
            const asset = assets[index++]!;
            if (proxyEligible(asset)) {
              try {
                const proxy = await buildProxy(bins, dir, project, asset, {
                  height: Number(args.height ?? project.settings.proxy.height),
                  force: Boolean(args.force),
                  dryRun,
                });
                proxies.push(proxy);
                if (!dryRun)
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
            for (const kind of requestedKinds(asset, wantThumbs, wantWaveform)) {
              // 生成中であることを先に宣言しておき、途中で落ちたら missing に落とす（docs/06 §2.6）
              if (!dryRun)
                asset.derived = { ...asset.derived, [kind]: { ...asset.derived?.[kind], state: "building" } };
              try {
                const build = kind === "thumbs" ? buildThumbs : buildWaveform;
                const out = await build(bins, dir, project, asset, { force: Boolean(args.force), dryRun });
                derived.push(out);
                if (!dryRun)
                  asset.derived = {
                    ...asset.derived,
                    [kind]: {
                      state: out.state,
                      path: out.path,
                      ...(out.index !== undefined ? { index: out.index } : {}),
                      built_at: out.skipped ? asset.derived?.[kind]?.built_at : new Date().toISOString(),
                    },
                  };
              } catch (e) {
                if (!dryRun) asset.derived = { ...asset.derived, [kind]: { state: "missing" } };
                failed.push({ id: `${asset.id}/${kind}`, error: toMontashError(e).toJSON() });
              }
            }
          }
        }),
      );
      proxies.sort((a, b) => a.id.localeCompare(b.id));
      derived.sort((a, b) => a.id.localeCompare(b.id) || a.kind.localeCompare(b.kind));
      failedCount = failed.length;
      const lines = [
        ...proxies.map((p) => `${p.id}  proxy ${dryRun ? "planned" : p.state}${p.skipped ? " (cached)" : ""}`),
        ...derived.map((d) => `${d.id}  ${d.kind} ${dryRun ? "planned" : d.state}${d.skipped ? " (cached)" : ""}`),
      ];
      return {
        result: {
          proxies,
          thumbs: derived.filter((d) => d.kind === "thumbs"),
          waveforms: derived.filter((d) => d.kind === "waveform"),
          failed,
          ...(dryRun ? { dry_run: true } : {}),
        },
        summary: `build ${proxies.length} proxies, ${derived.length} derived files`,
        changed: JSON.stringify(project.assets) !== JSON.stringify(before.assets),
        warnings: failed.map((f) => warning("W_PROXY_FAILED", `${f.id}: ${f.error.message}`)),
        human: lines.join("\n") || "nothing to build",
      };
    });
    return { ...result, exitCode: failedCount ? ExitCode.IO : ExitCode.OK };
  },
});

/** 1 素材ぶんの状態（対象外の派生物は null） */
async function statusRow(dir: string, project: Project, asset: Asset) {
  return {
    id: asset.id,
    type: asset.type,
    state: proxyEligible(asset) ? await proxyState(dir, asset, project) : null,
    thumbs: derivedEligible(asset, "thumbs") ? await derivedStateOf(dir, asset, project, "thumbs") : null,
    waveform: derivedEligible(asset, "waveform") ? await derivedStateOf(dir, asset, project, "waveform") : null,
  };
}

export const proxyStatus = defineCommand({
  path: "proxy status",
  summary: "report ready, missing or stale proxies, thumbnails and waveforms",
  workflows: ["W-02"],
  examples: [{ cmd: "montash proxy status --json", note: "which assets still need `proxy build`" }],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const proxies = await Promise.all(
      Object.values(project.assets)
        .filter((a) => proxyEligible(a) || derivedEligible(a, "thumbs") || derivedEligible(a, "waveform"))
        .map((a) => statusRow(dir, project, a)),
    );
    return {
      result: { proxies },
      human:
        proxies
          .map((p) =>
            [
              p.id,
              p.state === null ? "" : `proxy: ${p.state}`,
              p.thumbs === null ? "" : `thumbs: ${p.thumbs}`,
              p.waveform === null ? "" : `waveform: ${p.waveform}`,
            ]
              .filter((s) => s !== "")
              .join("  "),
          )
          .join("\n") || "no video/audio/image assets",
    };
  },
});
