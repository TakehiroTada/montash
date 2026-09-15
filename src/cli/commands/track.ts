/**
 * トラック操作（docs/04 §5: `track add|list|remove|mute|lock|move`、W-07/W-08）。
 *
 * `tracks` は配列で、映像は後ろが上（合成順）。`--above <t>` は `<t>` の 1 つ後ろ、
 * `--below <t>` は `<t>` の位置に差し込む。`lock` したトラックは編集コマンドを拒否し、
 * 全トラックリップルの対象からも外れる（docs/04 §6a）。
 */
import { removeClips } from "../../core/clip-editing.ts";
import { loadProject } from "../../core/project.ts";
import type { Project, Track } from "../../core/schema.ts";
import { TrackSchema } from "../../core/schema.ts";
import { nextTrackId, requireTrack, trackEnd, trackIndex } from "../../core/timeline.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning } from "../errors.ts";
import { currentHead, runMutation } from "../mutate.ts";

function describeTrack(track: Track) {
  return {
    id: track.id,
    kind: track.kind,
    name: track.name ?? track.id,
    muted: track.muted,
    locked: track.locked,
    clip_count: track.clips.length,
    end_f: trackEnd(track),
  };
}

/** `--above` / `--below` から挿入位置（配列インデックス）を求める */
function placementIndex(project: Project, above: unknown, below: unknown, fallback: number): number {
  if (above !== undefined && below !== undefined) throw errors.usage("use either --above or --below");
  if (above !== undefined) return trackIndex(project, String(above)) + 1;
  if (below !== undefined) return trackIndex(project, String(below));
  return fallback;
}

export const trackAdd = defineCommand({
  path: "track add",
  summary: "add a video, audio or text track",
  workflows: ["W-07", "W-08"],
  mutates: true,
  options: {
    kind: { type: "string", describe: "track kind", choices: ["video", "audio", "text"], required: true },
    name: { type: "string", describe: "track name / ID (default: V2, A2, T1 ...)" },
    above: { type: "string", describe: "insert above this track (later in the compositing order)" },
    below: { type: "string", describe: "insert below this track" },
  },
  examples: [{ cmd: "montash track add --kind video --above V1" }],
  async handler(ctx, args) {
    const kind = String(args.kind) as "video" | "audio" | "text";
    return runMutation(ctx, ({ project }) => {
      const id = args.name === undefined ? nextTrackId(project, kind) : String(args.name);
      if (project.tracks.some((t) => t.id === id))
        throw new MontashError("E_ID_EXISTS", `track "${id}" already exists`, {
          hint: "Choose another --name, or omit it to let montash pick the next free one.",
          detail: { track: id },
        });
      // 位置指定が無ければ同じ種別の最後のトラックの直後に置く（V1, V2, A1 ... と並ぶ）
      const lastSameKind = project.tracks.map((t) => t.kind).lastIndexOf(kind);
      const index = placementIndex(
        project,
        args.above,
        args.below,
        lastSameKind < 0 ? project.tracks.length : lastSameKind + 1,
      );
      const track = TrackSchema.parse({ id, kind, name: id });
      project.tracks.splice(index, 0, track);
      return {
        result: { track: describeTrack(track), index },
        summary: `add ${kind} track ${id}`,
        affects: { clips: [], range_f: null },
        human: `${id}  ${kind}`,
      };
    });
  },
});

export const trackList = defineCommand({
  path: "track list",
  summary: "list tracks in compositing order",
  workflows: ["W-08"],
  async handler(ctx) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const tracks = project.tracks.map(describeTrack);
    return {
      result: { tracks },
      head: await currentHead(dir),
      human:
        tracks
          .map(
            (t) =>
              `${t.id}  ${t.kind}  ${t.clip_count} clip(s)${t.muted ? "  muted" : ""}${t.locked ? "  locked" : ""}`,
          )
          .join("\n") || "no tracks",
    };
  },
});

