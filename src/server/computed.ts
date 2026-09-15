/**
 * `GET /api/project` に添える派生値（docs/06 §2.4、docs/13 D-1）。
 *
 * project.json は「保存する値」だけを持つため、クリップの長さは種別ごとに別の形で表現される。
 *   - 映像・音声: `in_f` / `out_f` / `speed` から算出（`duration_f` は保存しない）
 *   - テキスト・生成: `duration_f` を直接持ち、`in_f` / `out_f` は無い
 *   - 字幕: 長さを一切持たない（字幕素材そのものが尺を決める）
 * クライアントがこの分岐を各所で再実装すると描画がずれるので、サーバ側で一度だけ
 * `start_f` / `end_f` / `duration_f` に正規化して返す。
 *
 * 字幕だけは素材ファイルを読まないと尺が決まらないため、読み取りは呼び出し側から
 * 差し込む（`SubtitleReader`）。この module 自体は純関数で保つ。
 */
import type { Fps } from "../core/schema.ts";
import { millisToFrames, parseSubtitleCues } from "../ffmpeg/ass.ts";
import { type ClipKind, clipKindOf } from "../shared/clip-kind.ts";

/** クリップの種別。`src/core/schema.ts` の `clipKind()` と同じ判定 */
/** 未知種別（プラグイン由来）は "opaque"。Web は「プラグイン不足」として描く */
export type ComputedClipKind = ClipKind;

/** 正規化したクリップ 1 件。`end_f` は exclusive（`start_f + duration_f`） */
export interface ComputedClip {
  id: string;
  kind: ComputedClipKind;
  start_f: number;
  end_f: number;
  duration_f: number;
  /** タイムライン上に重ねる短い表示名。テキスト・字幕は本文の先頭 */
  label: string | null;
}

export interface ComputedTrack {
  id: string;
  kind: string;
  clips: ComputedClip[];
}

export interface Computed {
  /**
   * プロジェクト尺。`core/assets.ts` の `timelineDurationF()` と同じく字幕は数えない
   * （字幕は素材側が尺を持つだけで、レンダーの長さを伸ばさない）。
   */
  duration_f: number;
  /** タイムラインに描く必要のある最大 `end_f`（字幕を含む）。既定スケールはこちらに合わせる */
  span_f: number;
  tracks: ComputedTrack[];
}

/** 字幕素材の中身を返す（見つからなければ null）。サーバ側でファイル読み取りを差し込む */
export type SubtitleReader = (assetId: string) => string | null;

/** タイムラインに重ねるラベルの最大文字数（docs/06 §2.4） */
export const LABEL_MAX_CHARS = 20;

const DEFAULT_FPS: Fps = { num: 30, den: 1 };

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 本文を 1 行に畳んで `LABEL_MAX_CHARS` で省略する（純関数）。
 * 絵文字などのサロゲートペアを割らないよう、コードポイント単位で数える。
 */
