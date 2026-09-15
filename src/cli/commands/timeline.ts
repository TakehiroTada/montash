import { timelineDurationF } from "../../core/assets.ts";
import { sortClips } from "../../core/clip-editing.ts";
import { loadProject } from "../../core/project.ts";
import { rippleTimeline } from "../../core/ripple.ts";
import { clipEndF, GeneratorClipSchema, type Project } from "../../core/schema.ts";
import { framesToSeconds, framesToTimecode } from "../../core/time.ts";
import { assertPlacement, requireTrack } from "../../core/timeline.ts";
import { findVideoGaps, type Gap } from "../../core/validate.ts";
import { colorGenerator, holdGenerator } from "../../registry/generators.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";
import { describeClip } from "./clip.ts";
import { createIdAllocator } from "./clip-edit.ts";
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
  examples: [
    { cmd: "montash timeline show --ascii", note: "rough bar chart of every track" },
    { cmd: "montash timeline show --from 10 --to 25", note: "only that time range" },
  ],
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

/** ギャップ 1 件の出力形（docs/04 §1.3a: `_f` / 秒 / タイムコードを併記） */
function describeGap(gap: Gap, project: Project) {
  const fps = project.settings.fps;
  return {
    from_f: gap.from_f,
    to_f: gap.to_f,
    duration_f: gap.to_f - gap.from_f,
    from: framesToSeconds(gap.from_f, fps),
    to: framesToSeconds(gap.to_f, fps),
    from_tc: framesToTimecode(gap.from_f, fps),
    to_tc: framesToTimecode(gap.to_f, fps),
    duration: framesToSeconds(gap.to_f - gap.from_f, fps),
  };
}

export const timelineGaps = defineCommand({
  path: "timeline gaps",
  summary: "list intervals with no video, and optionally fill or close them",
  description:
    "--fill close removes the gaps by rippling everything after them (all tracks); --fill black inserts a background clip.",
  workflows: ["W-04"],
  mutates: true,
  options: {
    fill: { type: "string", describe: "how to fill the gaps", choices: ["close", "black", "hold"] },
    track: { type: "string", describe: "video track to put --fill black clips on (default: the first free one)" },
  },
  examples: [{ cmd: "montash timeline gaps --json" }, { cmd: "montash timeline gaps --fill close" }],
  async handler(ctx, args) {
    const fill = args.fill === undefined ? null : String(args.fill);
    if (fill === "hold")
      // `hold` はジェネレータレジストリには載っているが、フィルタグラフ側が未実装（docs/09 M3）
      throw new MontashError("E_NOT_IMPLEMENTED", `--fill ${holdGenerator.name} is not implemented yet`, {
        hint: "Use --fill black or --fill close; hold clips arrive with the generator work (docs/09 M3).",
      });

    return runMutation(ctx, async ({ project, dir }) => {
      const warnings: Warning[] = [];
      const gaps = findVideoGaps(project);
      const described = gaps.map((g) => describeGap(g, project));
      const human =
        described.map((g) => `f:${g.from_f}..f:${g.to_f}  (${g.duration_f} frames)`).join("\n") || "no gaps";

      if (fill === null || gaps.length === 0) {
        return { result: { gaps: described, filled: [] as unknown[] }, summary: "list gaps", changed: false, human };
      }

      const oldTimeline = timelineDurationF(project);
      const filled: unknown[] = [];
      if (fill === "close") {
        // 後ろから詰める（前を詰めると後続のギャップ座標がずれるため）
        for (const gap of [...gaps].reverse()) {
          rippleTimeline(project, { point: gap.from_f, delta: gap.from_f - gap.to_f, scope: "all" }, warnings);
          filled.push(describeGap(gap, project));
        }
      } else {
        const allocate = await createIdAllocator(ctx, dir, project);
        for (const gap of gaps) {
          const track = pickVideoTrack(project, gap, args.track);
          const clip = GeneratorClipSchema.parse({
            id: await allocate("c"),
            type: "generator",
            generator: colorGenerator.name,
            params: { color: project.settings.background },
            start_f: gap.from_f,
            duration_f: gap.to_f - gap.from_f,
            label: "gap fill",
          });
          assertPlacement(track, clip.start_f, clip.start_f + clip.duration_f);
          track.clips.push(clip);
          filled.push({ ...describeGap(gap, project), clip: clip.id, track: track.id });
        }
      }
      sortClips(project);
      const remaining = findVideoGaps(project).map((g) => describeGap(g, project));
      return {
        result: { gaps: remaining, filled },
        warnings,
        summary: `${fill} ${gaps.length} gap(s)`,
        affects: {
          clips: filled.flatMap((f) => (typeof f === "object" && f && "clip" in f ? [String(f.clip)] : [])),
          range_f: [gaps[0]!.from_f, oldTimeline] as [number, number],
        },
        human: remaining.length === 0 ? `${fill}: ${gaps.length} gap(s) resolved` : human,
      };
    });
  },
});

/** `--fill black` を置く映像トラック（指定が無ければギャップ区間が空いている最初のもの） */
function pickVideoTrack(project: Project, gap: Gap, requested: unknown) {
  if (requested !== undefined) {
    const track = requireTrack(project, String(requested));
    if (track.kind !== "video") throw errors.usage(`track "${track.id}" is not a video track`);
    return track;
  }
  const free = project.tracks.find(
    (t) => t.kind === "video" && !t.locked && !t.clips.some((c) => c.start_f < gap.to_f && clipEndF(c) > gap.from_f),
  );
  if (!free)
    throw errors.usage("no free video track for the gap fill; pass --track or add one with `montash track add`");
  return free;
}
