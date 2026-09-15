/**
 * 編集タイムラインの派生値（docs/06 §2.4、docs/13 D-1 / D-2）。
 *
 * canvas も DOM も React も触らない純関数だけを置く（tests/unit/web から直接呼べる）。
 * store.ts はここを再エクスポートするだけなので、この module から store.ts は参照しない。
 *
 * クリップの長さは種別で持ち方が違う（映像・音声は `in_f`/`out_f`/`speed`、テキスト・生成は
 * `duration_f`、字幕はどちらも持たない）。サーバが `GET /api/project` の `computed` で
 * 正規化済みの `start_f` / `end_f` / `duration_f` を返すので、まずそれを使い、
 * 無いとき（古いサーバ・テスト用の素の project.json）だけ手元で算出する。
 */

export interface Fps {
  num: number;
  den: number;
}

export interface ClipLike {
  id: string;
  asset?: string;
  label?: string;
  start_f: number;
  in_f?: number;
  out_f?: number;
  speed?: number;
  [k: string]: unknown;
}

export interface TrackLike {
  id: string;
  kind?: "video" | "audio" | "text" | string;
  name?: string;
  muted?: boolean;
  clips?: ClipLike[];
  [k: string]: unknown;
}

/** `GET /api/project` の `computed`（src/server/computed.ts と同じ形） */
export interface ComputedClip {
  id: string;
  kind: "media" | "text" | "subtitle" | "generator";
  start_f: number;
  end_f: number;
  duration_f: number;
  label: string | null;
}

export interface Computed {
  /** プロジェクト尺（字幕は含めない。CLI の `timeline show` と同じ） */
  duration_f: number;
  /** タイムラインに描く必要のある最大 `end_f`（字幕を含む） */
  span_f: number;
  tracks: Array<{ id: string; kind: string; clips: ComputedClip[] }>;
}

export interface ProjectLike {
  name?: string;
  settings?: { fps?: Fps; resolution?: { width: number; height: number }; [k: string]: unknown };
  assets?: Record<string, unknown>;
  tracks?: TrackLike[];
  computed?: Computed;
  [k: string]: unknown;
}

export const DEFAULT_FPS: Fps = { num: 30, den: 1 };

export function fpsOf(p: ProjectLike | null): Fps {
  const f = p?.settings?.fps;
  return f && f.num > 0 && f.den > 0 ? f : DEFAULT_FPS;
}

// ---------------------------------------------------------------------------
// クリップの区間
// ---------------------------------------------------------------------------

export type ClipKind = "media" | "text" | "subtitle" | "generator";

/** クリップの種別（`src/core/schema.ts` の `clipKind()` と同じ規則） */
export function clipKindOf(c: ClipLike): ClipKind {
  if (c.type === "text") return "text";
  if (c.type === "subtitle") return "subtitle";
  if ("generator" in c) return "generator";
  return "media";
}

/**
 * クリップの長さ（フレーム）。
 * 映像・音声は docs/05 §6.1 の `max(1, round((out_f - in_f) / speed))`。
 * テキスト・生成クリップは `duration_f` をそのまま使う（ここを取り違えると 1 フレーム幅になる）。
 * 字幕は素材が尺を決めるため単独では算出できず 0 を返す（`computed` が要る）。
 */
export function clipDuration(c: ClipLike): number {
  const kind = clipKindOf(c);
  if (kind === "subtitle") return 0;
  if (kind === "text" || kind === "generator") {
    const d = c.duration_f;
    return typeof d === "number" && Number.isFinite(d) ? Math.max(1, Math.round(d)) : 1;
  }
  const inF = c.in_f ?? 0;
  const outF = c.out_f ?? inF;
  const speed = c.speed && c.speed > 0 ? c.speed : 1;
  return Math.max(1, Math.round((outF - inF) / speed));
}

export function clipEnd(c: ClipLike): number {
  return c.start_f + clipDuration(c);
}

/** `computed` をクリップ ID で引ける形に畳む */
export function computedIndex(p: ProjectLike | null): Map<string, ComputedClip> {
  const index = new Map<string, ComputedClip>();
  for (const t of p?.computed?.tracks ?? []) for (const c of t.clips ?? []) index.set(c.id, c);
  return index;
}

export interface ClipSpan {
  start_f: number;
  end_f: number;
  duration_f: number;
}

/**
 * 描画に使うクリップの区間。サーバの `computed` があればそれを、無ければ手元の算出を使う。
 * 字幕は `computed` がないと長さが分からないので、その場合だけ 0 幅になる。
 */
export function clipSpan(c: ClipLike, index?: Map<string, ComputedClip>): ClipSpan {
  const hit = index?.get(c.id);
  if (hit) return { start_f: hit.start_f, end_f: hit.end_f, duration_f: hit.duration_f };
  const duration = clipDuration(c);
  return { start_f: c.start_f, end_f: c.start_f + duration, duration_f: duration };
}

/** タイムラインに重ねるラベルの最大文字数（docs/06 §2.4） */
export const LABEL_MAX_CHARS = 20;

