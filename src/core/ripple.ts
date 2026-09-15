/**
 * リップル（docs/04 §6a, ADR-16）。
 *
 * 編集点 `point`（= `p_f`）と変化量 `delta`（= `delta_f`。削除・短縮は負、挿入・延長は正）に対して:
 *
 * | 対象 | 規則 |
 * |------|------|
 * | `start_f >= p_f` の要素 | `start_f += delta_f` |
 * | 編集点を跨ぐ要素 | 削除: 尺を縮める / 挿入: 余白か `loop` があれば伸ばし、無ければ `W_RIPPLE_SPAN_NOT_EXTENDED` |
 * | 編集点を跨ぐトランジション | 削除して `W_TRANSITION_REMOVED` |
 * | `locked: true` のトラック | 対象外 |
 * | `--ripple=track` | 当該トラック（とリンク先の音声トラック）のみ |
 *
 * 既定（`--ripple` / `--ripple=all`）は全トラック。`false` は何もしない。
 * リンククリップは常に同じ扱いをして `start_f` と尺を揃える（docs/05 §14.6）。
 */
import { MontashError, type Warning, warning } from "../cli/errors.ts";
import {
  type ClipLocation,
  canSetClipDuration,
  findClipOrNull,
  removeClips,
  setClipDuration,
  sortClips,
  sourceLimitF,
  trimClipHead,
} from "./clip-editing.ts";
import { clipDurationF, clipEndF, isMediaClip, isSubtitleClip, type Project, type Transition } from "./schema.ts";
import { handleExtension } from "./validate.ts";

/** `--ripple` の値。false = リップルしない */
export type RippleScope = false | "all" | "track";

export interface RippleInput {
  /** 編集点 `p_f` */
  point: number;
  /** 変化量 `delta_f`（削除・短縮は負、挿入・延長は正） */
  delta: number;
  scope: RippleScope;
  /** `scope === "track"` のときの対象トラック */
  tracks?: Iterable<string>;
  /** 動かさないクリップ（編集対象そのもの） */
  exclude?: Iterable<string>;
}

/** `--ripple` オプションの値（yargs は string で受ける）を RippleScope に変換する */
export function parseRippleScope(value: unknown): RippleScope {
  if (value === undefined || value === null || value === false) return false;
  if (value === "" || value === true || value === "true" || value === "all") return "all";
  if (value === "track") return "track";
  throw new MontashError("E_USAGE", `invalid --ripple value ${JSON.stringify(value)}`, {
    hint: "Use --ripple (all tracks), --ripple=all, or --ripple=track. Omit it to leave other clips in place.",
    exitCode: 2,
  });
}

/**
 * リップルを適用する。動かした（または尺を変えた）クリップ ID を返す。
 * project は直接書き換える。
 */
export function rippleTimeline(project: Project, input: RippleInput, warnings: Warning[]): string[] {
  const { point, delta, scope } = input;
  if (scope === false || delta === 0) return [];
  const exclude = new Set(input.exclude ?? []);
  const scoped = scopedTrackIds(project, scope, new Set(input.tracks ?? []));
  if (scoped.size === 0) return [];
  const cut = delta < 0 ? -delta : 0;
  const rangeEnd = point + cut; // 削除区間 [point, rangeEnd)

  // 編集前に成立していたトランジションだけを後で検査する（元から壊れていたものは触らない）
  const validBefore = new Set(project.transitions.filter((t) => transitionOk(project, t)).map((t) => t.id));

  const touched: string[] = [];
  const removed = new Set<string>();
  for (const unit of linkedUnits(project, scoped, exclude)) {
    const head = unit[0]!.clip;
    const start = head.start_f;
    const end = clipEndF(head);

    // 字幕クリップは尺を持たない（点として扱う）
    if (isSubtitleClip(head)) {
      if (start >= point) {
        head.start_f = Math.max(point, start + delta);
        touched.push(head.id);
      }
      continue;
    }

    if (delta > 0) {
      if (start >= point) {
        for (const m of unit) m.clip.start_f = start + delta;
        touched.push(...unit.map((m) => m.clip.id));
      } else if (end > point) {
        const wanted = clipDurationF(head) + delta;
        if (unit.every((m) => canSetClipDuration(project, m.clip, wanted))) {
          for (const m of unit) setClipDuration(project, m.clip, wanted);
          touched.push(...unit.map((m) => m.clip.id));
        } else {
          warnings.push(
            warning(
              "W_RIPPLE_SPAN_NOT_EXTENDED",
              `clip "${head.id}" spans f:${point} but has no source left to extend; a ${delta} frame gap remains on track "${unit[0]!.track.id}"`,
              {
                hint: "Set loop: true on the clip, use a longer asset, or close the gap with `montash timeline gaps --fill close`.",
                detail: { clip: head.id, point_f: point, delta_f: delta },
              },
            ),
          );
        }
      }
      continue;
    }

    if (start >= rangeEnd) {
      for (const m of unit) m.clip.start_f = start + delta;
      touched.push(...unit.map((m) => m.clip.id));
    } else if (start >= point) {
      if (end <= rangeEnd) {
        for (const m of unit) removed.add(m.clip.id);
      } else {
        const headCut = rangeEnd - start;
        for (const m of unit) {
          trimClipHead(m.clip, headCut);
          m.clip.start_f = point;
        }
        touched.push(...unit.map((m) => m.clip.id));
      }
    } else if (end > point) {
      const tailCut = Math.min(end, rangeEnd) - point;
      for (const m of unit) setClipDuration(project, m.clip, clipDurationF(m.clip) - tailCut);
      touched.push(...unit.map((m) => m.clip.id));
    }
  }

  removeClips(project, removed, warnings);
  dropBrokenTransitions(project, validBefore, point, warnings);
  sortClips(project);
  return [...touched, ...removed];
}

