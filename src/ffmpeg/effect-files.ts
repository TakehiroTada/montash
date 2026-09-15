/**
 * エフェクトが参照する外部ファイルの指紋（docs/13 D-19、docs/07 §11.1）。
 *
 * `preview` のセグメントキャッシュ指紋は `filterComplex` 由来なので、エフェクトの増減・パラメータ変更には
 * 自動で追随する。ところが `lut3d` のように**外部ファイルをパスで参照する**エフェクトは、
 * パスが同じまま中身が差し替わっても `filterComplex` が 1 文字も変わらず、古いセグメントが再利用されていた。
 *
 * そこで `EffectSpec.externalFiles()`（純関数）で申告されたパスをここで stat し、
 * mtime / size を指紋に混ぜる。**I/O はこの層だけ**で、`graph/` と `registry/` は純粋なまま
 * （loudnorm / ducking / effect-analysis と同じ「外で測って値で渡す」パターン）。
 *
 * **申告しないエフェクトでは何も集まらない** → 指紋は従来どおり（既存キャッシュは無効化されない）。
 */
import { stat } from "node:fs/promises";
import { clipEndF, type Project, type TrackClip } from "../core/schema.ts";
import { resolveAssetPath } from "../core/validate.ts";
import { collectExternalFiles, type EffectRef, type EffectTarget } from "../registry/effects.ts";

/** 指紋に混ぜる 1 ファイル分。stat に失敗したら size / mtime は付かない（存在しない LUT は ffmpeg 側のエラー） */
export interface ExternalFileFingerprint {
  /** プロジェクトファイルに書かれていたパス（そのまま） */
  path: string;
  size?: number;
  mtime?: number;
}

function effectsOf(clip: TrackClip): EffectRef[] {
  return ((clip as { effects?: EffectRef[] }).effects ?? []) as EffectRef[];
}

function targetOf(kind: string): EffectTarget {
  return kind === "audio" ? "audio" : "video";
}

function push(out: string[], files: readonly string[]): void {
  for (const f of files) if (!out.includes(f)) out.push(f);
}

/**
 * プロジェクト全体（全トラック・映像も音声も）のエフェクトが申告した外部ファイル。
 * `previewFingerprint()`（ready / stale の判定）に使う。
 */
export function projectExternalFiles(project: Project): string[] {
  const out: string[] = [];
  for (const track of project.tracks)
    for (const clip of track.clips) push(out, collectExternalFiles(targetOf(track.kind), effectsOf(clip)));
  return out.sort();
}

/**
 * 映像セグメント `[from_f, to_f)` に関係するクリップのエフェクトが申告した外部ファイル。
 * どのクリップが関係するかの判定は `preview.ts` のセグメント分割と同じ規則
 * （音声トラックと `muted` のトラックは映像セグメントに出ない）。
 */
export function segmentExternalFiles(project: Project, range: { from_f: number; to_f: number }): string[] {
  const out: string[] = [];
  for (const track of project.tracks) {
    if (track.kind === "audio" || track.muted) continue;
    for (const clip of track.clips) {
      if (clip.start_f >= range.to_f || clipEndF(clip) <= range.from_f) continue;
      push(out, collectExternalFiles("video", effectsOf(clip)));
    }
  }
  return out.sort();
}

/** 音声グラフ（タイムライン全体 1 パス）に関係するエフェクトが申告した外部ファイル */
export function audioExternalFiles(project: Project): string[] {
  const out: string[] = [];
  for (const track of project.tracks)
    if (track.kind === "audio" || !track.muted)
      for (const clip of track.clips) push(out, collectExternalFiles("audio", effectsOf(clip)));
  return out.sort();
}

/**
 * 申告されたパスを stat して指紋にする。
 * 相対パスはアセットと同じくプロジェクトディレクトリ基準（docs/05 §3）。
 * 1 件も無ければ `undefined` を返し、**指紋の材料に何も足さない**（従来のハッシュと一致させるため）。
 */
export async function fingerprintExternalFiles(
  dir: string,
  paths: readonly string[],
): Promise<ExternalFileFingerprint[] | undefined> {
  if (paths.length === 0) return undefined;
  return await Promise.all(
    paths.map(async (path) => {
      const info = await stat(resolveAssetPath(dir, path)).catch(() => null);
      return { path, size: info?.size, mtime: info?.mtimeMs };
    }),
  );
}
