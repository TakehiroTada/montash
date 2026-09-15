/**
 * クリップ編集コマンド（docs/04 §6: `clip move|trim|split|delete|set`、W-04）。
 *
 * 状態変更はすべて `runMutation()` を通す（op 記録・`-m` 即コミット・`--dry-run`・validate はミドルウェア）。
 * 編集点より後ろを詰める／押し出す規則は core/ripple.ts（docs/04 §6a, ADR-16）。
 */
import { timelineDurationF } from "../../core/assets.ts";
import {
  assertUnlocked,
  type ClipLocation,
  clampFades,
  findClip,
  linkedGroup,
  removeClips,
  setClipDuration,
  sortClips,
  sourceLimitF,
  splitClipAt,
  trimClipHead,
} from "../../core/clip-editing.ts";
import { assertIdAvailable, existingIds, nextId, readIds } from "../../core/ids.ts";
import { parseRippleScope, type RippleScope, rippleTimeline } from "../../core/ripple.ts";
import {
  type Clip,
  ClipAudioSchema,
  ClipVideoSchema,
  clipDurationF,
  clipEndF,
  isMediaClip,
  type Project,
  type TrackClip,
} from "../../core/schema.ts";
import { assertPlacement, requireTrack } from "../../core/timeline.ts";
import type { CommandContext } from "../context.ts";
import { defineCommand, type OptionSpec, type PositionalSpec } from "../define-command.ts";
import { errors, MontashError, type Warning, warning } from "../errors.ts";
import { runMutation } from "../mutate.ts";
import { parseTimeInput, resolveAbsolute } from "../time-input.ts";

// ---------------------------------------------------------------------------
// 共通の引数定義とヘルパ
// ---------------------------------------------------------------------------

const clipIdPositional: PositionalSpec[] = [{ name: "id", describe: "clip ID", required: true }];

/** `--ripple` は値なしでも使えるよう string で受ける（docs/04 §6a） */
export const rippleOption: OptionSpec = {
  type: "string",
  describe: "ripple following elements: --ripple (all tracks), --ripple=all, --ripple=track",
};

const unlinkOption: OptionSpec = {
  type: "boolean",
  describe: "detach the linked audio/video clip and edit this clip alone",
};

const onOverlapOption: OptionSpec = {
  type: "string",
  describe: "what to do when the destination is occupied",
  choices: ["error", "overwrite", "push"],
  default: "error",
};

/** 時間表記（docs/04 §1.3）を絶対フレームに解決する。`W_SNAPPED` は warnings に載せる */
function makeTime(project: Project, warnings: Warning[]) {
  return (input: unknown, opts: { current?: number; end?: number; relative?: boolean } = {}): number => {
    const parsed = parseTimeInput(String(input), project.settings.fps, {
      allowRelative: opts.relative ?? true,
      allowEnd: opts.end !== undefined,
    });
    if (parsed.warning) warnings.push(parsed.warning);
    return resolveAbsolute(parsed, { fps: project.settings.fps, current: opts.current, end: opts.end });
  };
}

/** 結果 JSON に載せるクリップの位置情報 */
function describeRange(clip: TrackClip, track: string) {
  return {
    id: clip.id,
    track,
    start_f: clip.start_f,
    end_f: clipEndF(clip),
    duration_f: clipDurationF(clip),
    ...(isMediaClip(clip) ? { in_f: clip.in_f, out_f: clip.out_f, speed: clip.speed, link: clip.link } : {}),
  };
}

/**
 * ID を発行する関数を作る。`--dry-run` では `.montash/ids.json` を進めない（docs/04 §1.4）。
 * 既に project にある ID や同一コマンド内で発行済みの ID は飛ばす。
 */
