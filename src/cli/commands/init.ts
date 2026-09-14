/**
 * `montash init <dir>` — プロジェクト作成（docs/03 W-01, docs/04 §3）
 *
 * fps と解像度はプロジェクトの基準単位（ADR-09）。fps は有理数 {num, den} で保存する。
 */
import { resolve } from "node:path";
import { defineCommand } from "../define-command.ts";
import { errors } from "../errors.ts";
import { createProject, defaultProjectName, fpsLabel, framesToSeconds, initProjectDir, parseFps, parseResolution } from "../../core/project.ts";

interface Args extends Record<string, unknown> {
  dir: string;
  fps?: string | number;
  resolution?: string;
  sampleRate: number;
  channels: number;
  name?: string;
  template?: string;
  force: boolean;
}

/** `--template` の展開（docs/04 §3） */
export const INIT_TEMPLATES: Readonly<Record<string, { fps: string; resolution: string; note: string }>> = {
  "youtube-1080p30": { fps: "30", resolution: "1920x1080", note: "YouTube 1080p 30fps" },
  "youtube-4k30": { fps: "30", resolution: "3840x2160", note: "YouTube 4K 30fps" },
  "reel-1080x1920-30": { fps: "30", resolution: "1080x1920", note: "vertical reel / shorts 30fps" },
  "cinema-24": { fps: "24", resolution: "1920x1080", note: "cinema 24fps" },
  "broadcast-2997": { fps: "29.97", resolution: "1920x1080", note: "broadcast 29.97fps (30000/1001)" },
};

export const init = defineCommand<Args>({
  path: "init",
  summary: "create a new project directory with project.json and .montash/",
  description: "fps and resolution become the project's base units: all times are stored as integer frames of this fps.",
  workflows: ["W-01"],
  noProject: true,
  mutates: false,
  positionals: [{ name: "dir", describe: "project directory to create (\".\" for the current directory)", required: true }],
  options: {
    fps: { type: "string", describe: "frame rate: 23.976 | 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60, or a fraction like 30000/1001 (default 30)" },
    resolution: { type: "string", describe: "canvas size WIDTHxHEIGHT, even pixels (default 1920x1080)" },
    "sample-rate": { type: "number", describe: "audio sample rate", default: 48000 },
    channels: { type: "number", describe: "audio channels", default: 2 },
    name: { type: "string", describe: "project name (default: directory name)" },
    template: { type: "string", describe: "preset for fps/resolution (explicit --fps/--resolution override it)", choices: Object.keys(INIT_TEMPLATES) },
    force: { type: "boolean", describe: "overwrite an existing project.json (discards the existing project and its history)", default: false },
  },
  examples: [
    { cmd: "montash init my-vlog --fps 30 --resolution 1920x1080 --sample-rate 48000" },
    { cmd: "montash init my-vlog --fps 29.97 --json", note: "29.97 is stored as 30000/1001" },
    { cmd: "montash init shorts --template reel-1080x1920-30" },
  ],
  async handler(ctx, args) {
    if (!args.dir) throw errors.usage("missing <dir>", "montash init <dir> [--fps 30] [--resolution 1920x1080]");
    const template = args.template ? INIT_TEMPLATES[args.template] : undefined;
    if (args.template && !template) {
      throw errors.usage(`unknown template "${args.template}"`, `Available: ${Object.keys(INIT_TEMPLATES).join(", ")}`);
    }
    const fps = parseFps(args.fps ?? template?.fps ?? "30");
    const resolution = parseResolution(args.resolution ?? template?.resolution ?? "1920x1080");
    const sampleRate = Number(args.sampleRate);
    const channels = Number(args.channels);
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw errors.usage(`invalid --sample-rate ${String(args.sampleRate)}`, "Use a positive integer such as 48000.");
    if (!Number.isInteger(channels) || channels <= 0) throw errors.usage(`invalid --channels ${String(args.channels)}`, "Use 1 or 2.");

    const dir = resolve(ctx.cwd, args.dir);
    const name = args.name?.trim() || defaultProjectName(dir);
    const project = createProject({ name, fps, resolution, sampleRate, channels });

    if (ctx.globals.dryRun) {
      return {
        result: { dry_run: true, project_dir: dir, settings: describeSettings(project.settings) },
        human: `would create ${dir} (${name}, ${fpsLabel(fps)} fps, ${resolution.width}x${resolution.height})`,
      };
    }

    const paths = await initProjectDir(dir, project, { force: args.force });
    const settings = describeSettings(project.settings);
    const result = {
      project_dir: paths.root,
      project_file: paths.projectFile,
      name: project.name,
      settings,
      tracks: project.tracks.map((t) => ({ id: t.id, kind: t.kind })),
      created: [paths.projectFile, paths.gitignore, paths.idsFile, paths.assetsDir, paths.outDir, paths.stateDir],
      ...(template ? { template: args.template } : {}),
      forced: Boolean(args.force),
    };
    const human = [
      `initialized project "${project.name}" in ${paths.root}`,
      `  fps         ${settings.fps_label} (${settings.fps.num}/${settings.fps.den}; 1 frame = ${settings.frame_duration_s.toFixed(6)} s)`,
      `  resolution  ${settings.resolution.width}x${settings.resolution.height}`,
      `  audio       ${settings.sample_rate} Hz, ${settings.channels} ch`,
      `  tracks      ${project.tracks.map((t) => t.id).join(", ")}`,
      `  next        montash import <files...>   (run inside ${paths.root} or with -C)`,
    ].join("\n");
    return { result, human };
  },
});

/** 設定の要約（init / project show 共通の形） */
export function describeSettings(settings: ReturnType<typeof createProject>["settings"]) {
  return {
    fps: { num: settings.fps.num, den: settings.fps.den },
    fps_label: fpsLabel(settings.fps),
    frame_duration_s: framesToSeconds(1, settings.fps),
    resolution: { width: settings.resolution.width, height: settings.resolution.height },
    sample_rate: settings.sample_rate,
    channels: settings.channels,
    background: settings.background,
    default_image_duration_f: settings.default_image_duration_f,
    default_font: settings.default_font,
    text_engine: settings.text_engine,
  };
}