export function clipLabelText(text: string, max = LABEL_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join("")}…`;
}

/** project.json 上のクリップの種別を判定する（規則は `shared/clip-kind.ts` が正） */
export function computedClipKind(clip: Record<string, unknown>): ComputedClipKind {
  return clipKindOf(clip);
}

/**
 * 字幕素材の本文から、タイムライン上で占める区間（フレーム）を求める（純関数）。
 * SRT / WebVTT は `-->` の時刻行、ASS は `Dialogue:` 行の開始・終了を見る。
 * 表示が 1 件も無ければ null。
 */
export function subtitleSpanF(source: string, fps: Fps): { start_f: number; end_f: number } | null {
  const cues = parseSubtitleCues(source);
  if (cues.length > 0) {
    const startMs = Math.min(...cues.map((c) => c.startMs));
    const endMs = Math.max(...cues.map((c) => c.endMs));
    return { start_f: millisToFrames(startMs, fps), end_f: millisToFrames(endMs, fps) };
  }
  const span = assDialogueSpanMs(source);
  if (!span) return null;
  return { start_f: millisToFrames(span.startMs, fps), end_f: millisToFrames(span.endMs, fps) };
}

/** ASS の `Dialogue:` 行（`H:MM:SS.cc`）から最初と最後の時刻を拾う */
function assDialogueSpanMs(source: string): { startMs: number; endMs: number } | null {
  const line = /^Dialogue:\s*[^,]*,([^,]*),([^,]*),/;
  const time = /^\s*(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*$/;
  const toMs = (v: string): number | null => {
    const m = time.exec(v);
    if (!m) return null;
    // ASS の小数部は 1/100 秒
    const frac = (m[4] as string).padEnd(2, "0").slice(0, 2);
    return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(frac) * 10;
  };
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const m = line.exec(raw);
    if (!m) continue;
    const s = toMs(m[1] as string);
    const e = toMs(m[2] as string);
    if (s === null || e === null) continue;
    startMs = Math.min(startMs, s);
    endMs = Math.max(endMs, Math.max(s, e));
  }
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? { startMs, endMs } : null;
}

/** 映像・音声クリップの長さ（docs/05 §6.1: `max(1, round((out_f - in_f) / speed))`） */
function mediaDurationF(clip: Record<string, unknown>): number {
  const inF = num(clip.in_f);
  const outF = num(clip.out_f, inF);
  const speed = num(clip.speed, 1) > 0 ? num(clip.speed, 1) : 1;
  return Math.max(1, Math.round((outF - inF) / speed));
}

function computeClip(clip: Record<string, unknown>, fps: Fps, readSubtitle: SubtitleReader): ComputedClip {
  const id = str(clip.id) ?? "";
  const kind = computedClipKind(clip);
  const startF = Math.max(0, Math.round(num(clip.start_f)));

  if (kind === "subtitle") {
    // 字幕はクリップ側に長さが無い。素材の最初と最後の表示で区間を作る（`offset_f` ぶんずらす）
    const assetId = str(clip.asset);
    const source = assetId === null ? null : readSubtitle(assetId);
    const span = source === null ? null : subtitleSpanF(source, fps);
    const offset = startF + Math.round(num(clip.offset_f));
    const start = span ? Math.max(0, offset + span.start_f) : startF;
    const end = span ? Math.max(start + 1, offset + span.end_f) : start;
    return { id, kind, start_f: start, end_f: end, duration_f: end - start, label: labelOf(clip, kind) };
  }

  const durationF = kind === "media" ? mediaDurationF(clip) : Math.max(1, Math.round(num(clip.duration_f, 1)));
  return {
    id,
    kind,
    start_f: startF,
    end_f: startF + durationF,
    duration_f: durationF,
    label: labelOf(clip, kind),
  };
}

function labelOf(clip: Record<string, unknown>, kind: ComputedClipKind): string | null {
  if (kind === "text") {
    const text = str(clip.text);
    return text === null ? null : clipLabelText(text);
  }
  if (kind === "subtitle") return str(clip.asset);
  return str(clip.label) ?? str(clip.asset);
}

/**
 * project.json 全体を正規化する。
 * 壊れた project.json でも落ちないよう、想定外の形は読み飛ばす。
 */
export function computeProject(project: unknown, readSubtitle: SubtitleReader = () => null): Computed {
  const p = record(project);
  const settings = record(p?.settings);
  const fpsRaw = record(settings?.fps);
  const fps: Fps =
    fpsRaw && num(fpsRaw.num) > 0 && num(fpsRaw.den) > 0 ? { num: num(fpsRaw.num), den: num(fpsRaw.den) } : DEFAULT_FPS;

  const tracks: ComputedTrack[] = [];
  let durationF = 0;
  let spanF = 0;
  for (const t of Array.isArray(p?.tracks) ? p.tracks : []) {
    const track = record(t);
    if (!track) continue;
    const clips: ComputedClip[] = [];
    for (const c of Array.isArray(track.clips) ? track.clips : []) {
      const clip = record(c);
      if (!clip) continue;
      const computed = computeClip(clip, fps, readSubtitle);
      clips.push(computed);
      if (computed.end_f > spanF) spanF = computed.end_f;
      if (computed.kind !== "subtitle" && computed.end_f > durationF) durationF = computed.end_f;
    }
    tracks.push({ id: str(track.id) ?? "", kind: str(track.kind) ?? "", clips });
  }
  return { duration_f: durationF, span_f: spanF, tracks };
}