/** 本文を 1 行に畳んで `max` 文字で省略する（サロゲートペアを割らない） */
export function truncateLabel(text: string, max = LABEL_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max).join("")}…`;
}

/**
 * クリップ矩形に重ねる文字列。
 * テキスト・字幕は本文の先頭（20 文字で省略）、映像・音声は素材名／ラベル。
 */
export function clipLabel(c: ClipLike, index?: Map<string, ComputedClip>): string {
  const kind = clipKindOf(c);
  if (kind === "text") {
    const text = typeof c.text === "string" ? truncateLabel(c.text) : "";
    return text === "" ? c.id : `${c.id} ${text}`;
  }
  if (kind === "subtitle") {
    const asset = typeof c.asset === "string" ? c.asset : (index?.get(c.id)?.label ?? "");
    return asset === "" ? c.id : `${c.id} ${asset}`;
  }
  const suffix = c.label ?? c.asset ?? "";
  return suffix === "" ? c.id : `${c.id} ${suffix}`;
}

// ---------------------------------------------------------------------------
// タイムライン全体
// ---------------------------------------------------------------------------

/**
 * プロジェクト尺（字幕を除く全クリップの最大 `end_f`）。サーバの `computed.duration_f` を優先する。
 * ヘッダ・トランスポートの表示はこちら（CLI の `timeline show` と一致させる）。
 */
export function timelineDuration(p: ProjectLike | null): number {
  const fromServer = p?.computed?.duration_f;
  if (typeof fromServer === "number" && Number.isFinite(fromServer)) return Math.max(0, fromServer);
  let max = 0;
  for (const t of p?.tracks ?? [])
    for (const c of t.clips ?? []) if (clipKindOf(c) !== "subtitle") max = Math.max(max, clipEnd(c));
  return max;
}

/**
 * タイムラインに描く必要のある範囲（字幕を含む最大 `end_f`）。既定スケールはこれに合わせる。
 * 字幕が映像より後ろまで伸びていても画面外に出ないようにするため、尺とは別に持つ。
 */
export function timelineSpan(p: ProjectLike | null): number {
  const fromServer = p?.computed?.span_f;
  if (typeof fromServer === "number" && Number.isFinite(fromServer)) return Math.max(0, fromServer);
  let max = 0;
  for (const t of p?.tracks ?? []) for (const c of t.clips ?? []) max = Math.max(max, clipEnd(c));
  return max;
}

export function clipCount(p: ProjectLike | null): number {
  let n = 0;
  for (const t of p?.tracks ?? []) n += t.clips?.length ?? 0;
  return n;
}

/** 表示順: T*（上）→ V*（配列逆順）→ A*（下）。docs/06 §2.4 */
export function displayTracks(p: ProjectLike | null): TrackLike[] {
  const tracks = p?.tracks ?? [];
  const text = tracks.filter((t) => t.kind === "text");
  const video = tracks.filter((t) => t.kind === "video").reverse();
  const audio = tracks.filter((t) => t.kind === "audio");
  const other = tracks.filter((t) => t.kind !== "text" && t.kind !== "video" && t.kind !== "audio");
  return [...text, ...video, ...audio, ...other];
}

export function framesToSeconds(f: number, fps: Fps): number {
  return (f * fps.den) / fps.num;
}

export function secondsToFrames(s: number, fps: Fps): number {
  return Math.round((s * fps.num) / fps.den);
}

/** HH:MM:SS.mmm */
export function formatTc(f: number, fps: Fps): string {
  const s = framesToSeconds(f, fps);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// 時間軸のスケール（docs/13 D-2）
// ---------------------------------------------------------------------------

/** クリップが 1 つも無いときに表示する秒数 */
export const EMPTY_SCALE_SECONDS = 10;
/** 末尾に残す余白（秒）。最後のクリップが画面端に貼り付かない程度 */
export const TAIL_MARGIN_SECONDS = 1;

export interface ScaleOptions {
  /** 再生ヘッドは常に画面内に収める */
  playhead_f?: number;
  /** ズーム倍率（1 = 既定、<1 で時間軸を広げる、>1 で拡大）。ズーム中は尺に引き戻さない */
  zoom?: number;
}

/**
 * 時間軸に載せるフレーム数（＝画面幅ぶんの尺）を決める。
 *
 * 既定はプロジェクト尺 + 1 秒の余白。尺 0（クリップなし）のときだけ 10 秒へフォールバックする。
 * `zoom` が指定されていればその倍率で割る（ユーザーが尺より広げた状態を維持する）。
 * 再生ヘッドが先にある場合は必ず収まるまで伸ばす。
 */
export function timelineScaleFrames(durationF: number, fps: Fps, opts: ScaleOptions = {}): number {
  const safeFps = fps.num > 0 && fps.den > 0 ? fps : DEFAULT_FPS;
  const duration = Number.isFinite(durationF) && durationF > 0 ? durationF : 0;
  const base =
    duration > 0
      ? duration + secondsToFrames(TAIL_MARGIN_SECONDS, safeFps)
      : secondsToFrames(EMPTY_SCALE_SECONDS, safeFps);
  const zoom = typeof opts.zoom === "number" && opts.zoom > 0 ? opts.zoom : 1;
  const scaled = Math.round(base / zoom);
  const playhead = Number.isFinite(opts.playhead_f) ? Math.floor(opts.playhead_f as number) : 0;
  return Math.max(1, Number.isFinite(scaled) ? scaled : 1, playhead + 1);
}
