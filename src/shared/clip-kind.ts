/**
 * クリップ種別の判別（docs/05 §6, docs/13 D-14）。
 *
 * CLI（`core/schema.ts`）・サーバ（`server/computed.ts`）・フロント（`web/src/lib/timeline.ts`）が
 * **同じ 1 つの規則**を使うための共有モジュール。zod にも DOM にも依存しない純関数だけを置く。
 * 以前はこの規則が 3 箇所に複製され、未知種別が黙って `media` 扱い（= 1 フレーム幅で描画）に
 * なる不具合があった。
 *
 * 判別は `type` フィールドだけで行う（フォールバックしない）。未知の `type` は `opaque` で、
 * **データとしては保持し、レンダーしようとしたときにだけ失敗させる**（プラグインが供給する種別）。
 */

/** 本体が解釈できるクリップ種別 */
export const KNOWN_CLIP_TYPES = ["media", "text", "subtitle", "generator"] as const;
export type KnownClipKind = (typeof KNOWN_CLIP_TYPES)[number];

/** `opaque` = 本体が知らない種別（プラグイン由来、またはプラグイン不在） */
export type ClipKind = KnownClipKind | "opaque";

export function isKnownClipType(type: unknown): type is KnownClipKind {
  return typeof type === "string" && (KNOWN_CLIP_TYPES as readonly string[]).includes(type);
}

/** 判別に必要な最小の形 */
export interface ClipKindInput {
  type?: unknown;
  [key: string]: unknown;
}

/** クリップの種別を判定する。`type` が無い／未知なら `opaque` */
export function clipKindOf(clip: ClipKindInput): ClipKind {
  return isKnownClipType(clip.type) ? clip.type : "opaque";
}

/** 長さの算出に必要な最小の形 */
export interface ClipDurationInput extends ClipKindInput {
  in_f?: unknown;
  out_f?: unknown;
  speed?: unknown;
  duration_f?: unknown;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * クリップがタイムライン上で占める長さ（フレーム）。docs/05 §6.1。
 *
 * - media: `max(1, round((out_f - in_f) / speed))`
 * - text / generator / opaque: `duration_f`
 * - subtitle: 素材が尺を決めるため単独では算出できず 0（`computed` が別途求める）
 */
export function clipDurationFrames(clip: ClipDurationInput): number {
  const kind = clipKindOf(clip);
  if (kind === "subtitle") return 0;
  if (kind === "media") {
    const speed = finite(clip.speed, 1) > 0 ? finite(clip.speed, 1) : 1;
    const inF = finite(clip.in_f, 0);
    const outF = finite(clip.out_f, inF);
    return Math.max(1, Math.round((outF - inF) / speed));
  }
  // text / generator / opaque は duration_f を持つ（opaque もスキーマで必須にしている）
  return Math.max(1, Math.round(finite(clip.duration_f, 1)));
}
