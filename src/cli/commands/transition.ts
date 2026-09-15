/**
 * トランジション（docs/04 §8: `transition add|set|remove|list`、W-05）。
 *
 * `--type` は ffmpeg の `xfade` transition 名をそのまま受理する（`doctor` では検証しない。ffmpeg が弾く）。
 * `--mode handle`（既定）はクリップ位置を変えず、レンダー時に素材を `ceil(d/2)` / `d - ceil(d/2)` だけ
 * 延長して重ねる。`--mode overlap` は後続クリップを `duration_f` ぶん前へ詰める（全長が縮む）。
 */
import { findClip } from "../../core/clip-editing.ts";
import { assertIdAvailable } from "../../core/ids.ts";
import { loadProject } from "../../core/project.ts";
import {
  clipEndF,
  isMediaClip,
  type Project,
  type Track,
  type TrackClip,
  type Transition,
  TransitionSchema,
} from "../../core/schema.ts";
import { framesToSeconds } from "../../core/time.ts";
import { requireTrack } from "../../core/timeline.ts";
import { validateProject } from "../../core/validate.ts";
import { defineCommand } from "../define-command.ts";
import { errors, MontashError, type Warning } from "../errors.ts";
import { currentHead, runMutation } from "../mutate.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";
import { createIdAllocator } from "./clip-edit.ts";

/** トランジションの最小長（docs/04 §8） */
const MIN_DURATION_F = 2;

/** docs/04 §8 の別名（`crossfade` は ffmpeg の `fade` と同じ） */
const TYPE_ALIASES: Record<string, string> = { crossfade: "fade" };

/** `--type` を検証して ffmpeg の xfade transition 名に正規化する */
function normalizeType(value: unknown): string {
  const raw = String(value);
  if (!/^[a-z][a-z0-9_]*$/.test(raw))
    throw errors.usage(`--type ${JSON.stringify(raw)} is not a valid xfade transition name`);
  return TYPE_ALIASES[raw] ?? raw;
}

function describeTransition(project: Project, tr: Transition) {
  const fps = project.settings.fps;
  return {
    id: tr.id,
    track: tr.track,
    from: tr.from,
    to: tr.to,
    type: tr.type,
    duration_f: tr.duration_f,
    duration: framesToSeconds(tr.duration_f, fps),
    mode: tr.mode,
    audio: tr.audio,
  };
}

/** 隣接する（`from.end_f === to.start_f`）クリップ対を並び順に返す */
function cuts(track: Track): Array<{ from: TrackClip; to: TrackClip }> {
  const clips = [...track.clips].sort((a, b) => a.start_f - b.start_f);
  const out: Array<{ from: TrackClip; to: TrackClip }> = [];
  for (let i = 0; i + 1 < clips.length; i++) {
    const from = clips[i]!;
    const to = clips[i + 1]!;
    if (clipEndF(from) === to.start_f) out.push({ from, to });
  }
  return out;
}

/** `point` 以降のクリップをまとめて `delta` フレームずらす（`--mode overlap` の詰め・戻し） */
function shiftFrom(project: Project, point: number, delta: number): string[] {
  if (delta === 0) return [];
  const moved: string[] = [];
  for (const track of project.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips) {
      if (clip.start_f < point) continue;
      clip.start_f += delta;
      moved.push(clip.id);
    }
  }
  return moved;
}

/**
 * ハンドル不足を `E_INSUFFICIENT_HANDLE`（`detail.max_duration_f`）として投げ直す。
 * runMutation の validate でも捕まるが、最大 duration を detail の一段目に載せたいのでここで先に見る。
 */
function assertHandles(project: Project): void {
  const result = validateProject(project, {});
  const issue = result.errors.find((e) => e.code === "E_INSUFFICIENT_HANDLE");
  if (issue)
    throw new MontashError(issue.code, issue.message, {
      ...(issue.hint !== undefined ? { hint: issue.hint } : {}),
      ...(issue.detail !== undefined ? { detail: issue.detail } : {}),
    });
}

/** `--duration` を整数フレームに解決する */
function durationFrames(project: Project, input: unknown, warnings: Warning[]): number {
  const parsed = parseTimeInput(String(input), project.settings.fps, { allowRelative: false, allowEnd: false });
  if (parsed.warning) warnings.push(parsed.warning);
  const frames = resolveAbsolute(parsed, { fps: project.settings.fps });
  if (frames < MIN_DURATION_F)
    throw errors.usage(`--duration must be at least ${MIN_DURATION_F} frames (got f:${frames})`);
  return frames;
}

