/**
 * アセットとタイムラインの派生情報（保存しない値を tracks から算出する。docs/05 §5「usage は保存しない」）。
 */
import { clipEndF, clipKind, type Project, type TrackClip } from "./schema.ts";

export interface AssetUsageEntry {
  id: string;
  track: string;
  start_f: number;
  end_f: number;
}

export interface AssetUsage {
  clips: AssetUsageEntry[];
}

/** クリップが参照するアセット ID（generator クリップは null） */
export function clipAssetId(clip: TrackClip): string | null {
  switch (clipKind(clip)) {
    case "media":
    case "subtitle":
      return (clip as { asset: string }).asset;
    case "text":
      return (clip as { asset: string | null }).asset;
    case "generator":
      return null;
  }
}

/** アセットを使っているクリップの一覧（全トラック、start_f 昇順） */
export function assetUsage(project: Project, assetId: string): AssetUsage {
  const clips: AssetUsageEntry[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clipAssetId(clip) !== assetId) continue;
      clips.push({ id: clip.id, track: track.id, start_f: clip.start_f, end_f: clipEndF(clip) });
    }
  }
  clips.sort((a, b) => a.start_f - b.start_f || a.track.localeCompare(b.track));
  return { clips };
}

/** タイムライン尺（全トラックのクリップ end_f の最大値。空なら 0） */
export function timelineDurationF(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const end = clipEndF(clip);
      if (end > max) max = end;
    }
  }
  return max;
}

/** クリップ総数（全トラック） */
export function clipCount(project: Project): number {
  return project.tracks.reduce((n, t) => n + t.clips.length, 0);
}
