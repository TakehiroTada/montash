/**
 * 素材の派生データ（サムネイル・波形。docs/05 §12, docs/06 §2.3, §2.4, §2.6）。
 *
 * - 前半は純関数（描画用の整形）。DOM も React も触らないので tests/unit/web から直接呼べる。
 * - 後半は取得キャッシュ。canvas は rAF ループで `useStore.getState()` を読むだけなので、
 *   派生データも React の状態ではなくモジュール内のキャッシュに置き、届いたら再描画を促す。
 */
import { clipEnd, type TrackLike } from "../store.ts";

/** `GET /api/assets/:id/thumbs.json`（docs/05 §12） */
export interface ThumbsIndex {
  interval_f: number;
  width: number;
  height: number;
  columns: number;
  count: number;
  sprite: string;
}

/** `GET /api/assets/:id/waveform.json`（docs/05 §12） */
export interface WaveformIndex {
  points_per_second: number;
  channels: number;
  peaks: number[];
}

export interface Fps {
  num: number;
  den: number;
}

// ---------------------------------------------------------------------------
// サムネイル（純関数）
// ---------------------------------------------------------------------------

/** スプライト内の 1 枚の位置（CSS の `background-position` は負の値で使う） */
export interface ThumbTile {
  /** 0 起点のタイル番号 */
  index: number;
  /** スプライト左上からのオフセット（px） */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 素材内フレーム `frame` に対応するタイル。範囲外は端に丸める。
 * 壊れたインデックス（count / columns が 0 以下）は null。
 */
export function thumbTile(index: ThumbsIndex | null | undefined, frame: number): ThumbTile | null {
  if (!index || index.count <= 0 || index.columns <= 0 || index.interval_f <= 0) return null;
  const i = Math.min(index.count - 1, Math.max(0, Math.floor(frame / index.interval_f)));
  return {
    index: i,
    x: (i % index.columns) * index.width,
    y: Math.floor(i / index.columns) * index.height,
    width: index.width,
    height: index.height,
  };
}

/** スプライト全体のサイズ（`background-size` に使う） */
export function spriteSize(index: ThumbsIndex): { width: number; height: number } {
  const rows = Math.max(1, Math.ceil(index.count / Math.max(1, index.columns)));
  return { width: index.columns * index.width, height: rows * index.height };
}

/** サムネイルストリップに並べるタイル（最大 `limit` 枚を等間隔で選ぶ） */
export function thumbStrip(index: ThumbsIndex | null | undefined, limit = 8): ThumbTile[] {
  if (!index || index.count <= 0) return [];
  const take = Math.min(limit, index.count);
  const tiles: ThumbTile[] = [];
  for (let n = 0; n < take; n++) {
    const i = take === 1 ? 0 : Math.round((n * (index.count - 1)) / (take - 1));
    const tile = thumbTile(index, i * index.interval_f);
    if (tile) tiles.push(tile);
  }
  return tiles;
}

// ---------------------------------------------------------------------------
// 波形（純関数）
// ---------------------------------------------------------------------------

/**
 * クリップの `in_f..out_f` を `columns` 本の縦棒に畳む（各列はその範囲のピークの最大値、0..1）。
 * ピークが足りない範囲は 0。`columns <= 0` や壊れたデータでは空配列を返す。
 */
export function waveformColumns(
  waveform: WaveformIndex | null | undefined,
  fps: Fps,
  inF: number,
  outF: number,
  columns: number,
): number[] {
  if (!waveform || columns <= 0 || outF <= inF) return [];
  const pps = waveform.points_per_second;
  const peaks = waveform.peaks;
  if (!(pps > 0) || !Array.isArray(peaks) || peaks.length === 0 || !(fps.num > 0) || !(fps.den > 0)) return [];
  // 素材内フレーム → 秒 → 波形の点番号
  const toPoint = (f: number) => (f * fps.den * pps) / fps.num;
  const from = toPoint(inF);
  const span = toPoint(outF) - from;
  const out = new Array<number>(columns).fill(0);
  for (let c = 0; c < columns; c++) {
    const start = from + (span * c) / columns;
    const end = from + (span * (c + 1)) / columns;
    // 1 点未満の幅でも必ず 1 点は見る（拡大表示で隙間だらけにしない）
    const first = Math.max(0, Math.floor(start));
    const last = Math.min(peaks.length - 1, Math.max(first, Math.ceil(end) - 1));
    let peak = 0;
    for (let i = first; i <= last; i++) {
      const v = peaks[i];
      if (v !== undefined && v > peak) peak = v;
    }
    out[c] = peak;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 取得キャッシュ
// ---------------------------------------------------------------------------

type Entry<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "absent" };

const thumbsCache = new Map<string, Entry<ThumbsIndex>>();
const waveformCache = new Map<string, Entry<WaveformIndex>>();
const listeners = new Set<() => void>();

/** 派生データが届いたら呼ばれる（canvas の再描画フラグを立てる用）。戻り値で解除する */
export function onDerivedLoaded(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const l of listeners) l();
}

async function load<T>(cache: Map<string, Entry<T>>, id: string, url: string): Promise<void> {
  cache.set(id, { state: "loading" });
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    cache.set(id, { state: "ready", value: (await res.json()) as T });
  } catch {
    // 未生成（404）も読めない場合も「無い」として扱い、UI は従来どおりの描画に落ちる
    cache.set(id, { state: "absent" });
  }
  notify();
}

