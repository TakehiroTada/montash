import { timelineDurationF } from "../../core/assets.ts";
import { loadProject } from "../../core/project.ts";
import { clipEndF } from "../../core/schema.ts";
import { defineCommand } from "../define-command.ts";
import { errors, type Warning } from "../errors.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";
import { describeClip } from "./clip.ts";
import { timelineSummary } from "./project.ts";

export const timelineShow = defineCommand({
  path: "timeline show",
  summary: "show tracks, clips and timeline duration",
  workflows: ["W-03", "W-04"],
  options: {
    from: { type: "string", describe: "range start", time: true },
    to: { type: "string", describe: "range end", time: true },
    ascii: { type: "boolean", describe: "show a compact timeline" },
  },
  async handler(ctx, args) {
    const project = await loadProject(ctx.requireProjectDir());
    const warnings: Warning[] = [];
    const time = (value: string) => {
      const parsed = parseTimeInput(value, project.settings.fps, { allowRelative: false });
      if (parsed.warning) warnings.push(parsed.warning);
      return resolveAbsolute(parsed, { fps: project.settings.fps, end: timelineDurationF(project) });
    };
    const from = time(String(args.from ?? "0"));
    const to = time(String(args.to ?? "end"));
    if (to < from) throw errors.usage("--to must be at or after --from");
    const tracks = project.tracks.map((t) => ({
      ...t,
      clips: [...t.clips]
        .sort((a, b) => a.start_f - b.start_f)
        .filter((c) => c.start_f < to && clipEndF(c) > from)
        .map((c, i) => describeClip(c, t.id, i + 1, project.settings.fps)),
    }));
    const summary = timelineSummary(project);
    return {
      result: { ...summary, tracks, transitions: project.transitions },
      timeline: summary,
      warnings,
      human: [
        `${summary.duration_tc}  (${summary.duration_f} frames)`,
        ...tracks.map(
          (t) =>
            `${t.id}${t.muted ? " (muted)" : ""} |${t.clips.map((c) => `${c.id}[${c.start_f}..${c.end_f}]`).join(" | ")}|`,
        ),
      ].join("\n"),
    };
  },
});