/** `--mode overlap` にするとき、後続を `duration_f` ぶん前へ詰める */
function applyOverlap(project: Project, to: TrackClip, delta: number): string[] {
  return shiftFrom(project, to.start_f, delta);
}

/**
 * リンクされた音声クリップの対（`c3`/`c5` → `c4`/`c6`）。
 * `mode: overlap` では音声クリップも重なるので、docs/05 §14.4 の重なり検査を通すために
 * 音声トラック側にも対になるトランジション（ID は `t3a` のように末尾 a。ADR-12 の命名）を置く。
 */
function linkedPair(project: Project, tr: Transition): { track: Track; from: TrackClip; to: TrackClip } | null {
  const from = project.tracks.flatMap((t) => t.clips).find((c) => c.id === tr.from);
  const to = project.tracks.flatMap((t) => t.clips).find((c) => c.id === tr.to);
  if (!from || !to || !isMediaClip(from) || !isMediaClip(to) || !from.link || !to.link) return null;
  for (const track of project.tracks) {
    const a = track.clips.find((c) => c.id === from.link);
    const b = track.clips.find((c) => c.id === to.link);
    if (a && b) return { track, from: a, to: b };
  }
  return null;
}

/** `tr` に対応する音声側のトランジション */
function findMirror(project: Project, tr: Transition): Transition | undefined {
  const pair = linkedPair(project, tr);
  if (!pair) return undefined;
  return project.transitions.find((t) => t.from === pair.from.id && t.to === pair.to.id);
}

/** overlap モードのトランジションに、音声側の対を作る（既にあれば内容を揃える） */
function syncMirror(project: Project, tr: Transition): void {
  const existing = findMirror(project, tr);
  if (tr.mode !== "overlap") {
    if (existing) project.transitions = project.transitions.filter((t) => t.id !== existing.id);
    return;
  }
  const pair = linkedPair(project, tr);
  if (!pair) return;
  if (existing) {
    existing.type = tr.type;
    existing.duration_f = tr.duration_f;
    existing.mode = tr.mode;
    existing.audio = tr.audio;
    return;
  }
  project.transitions.push(
    TransitionSchema.parse({
      id: `${tr.id}a`,
      track: pair.track.id,
      from: pair.from.id,
      to: pair.to.id,
      type: tr.type,
      duration_f: tr.duration_f,
      mode: tr.mode,
      audio: tr.audio,
    }),
  );
}