function get<T>(cache: Map<string, Entry<T>>, id: string, path: string): T | null {
  const entry = cache.get(id);
  if (entry === undefined) {
    void load(cache, id, `/api/assets/${encodeURIComponent(id)}/${path}`);
    return null;
  }
  return entry.state === "ready" ? entry.value : null;
}

/** サムネイルインデックス。未取得なら取得を始めて null を返す */
export function getThumbs(assetId: string): ThumbsIndex | null {
  return get(thumbsCache, assetId, "thumbs.json");
}

/** 波形。未取得なら取得を始めて null を返す */
export function getWaveform(assetId: string): WaveformIndex | null {
  return get(waveformCache, assetId, "waveform.json");
}

/** スプライト画像の URL（`<img>` / `background-image` 用） */
export function spriteUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/thumbs.jpg`;
}

/** 素材が差し替わった（`assets.changed`）ときにキャッシュを捨てる */
export function invalidateDerived(assetIds?: readonly string[]): void {
  if (assetIds === undefined) {
    thumbsCache.clear();
    waveformCache.clear();
  } else {
    for (const id of assetIds) {
      thumbsCache.delete(id);
      waveformCache.delete(id);
    }
  }
  notify();
}

// ---------------------------------------------------------------------------
// 描画用の組み立て（純関数）
// ---------------------------------------------------------------------------

export interface TileStyle {
  width: string;
  height: string;
  backgroundImage: string;
  backgroundPosition: string;
  backgroundSize: string;
}

/**
 * スプライトから 1 枚だけを切り出して表示する CSS。`scale` で表示倍率を掛ける
 * （`background-size` と `background-position` を同じ倍率で縮める）。
 */
export function tileStyle(index: ThumbsIndex, tile: ThumbTile, assetId: string, scale = 1): TileStyle {
  const sprite = spriteSize(index);
  return {
    width: `${Math.round(tile.width * scale)}px`,
    height: `${Math.round(tile.height * scale)}px`,
    backgroundImage: `url("${spriteUrl(assetId)}")`,
    backgroundPosition: `-${Math.round(tile.x * scale)}px -${Math.round(tile.y * scale)}px`,
    backgroundSize: `${Math.round(sprite.width * scale)}px ${Math.round(sprite.height * scale)}px`,
  };
}

/** タイムライン上のフレームに対応する素材と、その素材内フレーム */
export interface ThumbSource {
  assetId: string;
  /** 素材内フレーム（`in_f` + クリップ先頭からの経過 × speed） */
  sourceF: number;
  clipId: string;
}

/**
 * シークバーのサムネイルに使う素材を決める（docs/06 §2.3）。
 * 合成順で一番上（`tracks` 配列の後ろ）にある、そのフレームを覆う映像クリップ。
 */
export function thumbSourceAt(tracks: readonly TrackLike[], frame: number): ThumbSource | null {
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track = tracks[i];
    if (track?.kind !== "video" || track.muted) continue;
    for (const clip of track.clips ?? []) {
      if (typeof clip.asset !== "string") continue;
      if (frame < clip.start_f || frame >= clipEnd(clip)) continue;
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      return {
        assetId: clip.asset,
        sourceF: Math.max(0, Math.round((clip.in_f ?? 0) + (frame - clip.start_f) * speed)),
        clipId: clip.id,
      };
    }
  }
  return null;
}
