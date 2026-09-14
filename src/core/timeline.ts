import { MontashError } from "../cli/errors.ts";
import { clipEndF, type Project, type Track } from "./schema.ts";

export function requireTrack(project: Project, id: string): Track {
  const track = project.tracks.find((t) => t.id === id);
  if (!track)
    throw new MontashError("E_TRACK_NOT_FOUND", `track "${id}" not found`, {
      hint: "Use `montash timeline show` to list tracks.",
    });
  return track;
}

export function trackEnd(track: Track): number {
  return track.clips.reduce((end, clip) => Math.max(end, clipEndF(clip)), 0);
}

export function assertPlacement(track: Track, start: number, end: number): void {
  if (track.locked) throw new MontashError("E_TRACK_LOCKED", `track ${track.id} is locked`);
  const overlap = track.clips.find((c) => c.start_f < end && clipEndF(c) > start);
  if (overlap)
    throw new MontashError("E_CLIP_OVERLAP", `placement overlaps ${overlap.id} on ${track.id}`, {
      hint: "Use --at end or choose a free interval.",
      detail: { clip: overlap.id, track: track.id, start_f: start, end_f: end },
    });
}