export const trackRemove = defineCommand({
  path: "track remove",
  summary: "remove a track (--force if it still holds clips)",
  workflows: ["W-08"],
  mutates: true,
  positionals: [{ name: "name", describe: "track ID", required: true }],
  options: { force: { type: "boolean", describe: "remove the track and its clips" } },
  async handler(ctx, args) {
    return runMutation(ctx, ({ project }) => {
      const warnings: Warning[] = [];
      const track = requireTrack(project, String(args.name));
      if (track.locked)
        throw new MontashError("E_TRACK_LOCKED", `track "${track.id}" is locked`, {
          hint: `Run \`montash track lock ${track.id} --off\` first.`,
        });
      if (track.clips.length > 0 && !args.force)
        throw errors.usage(
          `track "${track.id}" still holds ${track.clips.length} clip(s); pass --force to remove them too`,
        );
      const removed = new Set(track.clips.map((c) => c.id));
      removeClips(project, removed, warnings);
      project.tracks = project.tracks.filter((t) => t.id !== track.id);
      project.transitions = project.transitions.filter((t) => t.track !== track.id);
      delete project.audio.track_gain_db[track.id];
      project.audio.ducking = project.audio.ducking.filter((d) => d.target !== track.id && d.sidechain !== track.id);
      return {
        result: { track: track.id, removed_clips: [...removed] },
        warnings,
        summary: `remove track ${track.id}${removed.size ? ` with ${removed.size} clip(s)` : ""}`,
        affects: { clips: [...removed], range_f: null },
        human: `removed ${track.id}`,
      };
    });
  },
});

/** `mute` / `lock` は同じ形（`--off` で解除） */
function toggleCommand(path: "track mute" | "track lock", field: "muted" | "locked", summary: string) {
  return defineCommand({
    path,
    summary,
    workflows: ["W-08"],
    mutates: true,
    positionals: [{ name: "name", describe: "track ID", required: true }],
    options: { off: { type: "boolean", describe: `turn ${field} off again` } },
    async handler(ctx, args) {
      return runMutation(ctx, ({ project }) => {
        const track = requireTrack(project, String(args.name));
        const value = !args.off;
        if (track[field] === value)
          return {
            result: { track: describeTrack(track) },
            summary: `${track.id} ${field} already ${value}`,
            changed: false,
            human: `${track.id}  ${field}=${value}`,
          };
        track[field] = value;
        return {
          result: { track: describeTrack(track) },
          summary: `${value ? "" : "un"}${field === "muted" ? "mute" : "lock"} track ${track.id}`,
          affects: { clips: track.clips.map((c) => c.id), range_f: null },
          human: `${track.id}  ${field}=${value}`,
        };
      });
    },
  });
}

export const trackMute = toggleCommand("track mute", "muted", "mute a track (video: hidden, audio: silent)");
export const trackLock = toggleCommand("track lock", "locked", "lock a track against edits and ripples");

export const trackMove = defineCommand({
  path: "track move",
  summary: "reorder a track in the compositing order",
  workflows: ["W-08"],
  mutates: true,
  positionals: [{ name: "name", describe: "track ID", required: true }],
  options: {
    above: { type: "string", describe: "move above this track" },
    below: { type: "string", describe: "move below this track" },
  },
  async handler(ctx, args) {
    if (args.above === undefined && args.below === undefined) throw errors.usage("specify --above or --below");
    return runMutation(ctx, ({ project }) => {
      const track = requireTrack(project, String(args.name));
      const reference = String(args.above ?? args.below);
      if (reference === track.id) throw errors.usage("a track cannot be moved relative to itself");
      const from = trackIndex(project, track.id);
      let to = placementIndex(project, args.above, args.below, from);
      if (to > from) to -= 1; // 自分を抜いた分ずれる
      const unchanged = to === from;
      if (!unchanged) {
        project.tracks.splice(from, 1);
        project.tracks.splice(to, 0, track);
      }
      return {
        ...(unchanged ? { changed: false } : {}),
        result: { track: track.id, index: to, tracks: project.tracks.map((t) => t.id) },
        summary: `move track ${track.id} ${args.above !== undefined ? "above" : "below"} ${reference}`,
        affects: { clips: track.clips.map((c) => c.id), range_f: null },
        human: project.tracks.map((t) => t.id).join(" < "),
      };
    });
  },
});
