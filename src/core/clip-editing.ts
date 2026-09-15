/**
 * クリップ編集の中核（docs/04 §6, docs/05 §6）。
 *
 * ここには「1 つのクリップ（とリンク相手）をどう書き換えるか」だけを置く。
 * 編集点より後ろを詰める／押し出す規則（リップル）は core/ripple.ts、
 * コマンドの引数解釈は cli/commands/clip-edit.ts が担当する。
 *
 * 不変条件（docs/05 §14）:
 * - 映像クリップと音声クリップの `link` は常に相互参照で、`start_f` と尺が一致する。
 * - 時間はすべて整数フレーム。尺は `clipDurationF()`（media は speed を考慮）で求める。
 */
import { MontashError, type Warning, warning } from "../cli/errors.ts";
import {
  type Clip,
  clipDurationF,
  clipEndF,
  isMediaClip,
  isSubtitleClip,
  isTextClip,
  type Project,
  type Track,
  type TrackClip,
} from "./schema.ts";

/** クリップとそれが載っているトラック */
export interface ClipLocation {
  track: Track;
  clip: TrackClip;
}

// ---------------------------------------------------------------------------
// 参照
// ---------------------------------------------------------------------------

/** 全トラックからクリップを探す（見つからなければ null） */
export function findClipOrNull(project: Project, id: string): ClipLocation | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === id);
    if (clip) return { track, clip };
  }
  return null;
}

/** 全トラックからクリップを探す。無ければ E_CLIP_NOT_FOUND */
export function findClip(project: Project, id: string): ClipLocation {
  const found = findClipOrNull(project, id);
  if (!found) {
    const known = project.tracks.flatMap((t) => t.clips.map((c) => c.id));
    throw new MontashError("E_CLIP_NOT_FOUND", `clip "${id}" not found`, {
      hint: "Run `montash clip list --json` to see the current clip IDs.",
      detail: { clip: id, known_clips: known.slice(0, 20) },
    });
  }
  return found;
}

/** ロックされたトラックへの編集は拒否する（docs/04 §5） */
export function assertUnlocked(track: Track): void {
  if (track.locked) {
    throw new MontashError("E_TRACK_LOCKED", `track "${track.id}" is locked`, {
      hint: `Run \`montash track lock ${track.id} --off\` first.`,
      detail: { track: track.id },
    });
  }
}

/**
 * 編集対象のクリップ群を返す。リンクがあれば相手も含める（`unlink` 指定時はリンクを解除して単独）。
 * 対象トラックがロックされていれば E_TRACK_LOCKED。
 */
export function linkedGroup(project: Project, id: string, unlink = false): ClipLocation[] {
  const primary = findClip(project, id);
  assertUnlocked(primary.track);
  const clip = primary.clip;
  if (!isMediaClip(clip) || clip.link === null) return [primary];
  const partner = findClip(project, clip.link);
  assertUnlocked(partner.track);
  if (unlink) {
    clip.link = null;
    if (isMediaClip(partner.clip)) partner.clip.link = null;
    return [primary];
  }
  return [primary, partner];
}

// ---------------------------------------------------------------------------
// 尺の変更
// ---------------------------------------------------------------------------

/** ソースの上限（`out_f` の最大値）。`loop` / 画像 / 尺不明のアセットは上限なし（null） */
export function sourceLimitF(project: Project, clip: Clip): number | null {
  const asset = project.assets[clip.asset];
  if (!asset || clip.loop || asset.type === "image") return null;
  return typeof asset.duration_f === "number" ? asset.duration_f : null;
}

/** フェード長がクリップ尺を超えないように丸める */
export function clampFades(clip: TrackClip, duration: number): void {
  const fades: Array<{ in_f: number; out_f: number }> = [];
  if (isMediaClip(clip)) {
    if (clip.video) fades.push(clip.video.fade);
    if (clip.audio) fades.push(clip.audio.fade);
  } else if (isTextClip(clip)) {
    fades.push(clip.fade);
  }
  for (const fade of fades) {
    fade.in_f = Math.max(0, Math.min(fade.in_f, duration));
    fade.out_f = Math.max(0, Math.min(fade.out_f, duration));
  }
}

/** タイムライン尺 `duration` に対応する `out_f`（speed を考慮） */
function outForDuration(clip: Clip, duration: number): number {
  return clip.in_f + Math.max(1, Math.round(duration * clip.speed));
}

/** `setClipDuration()` がソース不足で失敗しないか（リップル挿入の事前判定用） */
export function canSetClipDuration(project: Project, clip: TrackClip, duration: number): boolean {
  if (isSubtitleClip(clip)) return true;
  if (duration < 1) return false;
  if (!isMediaClip(clip)) return true;
  const limit = sourceLimitF(project, clip);
  return limit === null || outForDuration(clip, duration) <= limit;
}

/**
 * クリップのタイムライン尺を変更する（`start_f` は変えない）。
 * media は `out_f` を、text / generator は `duration_f` を書き換える。
 * ソースに余白が無くて伸ばせない場合は何もせず false（docs/04 §6a `W_RIPPLE_SPAN_NOT_EXTENDED`）。
 */
