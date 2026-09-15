/**
 * トラックとタイムラインの基本操作（docs/04 §5, §7、docs/05 §6）。
 *
 * `tracks` は配列で、映像は後ろが上（合成順）。`--above` は配列の後ろ側、`--below` は前側を指す。
 */
import { MontashError } from "../cli/errors.ts";
import { clipEndF, type Project, type Track, type TrackKind } from "./schema.ts";

export function requireTrack(project: Project, id: string): Track {
  const track = project.tracks.find((t) => t.id === id);
  if (!track)
    throw new MontashError("E_TRACK_NOT_FOUND", `track "${id}" not found`, {
      hint: `Use \`montash track list\` to see the tracks (${project.tracks.map((t) => t.id).join(", ") || "none"}).`,
      detail: { track: id, known_tracks: project.tracks.map((t) => t.id) },
    });
  return track;
}

/** トラックの配列上の位置。無ければ E_TRACK_NOT_FOUND */
export function trackIndex(project: Project, id: string): number {
  const index = project.tracks.findIndex((t) => t.id === id);
  if (index < 0) requireTrack(project, id);
  return index;
}

export function trackEnd(track: Track): number {
  return track.clips.reduce((end, clip) => Math.max(end, clipEndF(clip)), 0);
}

export function assertPlacement(track: Track, start: number, end: number): void {
  if (track.locked) throw new MontashError("E_TRACK_LOCKED", `track ${track.id} is locked`);
  const overlap = track.clips.find((c) => c.start_f < end && clipEndF(c) > start);
  if (overlap)
    throw new MontashError("E_CLIP_OVERLAP", `placement overlaps ${overlap.id} on ${track.id}`, {
      hint: "Use --at end, choose a free interval, or pass --ripple / --on-overlap.",
      detail: { clip: overlap.id, track: track.id, start_f: start, end_f: end },
    });
}

/** 種別ごとの ID プレフィックス（docs/04 §1.4: `V1` / `A1` / `T1`） */
export function trackPrefix(kind: TrackKind): string {
  return kind === "video" ? "V" : kind === "audio" ? "A" : "T";
}

/** 種別ごとの次の既定トラック名（`V1`, `V2`, ...） */
export function nextTrackId(project: Project, kind: TrackKind): string {
  const prefix = trackPrefix(kind);
  let max = 0;
  for (const track of project.tracks) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(track.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}
