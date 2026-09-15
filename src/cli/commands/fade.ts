/**
 * 先頭／末尾フェード（docs/04 §8 `montash fade`、W-05）。
 *
 * トランジションではなく `tracks[].fade`（トラック全体）または `clip.video.fade` / `clip.audio.fade`
 * として保存する（docs/05 §7 の注記）。`--with-audio` はリンクされた音声側にも同じ長さを掛ける。
 */
import { findClip } from "../../core/clip-editing.ts";
import {
  ClipAudioSchema,
  ClipVideoSchema,
  isMediaClip,
  type Project,
  type Track,
  type TrackClip,
} from "../../core/schema.ts";
import { requireTrack } from "../../core/timeline.ts";
import { defineCommand } from "../define-command.ts";
import { errors, type Warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";

function frames(project: Project, input: unknown, warnings: Warning[]): number {
  const parsed = parseTimeInput(String(input), project.settings.fps, { allowRelative: false, allowEnd: false });
  if (parsed.warning) warnings.push(parsed.warning);
  return resolveAbsolute(parsed, { fps: project.settings.fps });
}

/** `clip.video` / `clip.audio` を（無ければ既定値で）用意する */
function ensureVideo(clip: TrackClip) {
  const c = clip as { video?: unknown };
  if (!c.video) c.video = ClipVideoSchema.parse({});
  return c.video as { fade: { in_f: number; out_f: number; color: string } };
}
function ensureAudio(clip: TrackClip) {
  const c = clip as { audio?: unknown };
  if (!c.audio) c.audio = ClipAudioSchema.parse({});
  return c.audio as { fade: { in_f: number; out_f: number; curve: string } };
}

/** 映像トラックのクリップがリンクしている音声トラック（無ければ V1 → A1 の対応） */
function linkedAudioTracks(project: Project, track: Track): Track[] {
  const out = new Set<Track>();
  for (const clip of track.clips) {
    if (!isMediaClip(clip) || !clip.link) continue;
    for (const other of project.tracks) {
      if (other.kind !== "audio") continue;
      if (other.clips.some((c) => c.id === clip.link)) out.add(other);
    }
  }
  if (!out.size) {
    const counterpart = project.tracks.find((t) => t.kind === "audio" && t.id === track.id.replace(/^V/, "A"));
    if (counterpart) out.add(counterpart);
  }
  return [...out];
}

export const fade = defineCommand({
  path: "fade",
  summary: "fade a track or a clip in at the head and out at the tail",
  workflows: ["W-05"],
  mutates: true,
  options: {
    track: { type: "string", describe: "track ID (default: the lowest video track)" },
    clip: { type: "string", describe: "clip ID instead of a whole track" },
    in: { type: "string", describe: "fade-in length", time: true },
    out: { type: "string", describe: "fade-out length", time: true },
    color: { type: "string", describe: "fade colour", choices: ["black", "white"], default: "black" },
    "with-audio": { type: "boolean", describe: "apply the same fade to the linked audio" },
  },
  examples: [{ cmd: "montash fade --track V1 --in 1.0 --out 2.0 --with-audio" }],
  async handler(ctx, args) {
    if (args.in === undefined && args.out === undefined) throw errors.usage("specify --in, --out or both");
    if (args.track !== undefined && args.clip !== undefined) throw errors.usage("use either --track or --clip");
    const color = String(args.color ?? "black");
    return runMutation(ctx, ({ project }) => {
      const warnings: Warning[] = [];
      const inF = args.in === undefined ? undefined : frames(project, args.in, warnings);
      const outF = args.out === undefined ? undefined : frames(project, args.out, warnings);
      const applyVideo = (fade: { in_f: number; out_f: number; color: string }) => {
        if (inF !== undefined) fade.in_f = inF;
        if (outF !== undefined) fade.out_f = outF;
        fade.color = color;
      };
      const applyAudio = (fade: { in_f: number; out_f: number }) => {
        if (inF !== undefined) fade.in_f = inF;
        if (outF !== undefined) fade.out_f = outF;
      };

      if (args.clip !== undefined) {
        const { track, clip } = findClip(project, String(args.clip));
        if (!isMediaClip(clip)) throw errors.usage("fade works on media clips only");
        const targets: string[] = [clip.id];
        if (track.kind === "audio") applyAudio(ensureAudio(clip).fade);
        else applyVideo(ensureVideo(clip).fade);
        if (args.withAudio) {
          const linked = clip.link ? project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.link) : undefined;
          if (linked) {
            applyAudio(ensureAudio(linked).fade);
            targets.push(linked.id);
          } else applyAudio(ensureAudio(clip).fade);
        }
        return {
          result: { tracks: [track.id], clips: targets, in_f: inF ?? null, out_f: outF ?? null, color },
          warnings,
          summary: `fade clip ${clip.id}`,
          affects: { clips: targets, range_f: null },
          human: `${clip.id}  in f:${inF ?? "-"}  out f:${outF ?? "-"}`,
        };
      }

      const track =
        args.track !== undefined
          ? requireTrack(project, String(args.track))
          : project.tracks.find((t) => t.kind === "video" && t.clips.length);
      if (!track) throw errors.usage("no video track to fade; pass --track or --clip");
      const tracks: Track[] = [track];
      applyVideo(track.fade);
      if (args.withAudio && track.kind !== "audio") {
        for (const audio of linkedAudioTracks(project, track)) {
          applyVideo(audio.fade);
          tracks.push(audio);
        }
      }
      return {
        result: { tracks: tracks.map((t) => t.id), clips: [], in_f: inF ?? null, out_f: outF ?? null, color },
        warnings,
        summary: `fade ${tracks.map((t) => t.id).join(", ")} in f:${inF ?? 0} out f:${outF ?? 0}`,
        affects: { clips: tracks.flatMap((t) => t.clips.map((c) => c.id)), range_f: null },
        human: tracks.map((t) => `${t.id}  in f:${t.fade.in_f}  out f:${t.fade.out_f}`).join("\n"),
      };
    });
  },
});