export function setClipDuration(project: Project, clip: TrackClip, duration: number): boolean {
  if (isSubtitleClip(clip)) return true;
  if (!canSetClipDuration(project, clip, duration)) return false;
  if (isMediaClip(clip)) clip.out_f = outForDuration(clip, duration);
  else clip.duration_f = Math.max(1, Math.trunc(duration));
  clampFades(clip, clipDurationF(clip));
  return true;
}

/**
 * 頭を `frames` フレーム削る（`start_f` は呼び出し側で調整する）。
 * media は `in_f` を進め、text / generator は `duration_f` を縮める。
 */
export function trimClipHead(clip: TrackClip, frames: number): void {
  if (frames <= 0 || isSubtitleClip(clip)) return;
  if (isMediaClip(clip)) clip.in_f = Math.min(clip.out_f - 1, clip.in_f + Math.round(frames * clip.speed));
  else clip.duration_f = Math.max(1, clip.duration_f - frames);
  clampFades(clip, clipDurationF(clip));
}

// ---------------------------------------------------------------------------
// 分割（ADR-12: 前半が元 ID を維持し、後半だけ新規採番）
// ---------------------------------------------------------------------------

/**
 * `at`（タイムラインの絶対フレーム）でクリップを 2 分割する。
 * 前半は元のクリップ（ID 据え置き）、後半を新 ID で作ってトラックに足し、その後半を返す。
 * 末尾フェードは後半へ、先頭フェードは前半へ振り分ける（docs/04 §6 clip split）。
 */
export function splitClipAt(project: Project, location: ClipLocation, at: number, newId: string): TrackClip {
  const { track, clip } = location;
  const start = clip.start_f;
  const end = clipEndF(clip);
  if (isSubtitleClip(clip)) {
    throw new MontashError("E_NOT_IMPLEMENTED", `subtitle clip "${clip.id}" cannot be split`, {
      hint: "A subtitle clip references a whole subtitle file; adjust offset_f instead.",
    });
  }
  if (at <= start || at >= end) {
    throw new MontashError("E_SPLIT_AT_EDGE", `f:${at} is at the edge of clip "${clip.id}" (f:${start}..f:${end})`, {
      hint: `Split strictly inside the clip (f:${start + 1}..f:${end - 1}), or use \`clip trim\` / \`clip delete\`.`,
      detail: { clip: clip.id, at_f: at, start_f: start, end_f: end },
    });
  }
  const right = structuredClone(clip);
  right.id = newId;
  right.start_f = at;
  const leftDuration = at - start;
  const rightDuration = end - at;
  if (isMediaClip(clip) && isMediaClip(right)) {
    const boundary = outForDuration(clip, leftDuration);
    clip.out_f = boundary;
    right.in_f = boundary;
    if (clip.video) clip.video.fade.out_f = 0;
    if (clip.audio) clip.audio.fade.out_f = 0;
    if (right.video) right.video.fade.in_f = 0;
    if (right.audio) right.audio.fade.in_f = 0;
  } else if (!isSubtitleClip(right)) {
    clip.duration_f = leftDuration;
    right.duration_f = rightDuration;
    if (isTextClip(clip) && isTextClip(right)) {
      clip.fade.out_f = 0;
      right.fade.in_f = 0;
    }
  }
  clampFades(clip, clipDurationF(clip));
  clampFades(right, clipDurationF(right));
  // クリップ末尾に張られたトランジションは後半が引き継ぐ
  for (const transition of project.transitions) {
    if (transition.from === clip.id) transition.from = right.id;
  }
  track.clips.push(right);
  return right;
}

// ---------------------------------------------------------------------------
// 削除
// ---------------------------------------------------------------------------

/**
 * クリップを削除し、残ったクリップの `link` と、参照しているトランジションを掃除する。
 * トランジションを落とした場合は `W_TRANSITION_REMOVED`（docs/04 §6a）。
 */
export function removeClips(project: Project, ids: ReadonlySet<string>, warnings: Warning[]): void {
  if (ids.size === 0) return;
  for (const track of project.tracks) {
    track.clips = track.clips.filter((c) => !ids.has(c.id));
  }
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (isMediaClip(clip) && clip.link !== null && ids.has(clip.link)) clip.link = null;
    }
  }
  project.transitions = project.transitions.filter((t) => {
    if (!ids.has(t.from) && !ids.has(t.to)) return true;
    warnings.push(
      warning("W_TRANSITION_REMOVED", `transition "${t.id}" was removed with its clips`, {
        detail: { transition: t.id, from: t.from, to: t.to },
      }),
    );
    return false;
  });
}

/** 全トラックのクリップを `start_f` 昇順に並べ直す（docs/05 §6: clips は start_f 昇順） */
export function sortClips(project: Project): void {
  for (const track of project.tracks) {
    track.clips.sort((a, b) => a.start_f - b.start_f || a.id.localeCompare(b.id));
  }
}
