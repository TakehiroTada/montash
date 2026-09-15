/**
 * トランジション（docs/07 §4.2）。
 *
 * `concat` と `xfade` は混在できないので、トラック内はトランジションで繋がる区間（グループ）に分け、
 * グループ内は左から `xfade` を畳み込み、グループ同士を `concat` で繋ぐ。
 * `offset` はフレーム数で追跡し、最後だけ `framesToSecString()` で秒にする（ADR-09）。
 */
import { MontashError } from "../../cli/errors.ts";
import type { Transition } from "../../core/schema.ts";
import { handleExtension } from "../../core/validate.ts";
import type { GraphContext, Stream } from "./types.ts";

/** クリップ ID → そのクリップを from / to とするトランジション */
export interface TransitionIndex {
  byFrom: Map<string, Transition>;
  byTo: Map<string, Transition>;
}

export function indexTransitions(
  transitions: readonly Transition[],
  predicate?: (t: Transition) => boolean,
): TransitionIndex {
  const byFrom = new Map<string, Transition>();
  const byTo = new Map<string, Transition>();
  for (const t of transitions) {
    if (predicate && !predicate(t)) continue;
    byFrom.set(t.from, t);
    byTo.set(t.to, t);
  }
  return { byFrom, byTo };
}

/**
 * クリップの素材延長量（docs/05 §7, docs/07 §4.2）。
 * `mode: handle` は `ext_from = ceil(d_f/2)` を先行クリップの後ろに、`ext_to = d_f - ext_from` を後続の前に足す。
 * `mode: overlap` は `to.start_f` が既に前倒しされているので延長しない。
 */
export function clipHandles(id: string, index: TransitionIndex): { extIn: number; extOut: number } {
  const prev = index.byTo.get(id);
  const next = index.byFrom.get(id);
  const extIn = prev && prev.mode === "handle" ? handleExtension(prev.duration_f).ext_to : 0;
  const extOut = next && next.mode === "handle" ? handleExtension(next.duration_f).ext_from : 0;
  return { extIn, extOut };
}

export interface ClipGroup<T> {
  clips: T[];
  /** `transitions[i]` は `clips[i]` と `clips[i+1]` の間のトランジション */
  transitions: Transition[];
}

/** 並んだクリップをトランジションで繋がる区間に分ける（トランジション無しの境界で切る） */
export function groupByTransitions<T extends { id: string }>(
  clips: readonly T[],
  index: TransitionIndex,
): Array<ClipGroup<T>> {
  const groups: Array<ClipGroup<T>> = [];
  for (const clip of clips) {
    const last = groups[groups.length - 1];
    const previous = last?.clips[last.clips.length - 1];
    const link = previous ? index.byFrom.get(previous.id) : undefined;
    if (last && previous && link && link.to === clip.id) {
      last.clips.push(clip);
      last.transitions.push(link);
    } else {
      groups.push({ clips: [clip], transitions: [] });
    }
  }
  return groups;
}

/** `params` を `key=value` の並びにする（ffmpeg のオプション区切りを壊す値は拒否する） */
function transitionParams(tr: Transition): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(tr.params)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new MontashError("E_USAGE", `transition "${tr.id}": invalid parameter name ${JSON.stringify(key)}`);
    const text = typeof value === "number" || typeof value === "boolean" ? String(value) : String(value ?? "");
    if (!/^[A-Za-z0-9_.+*/() -]*$/.test(text))
      throw new MontashError("E_USAGE", `transition "${tr.id}": parameter "${key}" has unsupported characters`, {
        hint: "xfade parameters may only contain letters, digits and simple arithmetic.",
      });
    parts.push(`${key}=${text}`);
  }
  return parts.length ? `:${parts.join(":")}` : "";
}

/**
 * xfade の畳み込み（docs/07 §4.2）。
 * 合成後の長さは `len1 + len2 - d_f`。`offset` は先行ストリームのフレーム数 − `d_f`。
 */
export function foldXfade(ctx: GraphContext, parts: readonly Stream[], transitions: readonly Transition[]): Stream {
  if (parts.length === 0) throw new MontashError("E_USAGE", "cannot fold an empty transition group");
  let current = parts[0]!;
  for (let i = 0; i < transitions.length; i++) {
    const tr = transitions[i]!;
    const next = parts[i + 1]!;
    const d = tr.duration_f;
    if (d >= current.frames || d >= next.frames)
      throw new MontashError(
        "E_INSUFFICIENT_HANDLE",
        `transition "${tr.id}" lasts ${d} frame(s) but the clips it joins are only ${current.frames} / ${next.frames} frame(s) long`,
        {
          hint: "Shorten --duration or lengthen the clips.",
          detail: {
            transition: tr.id,
            duration_f: d,
            max_duration_f: Math.max(0, Math.min(current.frames, next.frames) - 1),
          },
        },
      );
    const offset = current.frames - d;
    const label = ctx.chain(
      [current.label, next.label],
      [`xfade=transition=${tr.type}:duration=${ctx.secs(d)}:offset=${ctx.secs(offset)}${transitionParams(tr)}`, ctx.tb],
    );
    current = { label, frames: current.frames + next.frames - d };
  }
  return current;
}
