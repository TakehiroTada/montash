/**
 * `montash project show` / `montash project set <key> <value>`（docs/03 W-01, docs/04 §3）
 */

import { clipCount, timelineDurationF } from "../../core/assets.ts";
import { framesToSeconds, framesToTc, hashProject, loadProject } from "../../core/project.ts";
import type { Project } from "../../core/schema.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { describeSettings } from "./init.ts";

// ---------------------------------------------------------------------------
// project show
// ---------------------------------------------------------------------------

/** タイムライン要約（docs/04 §1.5 `timeline`） */
export function timelineSummary(project: Project) {
  const fps = project.settings.fps;
  const duration_f = timelineDurationF(project);
  return {
    duration_f,
    duration: framesToSeconds(duration_f, fps),
    duration_tc: framesToTc(duration_f, fps),
    fps: { num: fps.num, den: fps.den },
    clip_count: clipCount(project),
  };
}

export const projectShow = defineCommand<Record<string, unknown>>({
  path: "project show",
  summary: "show project settings, asset/track counts and timeline duration",
  workflows: ["W-01"],
  examples: [{ cmd: "montash project show --json" }],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const settings = describeSettings(project.settings);
    const timeline = timelineSummary(project);
    const assetsByType: Record<string, number> = {};
    for (const a of Object.values(project.assets)) assetsByType[a.type] = (assetsByType[a.type] ?? 0) + 1;
    const result = {
      name: project.name,
      project_dir: dir,
      schema_version: project.schema_version,
      created_at: project.created_at,
      updated_at: project.updated_at,
      settings,
      asset_count: Object.keys(project.assets).length,
      assets_by_type: assetsByType,
      track_count: project.tracks.length,
      tracks: project.tracks.map((t) => ({
        id: t.id,
        kind: t.kind,
        clip_count: t.clips.length,
        muted: t.muted,
        locked: t.locked,
      })),
      transition_count: project.transitions.length,
      duration_f: timeline.duration_f,
      duration: timeline.duration,
      duration_tc: timeline.duration_tc,
      hash: hashProject(project),
    };
    const human = [
      `${project.name}  (${dir})`,
      `  schema      v${project.schema_version}    updated ${project.updated_at}`,
      `  fps         ${settings.fps_label} (${settings.fps.num}/${settings.fps.den}; 1 frame = ${settings.frame_duration_s.toFixed(6)} s)`,
      `  resolution  ${settings.resolution.width}x${settings.resolution.height}    background ${settings.background}`,
      `  audio       ${settings.sample_rate} Hz, ${settings.channels} ch`,
      `  text        ${settings.text_engine}, font "${settings.default_font}"`,
      `  assets      ${result.asset_count}${
        result.asset_count
          ? ` (${Object.entries(assetsByType)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")})`
          : ""
      }`,
      `  tracks      ${result.tracks.map((t) => `${t.id}[${t.clip_count}]`).join(" ") || "(none)"}`,
      `  transitions ${result.transition_count}`,
      `  duration    ${formatDuration(timeline.duration_f, project, ctx.globals.timeFormat)}`,
    ].join("\n");
    return { result, timeline, human };
  },
});

function formatDuration(f: number, project: Project, fmt: "frames" | "seconds" | "tc"): string {
  const fps = project.settings.fps;
  const s = framesToSeconds(f, fps);
  switch (fmt) {
    case "frames":
      return `f:${f} (${s.toFixed(3)} s)`;
    case "tc":
      return `${framesToTc(f, fps)} (f:${f})`;
    default:
      return `${s.toFixed(3)} s (f:${f}, ${framesToTc(f, fps)})`;
  }
}

// ---------------------------------------------------------------------------
// project set
// ---------------------------------------------------------------------------

interface SetArgs extends Record<string, unknown> {
  key: string;
  value: string;
}

const SETTABLE = ["name", "default_font", "text_engine", "background"] as const;
const DEFERRED = ["fps", "resolution", "sample_rate", "channels"] as const;

export const projectSet = defineCommand<SetArgs>({
  path: "project set",
  summary: "change a project setting (name, default_font, text_engine, background)",
  description:
    "fps / resolution / sample_rate / channels require re-snapping every _f/_smp field and are not implemented yet (M1).",
  workflows: ["W-15"],
  mutates: true,
  positionals: [
    { name: "key", describe: `setting key: ${[...SETTABLE, ...DEFERRED].join(" | ")}`, required: true },
    { name: "value", describe: "new value", required: true },
  ],
  examples: [
    { cmd: 'montash project set name "summer-trip"' },
    { cmd: 'montash project set default_font "Noto Sans CJK JP"' },
    { cmd: "montash project set text_engine drawtext" },
  ],
  async handler(ctx, args) {
    const key = String(args.key ?? "");
    const value = String(args.value ?? "");
    if ((DEFERRED as readonly string[]).includes(key)) {
      throw new MontashError("E_NOT_IMPLEMENTED", `project set ${key} is not implemented yet`, {
        hint: "M1 で再スナップを実装 (re-snapping all _f/_smp fields lands in M1). For now, create a new project with `montash init --fps/--resolution`.",
        detail: { key, milestone: "M1" },
      });
    }
    if (!(SETTABLE as readonly string[]).includes(key)) {
      throw errors.usage(
        `unknown setting "${key}"`,
        `Settable keys: ${SETTABLE.join(", ")} (fps, resolution, sample_rate, channels: M1).`,
      );
    }

    // 状態変更は runMutation を通す（validate → 保存 → op 記録 → -m 即コミット。docs/08 §3.1）
    return runMutation(ctx, ({ project }) => {
      let before: unknown;
      let after: unknown;
      switch (key) {
        case "name": {
          if (!value.trim()) throw errors.usage("name must not be empty");
          before = project.name;
          after = value.trim();
          project.name = value.trim();
          break;
        }
        case "default_font": {
          if (!value.trim()) throw errors.usage("default_font must not be empty");
          before = project.settings.default_font;
          after = value.trim();
          project.settings.default_font = value.trim();
          break;
        }
        case "text_engine": {
          if (value !== "libass" && value !== "drawtext")
            throw errors.usage(`text_engine must be "libass" or "drawtext" (got "${value}")`);
          before = project.settings.text_engine;
          after = value;
          project.settings.text_engine = value;
          break;
        }
        default: {
          // background
          if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value) && !/^[a-zA-Z]+$/.test(value)) {
            throw errors.usage(`background must be a color like #000000 or a name like black (got "${value}")`);
          }
          before = project.settings.background;
          after = value;
          project.settings.background = value;
        }
      }
      const changed = before !== after;
      return {
        result: { key, before, after },
        summary: `set ${key} = ${JSON.stringify(after)}`,
        affects: { clips: [], range_f: null },
        changed,
        human: changed
          ? `${ctx.globals.dryRun ? "would set" : "set"} ${key}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`
          : `${key} is already ${JSON.stringify(after)} (no change)`,
      };
    });
  },
});