export async function createIdAllocator(
  ctx: CommandContext,
  dir: string,
  project: Project,
  reserved: readonly string[] = [],
): Promise<(prefix?: string) => Promise<string>> {
  const used = existingIds(project);
  for (const id of reserved) used.add(id);
  let dryCounter = (await readIds(dir))?.counters.c ?? 1;
  return async (prefix = "c") => {
    for (;;) {
      const id = ctx.globals.dryRun ? `${prefix}${dryCounter++}` : await nextId(dir, prefix);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
}

/** 映像クリップに対応する音声トラック（V1 → A1）／その逆を引く */
function counterpartTrackId(trackId: string, fromKind: "video" | "audio" | "text"): string {
  return fromKind === "video" ? trackId.replace(/^V/, "A") : trackId.replace(/^A/, "V");
}

/** `--on-overlap overwrite`: [from, to) に掛かる既存クリップを削る */
function carveRange(
  project: Project,
  trackId: string,
  from: number,
  to: number,
  keep: ReadonlySet<string>,
  warnings: Warning[],
): void {
  const track = requireTrack(project, trackId);
  const removed = new Set<string>();
  for (const clip of [...track.clips]) {
    if (keep.has(clip.id)) continue;
    const start = clip.start_f;
    const end = clipEndF(clip);
    if (end <= from || start >= to) continue;
    if (start >= from && end <= to) {
      removed.add(clip.id);
    } else if (start < from && end > to) {
      throw new MontashError("E_NOT_IMPLEMENTED", `--on-overlap overwrite cannot carve the middle of "${clip.id}"`, {
        hint: `Split it first: \`montash clip split ${clip.id} --at f:${from}\`.`,
        detail: { clip: clip.id, range_f: [from, to] },
      });
    } else if (start < from) {
      setClipDuration(project, clip, from - start);
    } else {
      trimClipHead(clip, to - start);
      clip.start_f = to;
    }
  }
  removeClips(project, removed, warnings);
}

// ---------------------------------------------------------------------------
// clip move
// ---------------------------------------------------------------------------

export const clipMove = defineCommand({
  path: "clip move",
  summary: "move a clip (and its linked audio) in time or to another track",
  description:
    "Use --ripple to close the gap left behind and push the destination's following clips; that is how clips are reordered (docs/04 §6a).",
  workflows: ["W-04"],
  mutates: true,
  positionals: clipIdPositional,
  options: {
    to: { type: "string", describe: "absolute timeline position", time: true },
    by: { type: "string", describe: "signed timeline offset (+0.5, -f:15)", time: true },
    before: { type: "string", describe: "place immediately before this clip" },
    after: { type: "string", describe: "place immediately after this clip" },
    track: { type: "string", describe: "destination track" },
    "on-overlap": onOverlapOption,
    ripple: rippleOption,
    unlink: unlinkOption,
  },
  examples: [
    { cmd: "montash clip move c3 --before c2 --ripple", note: "reorder: put c3 in front of c2" },
    { cmd: "montash clip move c2 --by +f:15" },
  ],
  async handler(ctx, args) {
    const positions = [args.to, args.by, args.before, args.after].filter((v) => v !== undefined);
    if (positions.length > 1) throw errors.usage("use only one of --to, --by, --before, --after");
    if (positions.length === 0 && args.track === undefined)
      throw errors.usage("specify one of --to, --by, --before, --after or --track");
    const scope = parseRippleScope(args.ripple);
    const onOverlap = String(args.onOverlap ?? "error");

    return runMutation(ctx, ({ project }) => {
      const warnings: Warning[] = [];
      const time = makeTime(project, warnings);
      const group = linkedGroup(project, String(args.id), Boolean(args.unlink));
      const primary = group[0]!;
      const ids = new Set(group.map((g) => g.clip.id));
      const duration = clipDurationF(primary.clip);
      const oldStart = primary.clip.start_f;
      const oldTimeline = timelineDurationF(project);

      // 移動先トラック（リンク相手は対応する V/A トラックへ）
      const destination = args.track === undefined ? primary.track : requireTrack(project, String(args.track));
      assertUnlocked(destination);
      if (destination.kind !== primary.track.kind)
        throw errors.usage(
          `track "${destination.id}" is a ${destination.kind} track; "${args.id}" needs a ${primary.track.kind} track`,
        );
      const destinationIds = [destination.id];
      if (group[1]) {
        const partnerTrack =
          destination.id === primary.track.id
            ? group[1].track
            : requireTrack(project, counterpartTrackId(destination.id, primary.track.kind));
        assertUnlocked(partnerTrack);
        if (partnerTrack.kind !== group[1].track.kind)
          throw errors.usage(`no ${group[1].track.kind} track matching "${destination.id}" for the linked clip`);
        destinationIds.push(partnerTrack.id);
      }

      const referenceId = args.before ?? args.after;
      if (referenceId !== undefined && ids.has(String(referenceId)))
        throw errors.usage("cannot position a clip relative to itself or its linked clip");

      let start = oldStart;
      if (args.to !== undefined) start = time(args.to, { end: oldTimeline, relative: false });
      if (args.by !== undefined) {
        const parsed = parseTimeInput(String(args.by), project.settings.fps, { allowEnd: false });
        if (parsed.value.kind !== "relative") throw errors.usage("--by needs a signed offset such as +0.5 or -f:15");
        if (parsed.warning) warnings.push(parsed.warning);
        start = resolveAbsolute(parsed, { fps: project.settings.fps, current: oldStart });
      }

      // いったん外し、元の位置を詰めてから移動先を決める（参照クリップの座標が変わるため）
      for (const g of group) g.track.clips = g.track.clips.filter((c) => c.id !== g.clip.id);
      const moved = rippleTimeline(
        project,
        { point: oldStart, delta: -duration, scope, tracks: group.map((g) => g.track.id), exclude: ids },
        warnings,
      );

      if (referenceId !== undefined) {
        const reference = findClip(project, String(referenceId));
        if (reference.track.id !== destination.id)
          throw errors.usage(
            `reference clip "${reference.clip.id}" is on "${reference.track.id}", not "${destination.id}"`,
          );
        start =
          args.after !== undefined
            ? clipEndF(reference.clip)
            : scope === false
              ? reference.clip.start_f - duration
              : reference.clip.start_f;
      }
      if (start < 0)
        throw new MontashError("E_INVALID_TIME", `the clip would start before the timeline (f:${start})`, {
          hint: "Choose a position at or after f:0.",
        });

      // 移動先を空ける
      const end = start + duration;
      if (scope !== false || onOverlap === "push") {
        const pushScope: RippleScope = scope === false ? "all" : scope;
        moved.push(
          ...rippleTimeline(
            project,
            { point: start, delta: duration, scope: pushScope, tracks: destinationIds, exclude: ids },
            warnings,
          ),
        );
      } else if (onOverlap === "overwrite") {
        for (const trackId of destinationIds) carveRange(project, trackId, start, end, ids, warnings);
      }
      for (const trackId of destinationIds) assertPlacement(requireTrack(project, trackId), start, end);

      group.forEach((g, i) => {
        g.clip.start_f = start;
        requireTrack(project, destinationIds[i]!).clips.push(g.clip);
      });
      sortClips(project);

      const movedIds = [...new Set(moved)];
      return {
        result: {
          clip: describeRange(primary.clip, destinationIds[0]!),
          linked_clip: group[1] ? describeRange(group[1].clip, destinationIds[1]!) : null,
          moved_clips: movedIds,
        },
        warnings,
        summary: `move ${primary.clip.id} to ${destinationIds[0]} at f:${start}`,
        affects: {
          clips: [...ids, ...movedIds],
          range_f: [Math.min(oldStart, start), Math.max(oldTimeline, timelineDurationF(project))] as [number, number],
        },
        human: `${primary.clip.id}  ${destinationIds[0]}  f:${start}..f:${end}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// clip trim
// ---------------------------------------------------------------------------

export const clipTrim = defineCommand({
  path: "clip trim",
  summary: "trim a clip's source in/out points, optionally rippling the rest of the timeline",
  description:
    "--in +0.5 cuts half a second off the head, --out -1 a second off the tail. Without --ripple the clip keeps its start_f and leaves a gap (W_GAP_CREATED).",
  workflows: ["W-04"],
  mutates: true,
  positionals: clipIdPositional,
  options: {
    in: { type: "string", describe: "source in point (absolute or ±relative)", time: true },
    out: { type: "string", describe: "source out point (absolute or ±relative)", time: true },
    start: { type: "string", describe: "timeline start position", time: true },
    ripple: rippleOption,
    unlink: unlinkOption,
  },
  examples: [{ cmd: "montash clip trim c2 --in +0.5 --ripple", note: "cut 0.5s off the head and close the gap" }],
  async handler(ctx, args) {
    if (args.in === undefined && args.out === undefined && args.start === undefined)
      throw errors.usage("specify --in, --out or --start");
    const scope = parseRippleScope(args.ripple);

    return runMutation(ctx, ({ project }) => {
      const warnings: Warning[] = [];
      const time = makeTime(project, warnings);
      const group = linkedGroup(project, String(args.id), Boolean(args.unlink));
      const primary = group[0]!;
      const clip = primary.clip;
      if (!isMediaClip(clip) && (args.in !== undefined || args.out !== undefined))
        throw new MontashError("E_NOT_IMPLEMENTED", `clip "${clip.id}" has no source range to trim`, {
          hint: "Text and generator clips are repositioned with `clip move`.",
        });
      const ids = new Set(group.map((g) => g.clip.id));
      const oldStart = clip.start_f;
      const oldEnd = clipEndF(clip);
      const oldDuration = clipDurationF(clip);
      const oldTimeline = timelineDurationF(project);

      let inDelta = 0;
      let outDelta = 0;
      if (isMediaClip(clip)) {
        const limit = sourceLimitF(project, clip) ?? clip.out_f;
        const inF = args.in === undefined ? clip.in_f : time(args.in, { current: clip.in_f, end: limit });
        const outF = args.out === undefined ? clip.out_f : time(args.out, { current: clip.out_f, end: limit });
        if (outF - inF < 1)
          throw new MontashError(
            "E_TRIM_EXCEEDS_CLIP",
            `trimming "${clip.id}" to source f:${inF}..f:${outF} leaves less than one frame`,
            {
              hint: `Keep at least one frame (in <= f:${outF - 1}), or remove the clip with \`montash clip delete ${clip.id}\`.`,
              detail: { clip: clip.id, in_f: inF, out_f: outF },
            },
          );
        inDelta = inF - clip.in_f;
        outDelta = outF - clip.out_f;
      }
      const startF = args.start === undefined ? oldStart : time(args.start, { current: oldStart, end: oldTimeline });

      for (const g of group) {
        const c = g.clip;
        c.start_f = startF;
        if (!isMediaClip(c)) continue;
        c.in_f += inDelta;
        c.out_f += outDelta;
        const limit = sourceLimitF(project, c);
        if (c.in_f < 0 || c.out_f <= c.in_f || (limit !== null && c.out_f > limit))
          throw new MontashError(
            "E_RANGE_OUT_OF_ASSET",
            `trim puts "${c.id}" outside its source (f:${c.in_f}..f:${c.out_f}${limit === null ? "" : `, asset ends at f:${limit}`})`,
            { hint: `Choose 0 <= in < out${limit === null ? "" : ` <= f:${limit}`}.`, detail: { clip: c.id } },
          );
        clampFades(c, clipDurationF(c));
      }
      const delta = clipDurationF(clip) - oldDuration;

      // 編集点はクリップの（新しい）末尾。頭を切っても start_f は動かさない（docs/04 §6 clip trim）
      const point = delta < 0 ? oldEnd + delta : oldEnd;
      const moved = rippleTimeline(
        project,
        { point, delta, scope, tracks: group.map((g) => g.track.id), exclude: ids },
        warnings,
      );
      if (scope === false && delta < 0)
        warnings.push(
          warning("W_GAP_CREATED", `"${clip.id}" is now ${-delta} frame(s) shorter; a gap remains after f:${point}`, {
            hint: "Pass --ripple to close it, or run `montash timeline gaps --fill close`.",
            detail: { clip: clip.id, from_f: point, to_f: oldEnd },
          }),
        );
      sortClips(project);

      return {
        result: {
          clip: describeRange(clip, primary.track.id),
          linked_clip: group[1] ? describeRange(group[1].clip, group[1].track.id) : null,
          delta_f: delta,
          moved_clips: moved,
        },
        warnings,
        summary: `trim ${clip.id} to f:${clip.start_f}..f:${clipEndF(clip)}`,
        affects: {
          clips: [...ids, ...moved],
          range_f: [Math.min(point, startF), Math.max(oldTimeline, timelineDurationF(project))] as [number, number],
        },
        human: `${clip.id}  f:${clip.start_f}..f:${clipEndF(clip)}  (${delta >= 0 ? "+" : ""}${delta}f)`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// clip split（ADR-12: 前半が元 ID を維持）
// ---------------------------------------------------------------------------

export const clipSplit = defineCommand({
  path: "clip split",
  summary: "split a clip in two at a timeline position (the first half keeps the original ID)",
  description:
    "ADR-12: the first half keeps the original ID; only the second half gets a new one (read it from result.created.id).",
  workflows: ["W-04"],
  mutates: true,
  positionals: clipIdPositional,
  options: {
    at: { type: "string", describe: "timeline position to split at", required: true, time: true },
    "new-id": { type: "string", describe: "explicit ID for the second half" },
    unlink: unlinkOption,
  },
  examples: [{ cmd: "montash clip split c1 --at 00:00:08.000 --json" }],
  async handler(ctx, args) {
    return runMutation(ctx, async ({ project, dir }) => {
      const warnings: Warning[] = [];
      const time = makeTime(project, warnings);
      const group = linkedGroup(project, String(args.id), Boolean(args.unlink));
      const primary = group[0]!;
      const at = time(args.at, { current: primary.clip.start_f, end: timelineDurationF(project), relative: false });
      if (args.newId !== undefined) assertIdAvailable(project, String(args.newId));

      const allocate = await createIdAllocator(ctx, dir, project, args.newId ? [String(args.newId)] : []);
      const created: ClipLocation[] = [];
      for (const [i, g] of group.entries()) {
        const newId = i === 0 && args.newId !== undefined ? String(args.newId) : await allocate("c");
        created.push({ track: g.track, clip: splitClipAt(project, g, at, newId) });
      }
      // 前半同士・後半同士でリンクを張り直す（docs/04 §6 clip split）
      const [first, second] = created;
      if (first && second && isMediaClip(first.clip) && isMediaClip(second.clip)) {
        first.clip.link = second.clip.id;
        second.clip.link = first.clip.id;
      }
      sortClips(project);

      const kept = describeRange(primary.clip, primary.track.id);
      const createdDesc = describeRange(first!.clip, first!.track.id);
      return {
        result: {
          kept,
          created: createdDesc,
          linked: group[1] && second ? { kept: group[1].clip.id, created: second.clip.id } : null,
        },
        warnings,
        summary: `split ${primary.clip.id} at f:${at} (created ${createdDesc.id})`,
        affects: {
          clips: [...group.map((g) => g.clip.id), ...created.map((c) => c.clip.id)],
          range_f: [kept.start_f, createdDesc.end_f] as [number, number],
        },
        human: `${kept.id}  f:${kept.start_f}..f:${kept.end_f}  +  ${createdDesc.id}  f:${createdDesc.start_f}..f:${createdDesc.end_f}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// clip delete
// ---------------------------------------------------------------------------

export const clipDelete = defineCommand({
  path: "clip delete",
  summary: "delete clips, optionally closing the intervals they leave behind",
  workflows: ["W-04"],
  mutates: true,
  positionals: [{ name: "ids", describe: "clip IDs", required: true, variadic: true }],
  options: { ripple: rippleOption, unlink: unlinkOption },
  examples: [{ cmd: "montash clip delete c5 --ripple" }],
  async handler(ctx, args) {
    const scope = parseRippleScope(args.ripple);
    const requested = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String).filter((s) => s.length > 0);
    if (requested.length === 0) throw errors.usage("specify at least one clip ID");

    return runMutation(ctx, ({ project }) => {
      const warnings: Warning[] = [];
      const oldTimeline = timelineDurationF(project);
      const locations: ClipLocation[] = [];
      const ids = new Set<string>();
      for (const id of requested) {
        for (const g of linkedGroup(project, id, Boolean(args.unlink))) {
          if (ids.has(g.clip.id)) continue;
          ids.add(g.clip.id);
          locations.push(g);
        }
      }
      // 削除区間（重なる／隣接するものはまとめる）。トラックを跨ぐ同時刻の削除は 1 回だけ詰める
      const intervals: Array<[number, number]> = [];
      for (const { clip } of [...locations].sort((a, b) => a.clip.start_f - b.clip.start_f)) {
        const span: [number, number] = [clip.start_f, clipEndF(clip)];
        const last = intervals.at(-1);
        if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
        else intervals.push(span);
      }
      const tracks = [...new Set(locations.map((g) => g.track.id))];

      removeClips(project, ids, warnings);
      const moved: string[] = [];
      for (const [start, end] of [...intervals].reverse()) {
        moved.push(...rippleTimeline(project, { point: start, delta: start - end, scope, tracks }, warnings));
      }
      sortClips(project);

      const movedIds = [...new Set(moved)];
      return {
        result: { deleted: [...ids], moved_clips: movedIds },
        warnings,
        summary: `delete ${[...ids].join(", ")}${scope === false ? "" : " (ripple)"}`,
        affects: { clips: [...ids, ...movedIds], range_f: [intervals[0]?.[0] ?? 0, oldTimeline] as [number, number] },
        human: `deleted ${[...ids].join(", ")}`,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// clip set
// ---------------------------------------------------------------------------

/** 映像／音声パラメータを書き込む対象クリップ（リンク相手のうち該当ブロックを持つ方） */
function pickByBlock(group: ClipLocation[], block: "video" | "audio"): Clip {
  for (const g of group) {
    const clip = g.clip;
    if (isMediaClip(clip) && clip[block] !== undefined) return clip;
  }
  const first = group[0]?.clip;
  if (!first || !isMediaClip(first))
    throw new MontashError("E_NOT_IMPLEMENTED", "--volume / --opacity apply to media clips only");
  if (block === "video") first.video = ClipVideoSchema.parse({});
  else first.audio = ClipAudioSchema.parse({});
  return first;
}

export const clipSet = defineCommand({
  path: "clip set",
  summary: "set simple clip properties (speed, label, volume, opacity)",
  workflows: ["W-04"],
  mutates: true,
  positionals: clipIdPositional,
  options: {
    speed: { type: "number", describe: "playback speed (1 = normal, 1.5 = faster)" },
    "pitch-keep": { type: "boolean", describe: "keep the original pitch when changing speed" },
    label: { type: "string", describe: "human readable label" },
    volume: { type: "number", describe: "audio gain in dB" },
    opacity: { type: "number", describe: "video opacity, 0..1" },
    ripple: rippleOption,
    unlink: unlinkOption,
  },
  examples: [{ cmd: "montash clip set c2 --speed 1.5 --pitch-keep --ripple" }],
  async handler(ctx, args) {
    const touched = (["speed", "pitchKeep", "label", "volume", "opacity"] as const).filter(
      (k) => args[k] !== undefined,
    );
    if (touched.length === 0)
      throw errors.usage("specify at least one of --speed, --pitch-keep, --label, --volume, --opacity");
    const scope = parseRippleScope(args.ripple);

    return runMutation(ctx, ({ project }) => {
      const warnings: Warning[] = [];
      const group = linkedGroup(project, String(args.id), Boolean(args.unlink));
      const primary = group[0]!;
      const ids = new Set(group.map((g) => g.clip.id));
      const oldDuration = clipDurationF(primary.clip);
      const oldEnd = clipEndF(primary.clip);
      const oldTimeline = timelineDurationF(project);

      if (args.speed !== undefined) {
        const speed = Number(args.speed);
        if (!Number.isFinite(speed) || speed <= 0) throw errors.usage("--speed must be a positive number");
        for (const g of group) {
          if (!isMediaClip(g.clip))
            throw new MontashError("E_NOT_IMPLEMENTED", `clip "${g.clip.id}" has no playback speed`);
          g.clip.speed = speed;
          clampFades(g.clip, clipDurationF(g.clip));
        }
      }
      if (args.pitchKeep !== undefined) {
        for (const g of group) if (isMediaClip(g.clip)) g.clip.pitch_keep = Boolean(args.pitchKeep);
      }
      if (args.label !== undefined) primary.clip.label = String(args.label);
      if (args.volume !== undefined) {
        const db = Number(args.volume);
        if (!Number.isFinite(db)) throw errors.usage("--volume must be a number of dB");
        pickByBlock(group, "audio").audio!.gain_db = db;
      }
      if (args.opacity !== undefined) {
        const opacity = Number(args.opacity);
        if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
          throw errors.usage("--opacity must be between 0 and 1");
        pickByBlock(group, "video").video!.opacity = opacity;
      }

      const delta = clipDurationF(primary.clip) - oldDuration;
      const point = delta < 0 ? oldEnd + delta : oldEnd;
      const moved =
        delta === 0
          ? []
          : rippleTimeline(
              project,
              { point, delta, scope, tracks: group.map((g) => g.track.id), exclude: ids },
              warnings,
            );
      if (delta < 0 && scope === false)
        warnings.push(
          warning(
            "W_GAP_CREATED",
            `"${primary.clip.id}" is now ${-delta} frame(s) shorter; a gap remains after f:${point}`,
            { hint: "Pass --ripple to close it." },
          ),
        );
      sortClips(project);

      return {
        result: {
          clip: describeRange(primary.clip, primary.track.id),
          linked_clip: group[1] ? describeRange(group[1].clip, group[1].track.id) : null,
          moved_clips: moved,
        },
        warnings,
        summary: `set ${touched.join(", ")} on ${primary.clip.id}`,
        human: `${primary.clip.id}  ${touched.join(", ")}  f:${primary.clip.start_f}..f:${clipEndF(primary.clip)}`,
        affects: {
          clips: [...ids, ...moved],
          range_f: [primary.clip.start_f, Math.max(oldTimeline, timelineDurationF(project))] as [number, number],
        },
      };
    });
  },
});
