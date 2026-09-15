import { clipAssetId, timelineDurationF } from "../../core/assets.ts";
import { addClip, assertSourceRange } from "../../core/clip-create.ts";
import { loadProject } from "../../core/project.ts";
import { clipDurationF, clipEndF, type TrackClip } from "../../core/schema.ts";
import { framesToSeconds } from "../../core/time.ts";
import { requireTrack, trackEnd } from "../../core/timeline.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning, warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";
import { requireAsset } from "./assets.ts";
import { createIdAllocator } from "./clip-edit.ts";

export const clipAdd = defineCommand({
  path: "clip add",
  summary: "place a trimmed asset, linking video and audio clips",
  workflows: ["W-03"],
  mutates: true,
  options: {
    asset: { type: "string", describe: "asset ID", required: true },
    track: { type: "string", describe: "target track (V1 for video, A1 for audio)" },
    in: { type: "string", describe: "source in point; negative means from asset end", time: true },
    out: { type: "string", describe: "source out point", time: true },
    duration: { type: "string", describe: "duration instead of --out", time: true },
    at: { type: "string", describe: "timeline position (default: end)", time: true },
    after: { type: "string", describe: "place immediately after a clip" },
    before: { type: "string", describe: "place immediately before a clip in a free interval" },
    "video-only": { type: "boolean", describe: "place video without linked audio" },
    "audio-only": { type: "boolean", describe: "place audio only" },
    id: { type: "string", describe: "explicit primary clip ID" },
    label: { type: "string", describe: "clip label" },
    "on-overlap": { type: "string", describe: "overlap policy (M1: error)", choices: ["error"], default: "error" },
  },
  examples: [
    {
      cmd: "montash clip add --asset clip_a --track V1 --in 2 --out 14.5",
      note: "place 00:02-00:14.5 of clip_a at the end of V1",
    },
    { cmd: "montash clip add --asset clip_b --at end" },
    { cmd: "montash clip add --asset bgm --track A2 --at 0 --audio-only", note: "background music from the head" },
  ],
  async handler(ctx, args) {
    if (args.out !== undefined && args.duration !== undefined) throw errors.usage("use either --out or --duration");
    if ([args.at, args.after, args.before].filter((v) => v !== undefined).length > 1)
      throw errors.usage("use only one of --at, --after, --before");
    if (args.videoOnly && args.audioOnly) throw errors.usage("--video-only and --audio-only are mutually exclusive");
    return runMutation(ctx, async ({ project, dir, fps }) => {
      const asset = requireAsset(project, String(args.asset));
      const audioOnly = Boolean(args.audioOnly) || asset.type === "audio";
      const hasAudio = (asset.type === "video" || asset.type === "audio") && Boolean(asset.audio);
      if (
        !["video", "audio", "image"].includes(asset.type) ||
        (audioOnly && !hasAudio) ||
        (args.videoOnly && asset.type === "audio")
      )
        throw errors.usage(`asset ${asset.id} does not have the requested media stream`);
      const track = requireTrack(project, String(args.track ?? (audioOnly ? "A1" : "V1")));
      if (track.kind !== (audioOnly ? "audio" : "video"))
        throw errors.usage(`track ${track.id} has incompatible kind ${track.kind}`);
      const warnings: Warning[] = [];
      const length = asset.duration_f ?? undefined;
      const time = (input: string, end?: number, duration = false) => {
        const parsed = parseTimeInput(input, fps, {
          allowRelative: !duration && input.startsWith("-"),
          allowEnd: !duration,
          allowTimeline: duration,
        });
        if (parsed.warning) warnings.push(parsed.warning);
        return resolveAbsolute(parsed, { fps, end, current: end, timelineLength: timelineDurationF(project) });
      };
      const inF = args.in === undefined ? 0 : time(String(args.in), length);
      let outF =
        args.duration !== undefined
          ? inF + time(String(args.duration), undefined, true)
          : args.out !== undefined
            ? time(String(args.out), length)
            : asset.type === "image"
              ? inF + project.settings.default_image_duration_f
              : length;
      if (outF === undefined) throw errors.usage("asset duration is unknown; specify --out or --duration");
      if (length !== undefined && outF > length && args.duration !== undefined) {
        outF = length;
        warnings.push(warning("W_CLIP_SHORTER_THAN_REQUESTED", `clip shortened to asset end f:${length}`));
      }
      assertSourceRange(inF, outF, length);
      let startF = time(String(args.at ?? "end"), trackEnd(track));
      if (args.after !== undefined || args.before !== undefined) {
        const ref = track.clips.find((c) => c.id === String(args.after ?? args.before));
        if (!ref) throw new MontashError("E_CLIP_NOT_FOUND", `reference clip not found on ${track.id}`);
        startF = args.after !== undefined ? clipEndF(ref) : ref.start_f - (outF - inF);
      }
      if (startF < 0) throw errors.usage("placement starts before the timeline");
      const allocate = await createIdAllocator(ctx, dir, project, args.id ? [String(args.id)] : []);
      const { clip, linked } = await addClip(
        project,
        {
          asset: asset.id,
          track,
          start_f: startF,
          in_f: inF,
          out_f: outF,
          id: args.id === undefined ? undefined : String(args.id),
          label: args.label === undefined ? undefined : String(args.label),
          audioOnly,
          linkAudio: !audioOnly && hasAudio && !args.videoOnly,
        },
        allocate,
      );
      return {
        result: { clip, linked_clip: linked },
        summary: `add ${clip.id} (${asset.id}) on ${track.id} at f:${startF}`,
        affects: { clips: linked ? [clip.id, linked.id] : [clip.id], range_f: [startF, startF + outF - inF] },
        warnings,
        human: `${clip.id}  ${track.id}  f:${startF}..f:${startF + outF - inF}  ${asset.id}${linked ? ` (linked ${linked.id})` : ""}`,
      };
    });
  },
});

export function describeClip(clip: TrackClip, track: string, index: number, fps: { num: number; den: number }) {
  return {
    ...clip,
    asset: clipAssetId(clip),
    track,
    index,
    end_f: clipEndF(clip),
    duration_f: clipDurationF(clip),
    start: framesToSeconds(clip.start_f, fps),
    end: framesToSeconds(clipEndF(clip), fps),
    duration: framesToSeconds(clipDurationF(clip), fps),
  };
}

export const clipList = defineCommand({
  path: "clip list",
  summary: "list clips in track and timeline order",
  workflows: ["W-03", "W-04"],
  options: { track: { type: "string", describe: "track ID" }, asset: { type: "string", describe: "asset ID" } },
  examples: [
    { cmd: "montash clip list --track V1" },
    { cmd: "montash clip list --asset clip_a --json", note: "every clip cut from one asset" },
  ],
  async handler(ctx, args) {
    const project = await loadProject(ctx.requireProjectDir());
    const tracks = args.track ? [requireTrack(project, String(args.track))] : project.tracks;
    const clips = tracks
      .flatMap((t) =>
        [...t.clips]
          .sort((a, b) => a.start_f - b.start_f)
          .map((c, i) => describeClip(c, t.id, i + 1, project.settings.fps)),
      )
      .filter((c) => !args.asset || c.asset === args.asset);
    return {
      result: { clips },
      human:
        clips.map((c) => `${c.track}  ${c.id}  f:${c.start_f}..f:${c.end_f}  ${c.asset ?? ""}`).join("\n") ||
        "no clips",
    };
  },
});