// ---------------------------------------------------------------------------
// 対象の決定
// ---------------------------------------------------------------------------

/** リップル対象のトラック ID（locked は常に除外。track スコープはリンク先トラックも含める） */
function scopedTrackIds(project: Project, scope: Exclude<RippleScope, false>, requested: Set<string>): Set<string> {
  const scoped = new Set<string>();
  for (const track of project.tracks) {
    if (track.locked) continue;
    if (scope === "all" || requested.has(track.id)) scoped.add(track.id);
  }
  if (scope === "track") {
    const seeds = project.tracks.filter((t) => scoped.has(t.id));
    for (const track of seeds) {
      for (const clip of track.clips) {
        if (!isMediaClip(clip) || clip.link === null) continue;
        const partner = findClipOrNull(project, clip.link);
        if (partner && !partner.track.locked) scoped.add(partner.track.id);
      }
    }
  }
  return scoped;
}

/**
 * リップル対象を「まとめて動かす単位」に分ける。リンククリップは 1 単位にまとめ、
 * 相手が対象外（ロック／除外）なら同期が壊れるので E_TRACK_LOCKED で止める。
 */
function linkedUnits(project: Project, scoped: Set<string>, exclude: Set<string>): ClipLocation[][] {
  const seen = new Set<string>();
  const units: ClipLocation[][] = [];
  for (const track of project.tracks) {
    if (!scoped.has(track.id)) continue;
    for (const clip of [...track.clips]) {
      if (exclude.has(clip.id) || seen.has(clip.id)) continue;
      seen.add(clip.id);
      const unit: ClipLocation[] = [{ track, clip }];
      if (isMediaClip(clip) && clip.link !== null) {
        const partner = findClipOrNull(project, clip.link);
        if (partner) {
          if (!scoped.has(partner.track.id) || exclude.has(partner.clip.id)) {
            throw new MontashError(
              "E_TRACK_LOCKED",
              `ripple would desynchronize linked clips "${clip.id}" and "${partner.clip.id}" (track "${partner.track.id}" is outside the ripple)`,
              {
                hint: `Unlock track "${partner.track.id}", use --ripple=all, or pass --unlink to edit the clips independently.`,
                detail: { clip: clip.id, link: partner.clip.id, track: partner.track.id },
              },
            );
          }
          seen.add(partner.clip.id);
          unit.push(partner);
        }
      }
      units.push(unit);
    }
  }
  return units;
}

/**
 * トランジションが成立しているか（docs/05 §14.5 と同じ条件）。
 * 編集点を跨ぐトランジションはここで不成立になり、`dropBrokenTransitions()` が落とす。
 */
function transitionOk(project: Project, t: Transition): boolean {
  const from = findClipOrNull(project, t.from);
  const to = findClipOrNull(project, t.to);
  if (!from || !to || from.track.id !== t.track || to.track.id !== t.track) return false;
  const fromEnd = clipEndF(from.clip);
  if (t.mode !== "handle") return fromEnd - to.clip.start_f === t.duration_f;
  if (fromEnd !== to.clip.start_f) return false;
  const { ext_from, ext_to } = handleExtension(t.duration_f);
  if (isMediaClip(from.clip)) {
    const limit = sourceLimitF(project, from.clip);
    if (limit !== null && from.clip.out_f + ext_from > limit) return false;
  }
  if (isMediaClip(to.clip) && !to.clip.loop && to.clip.in_f < ext_to) return false;
  return true;
}

/** 編集で成立しなくなったトランジションを落とす（docs/04 §6a `W_TRANSITION_REMOVED`） */
function dropBrokenTransitions(project: Project, validBefore: Set<string>, point: number, warnings: Warning[]): void {
  project.transitions = project.transitions.filter((t) => {
    if (!validBefore.has(t.id) || transitionOk(project, t)) return true;
    warnings.push(
      warning("W_TRANSITION_REMOVED", `transition "${t.id}" crosses the ripple point f:${point} and was removed`, {
        hint: "Re-add it with `montash transition add` after the edit.",
        detail: { transition: t.id, point_f: point, from: t.from, to: t.to },
      }),
    );
    return false;
  });
}