export const transitionAdd = defineCommand({
  path: "transition add",
  summary: "add an xfade transition between two adjacent clips",
  workflows: ["W-05"],
  mutates: true,
  options: {
    between: { type: "array", describe: "the two clip IDs to join: --between c1 c2" },
    track: { type: "string", describe: "track ID (with --all-cuts or --at-cut)" },
    "all-cuts": { type: "boolean", describe: "add one transition at every cut on --track" },
    "at-cut": { type: "string", describe: "add one transition at the cut on this timeline position", time: true },
    type: {
      type: "string",
      describe: "xfade transition name (fade, dissolve, wipeleft, circleopen ...)",
      required: true,
    },
    duration: { type: "string", describe: "transition length", time: true, required: true },
    mode: {
      type: "string",
      describe: "how the overlap is produced",
      choices: ["handle", "overlap"],
      default: "handle",
    },
    audio: { type: "string", describe: "linked audio handling", choices: ["crossfade", "cut"], default: "crossfade" },
    id: { type: "string", describe: "explicit transition ID" },
  },
  examples: [
    { cmd: "montash transition add --track V1 --all-cuts --type crossfade --duration 0.5" },
    { cmd: "montash transition add --between c1 c2 --type wipeleft --duration f:12" },
  ],
  async handler(ctx, args) {
    const selectors = [args.between !== undefined, Boolean(args.allCuts), args.atCut !== undefined].filter(Boolean);
    if (selectors.length !== 1) throw errors.usage("use exactly one of --between, --all-cuts or --at-cut");
    if (args.allCuts && args.track === undefined) throw errors.usage("--all-cuts needs --track");
    const mode = String(args.mode ?? "handle") as "handle" | "overlap";
    const audio = String(args.audio ?? "crossfade") as "crossfade" | "cut";
    const type = normalizeType(args.type);

    return runMutation(ctx, async ({ dir, project }) => {
      const warnings: Warning[] = [];
      const duration = durationFrames(project, args.duration, warnings);
      // 対象の編集点を選ぶ
      const pairs: Array<{ track: Track; from: TrackClip; to: TrackClip }> = [];
      if (args.between !== undefined) {
        const ids = (args.between as unknown[]).map(String);
        if (ids.length !== 2) throw errors.usage("--between takes exactly two clip IDs");
        const a = findClip(project, ids[0]!);
        const b = findClip(project, ids[1]!);
        if (a.track.id !== b.track.id) throw errors.usage("--between clips must be on the same track");
        pairs.push({ track: a.track, from: a.clip, to: b.clip });
      } else if (args.allCuts) {
        const track = requireTrack(project, String(args.track));
        for (const cut of cuts(track)) pairs.push({ track, ...cut });
        if (!pairs.length) throw errors.usage(`track "${track.id}" has no adjacent clip pair to join`);
      } else {
        const parsed = parseTimeInput(String(args.atCut), project.settings.fps, { allowRelative: false });
        if (parsed.warning) warnings.push(parsed.warning);
        const frame = resolveAbsolute(parsed, { fps: project.settings.fps });
        const tracks = args.track !== undefined ? [requireTrack(project, String(args.track))] : project.tracks;
        for (const track of tracks) {
          if (track.kind !== "video") continue;
          for (const cut of cuts(track)) if (clipEndF(cut.from) === frame) pairs.push({ track, ...cut });
        }
        if (!pairs.length) throw errors.usage(`no cut found at f:${frame}`);
        if (pairs.length > 1) throw errors.usage(`f:${frame} is a cut on several tracks; add --track to disambiguate`);
      }
      for (const pair of pairs) {
        if (pair.track.locked)
          throw new MontashError("E_TRACK_LOCKED", `track "${pair.track.id}" is locked`, {
            hint: `Run \`montash track lock ${pair.track.id} --off\` first.`,
          });
        if (!isMediaClip(pair.from) || !isMediaClip(pair.to)) throw errors.usage("transitions join media clips only");
        const existing = project.transitions.find((t) => t.from === pair.from.id && t.to === pair.to.id);
        if (existing)
          throw new MontashError("E_ID_EXISTS", `a transition already joins "${pair.from.id}" and "${pair.to.id}"`, {
            hint: `Use \`montash transition set ${existing.id}\` to change it.`,
            detail: { transition: existing.id },
          });
      }
      if (args.id !== undefined) {
        if (pairs.length > 1) throw errors.usage("--id cannot be used with --all-cuts");
        assertIdAvailable(project, String(args.id));
      }

      const nextId = await createIdAllocator(ctx, dir, project);
      const created: Transition[] = [];
      for (const pair of pairs) {
        const id = args.id !== undefined ? String(args.id) : await nextId("t");
        created.push(
          TransitionSchema.parse({
            id,
            track: pair.track.id,
            from: pair.from.id,
            to: pair.to.id,
            type,
            duration_f: duration,
            mode,
            audio,
          }),
        );
      }
      project.transitions.push(...created);
      // overlap は後ろの編集点から詰める（前を先に詰めると後ろの編集点の位置が動く）
      if (mode === "overlap") {
        for (let i = pairs.length - 1; i >= 0; i--) applyOverlap(project, pairs[i]!.to, -duration);
        for (const tr of created) syncMirror(project, tr);
      } else assertHandles(project);

      return {
        result: { transitions: created.map((t) => describeTransition(project, t)) },
        warnings,
        summary: `add ${created.length} ${type} transition(s) of f:${duration}`,
        affects: { clips: pairs.flatMap((p) => [p.from.id, p.to.id]), range_f: null },
        human: created.map((t) => `${t.id}  ${t.from} -> ${t.to}  ${t.type}  f:${t.duration_f}  ${t.mode}`).join("\n"),
      };
    });
  },
});

function requireTransition(project: Project, id: string): Transition {
  const found = project.transitions.find((t) => t.id === id);
  if (!found)
    throw new MontashError("E_TRANSITION_NOT_FOUND", `transition "${id}" not found`, {
      hint: "Run `montash transition list --json` to see the current transitions.",
      detail: { transition: id, known: project.transitions.map((t) => t.id) },
    });
  return found;
}

export const transitionSet = defineCommand({
  path: "transition set",
  summary: "change a transition's type, length, mode or audio handling",
  workflows: ["W-05"],
  mutates: true,
  positionals: [{ name: "id", describe: "transition ID", required: true }],
  options: {
    type: { type: "string", describe: "xfade transition name" },
    duration: { type: "string", describe: "transition length", time: true },
    mode: { type: "string", describe: "handle or overlap", choices: ["handle", "overlap"] },
    audio: { type: "string", describe: "crossfade or cut", choices: ["crossfade", "cut"] },
  },
  examples: [{ cmd: "montash transition set t2 --type wipeleft --duration 0.8" }],
  async handler(ctx, args) {
    if (args.type === undefined && args.duration === undefined && args.mode === undefined && args.audio === undefined)
      throw errors.usage("specify at least one of --type, --duration, --mode or --audio");
    return runMutation(ctx, ({ project }) => {
      const warnings: Warning[] = [];
      const tr = requireTransition(project, String(args.id));
      const to = findClip(project, tr.to).clip;
      const beforeMode = tr.mode;
      const beforeDuration = tr.duration_f;
      if (args.type !== undefined) tr.type = normalizeType(args.type);
      if (args.duration !== undefined) tr.duration_f = durationFrames(project, args.duration, warnings);
      if (args.mode !== undefined) tr.mode = String(args.mode) as "handle" | "overlap";
      if (args.audio !== undefined) tr.audio = String(args.audio) as "crossfade" | "cut";
      // overlap は重なり幅がそのまま duration_f なので、差分だけ後続を動かす
      const overlapBefore = beforeMode === "overlap" ? beforeDuration : 0;
      const overlapAfter = tr.mode === "overlap" ? tr.duration_f : 0;
      const moved = shiftFrom(project, to.start_f, overlapBefore - overlapAfter);
      syncMirror(project, tr);
      if (tr.mode === "handle") assertHandles(project);
      return {
        result: { transition: describeTransition(project, tr) },
        warnings,
        summary: `set transition ${tr.id}`,
        affects: { clips: [tr.from, tr.to, ...moved], range_f: null },
        human: `${tr.id}  ${tr.from} -> ${tr.to}  ${tr.type}  f:${tr.duration_f}  ${tr.mode}`,
      };
    });
  },
});

export const transitionRemove = defineCommand({
  path: "transition remove",
  summary: "remove a transition (overlap mode restores the original spacing)",
  workflows: ["W-05"],
  mutates: true,
  positionals: [{ name: "id", describe: "transition ID", required: true }],
  async handler(ctx, args) {
    return runMutation(ctx, ({ project }) => {
      const tr = requireTransition(project, String(args.id));
      const to = findClip(project, tr.to).clip;
      const moved = tr.mode === "overlap" ? shiftFrom(project, to.start_f, tr.duration_f) : [];
      const mirror = findMirror(project, tr);
      project.transitions = project.transitions.filter((t) => t.id !== tr.id && t.id !== mirror?.id);
      return {
        result: { transition: tr.id, moved_clips: moved },
        summary: `remove transition ${tr.id}`,
        affects: { clips: [tr.from, tr.to, ...moved], range_f: null },
        human: `removed ${tr.id}`,
      };
    });
  },
});

export const transitionList = defineCommand({
  path: "transition list",
  summary: "list the transitions on the timeline",
  workflows: ["W-05"],
  options: { track: { type: "string", describe: "only this track" } },
  async handler(ctx, args) {
    const dir = ctx.requireProjectDir();
    const project = await loadProject(dir);
    const rows = project.transitions
      .filter((t) => args.track === undefined || t.track === String(args.track))
      .map((t) => describeTransition(project, t));
    return {
      result: { transitions: rows },
      head: await currentHead(dir),
      human:
        rows
          .map((t) => `${t.id}  ${t.track}  ${t.from} -> ${t.to}  ${t.type}  f:${t.duration_f}  ${t.mode}  ${t.audio}`)
          .join("\n") || "no transitions",
    };
  },
});
