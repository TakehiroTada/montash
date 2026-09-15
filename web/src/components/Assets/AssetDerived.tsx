/**
 * 選択素材のサムネイルストリップと波形（docs/06 §2.6）。
 *
 * `GET /api/assets/:id/thumbs.json` / `thumbs.jpg` / `waveform.json` を lib/derived.ts 越しに読み、
 * まだ生成されていなければ `proxy build --thumbs --waveform` のコマンド例を出す。
 */
import type { AssetView } from "../../lib/assets.ts";
import { formatCommand } from "../../lib/assets.ts";
import { getThumbs, getWaveform, thumbStrip, tileStyle, waveformColumns } from "../../lib/derived.ts";
import { fpsOf, useStore } from "../../store.ts";
import { useDerivedTick } from "../use-derived-tick.ts";

/** ストリップ 1 枚の表示倍率（160px 幅を 80px で並べる） */
const STRIP_SCALE = 0.5;
/** 波形の描画解像度（SVG の viewBox 幅にも使う） */
const WAVE_COLUMNS = 240;
const WAVE_HEIGHT = 48;

/** ピーク列を「中央から上下に伸びる縦棒」の 1 本のパスにする（要素数を増やさないため） */
function wavePath(peaks: readonly number[], height: number): string {
  const mid = height / 2;
  let d = "";
  for (let i = 0; i < peaks.length; i++) {
    const h = Math.max(1, (peaks[i] ?? 0) * (height - 2));
    d += `M${i} ${(mid - h / 2).toFixed(2)}v${h.toFixed(2)}`;
  }
  return d;
}

export function AssetDerived({ asset }: { asset: AssetView }) {
  useDerivedTick();
  const fps = fpsOf(useStore((s) => s.project));
  const wantsThumbs = asset.type === "video" || asset.type === "image";
  const wantsWaveform = asset.type === "audio" || (asset.type === "video" && Boolean(asset.audio));
  if (!wantsThumbs && !wantsWaveform) return null;

  const thumbs = wantsThumbs && !asset.missing ? getThumbs(asset.id) : null;
  const waveform = wantsWaveform && !asset.missing ? getWaveform(asset.id) : null;
  const tiles = thumbStrip(thumbs, 8);
  const peaks = waveform
    ? waveformColumns(
        waveform,
        fps,
        0,
        asset.duration_f ?? Math.round((waveform.peaks.length * fps.num) / (waveform.points_per_second * fps.den)),
        WAVE_COLUMNS,
      )
    : [];
  const command = formatCommand([
    "proxy",
    "build",
    asset.id,
    ...(wantsThumbs ? ["--thumbs"] : []),
    ...(wantsWaveform ? ["--waveform"] : []),
  ]);

  return (
    <>
      <h3>サムネイル・波形</h3>
      {thumbs && tiles.length > 0 ? (
        <div className="thumb-strip">
          {tiles.map((t) => (
            <div
              key={t.index}
              className="tile"
              title={`f:${t.index * thumbs.interval_f}`}
              style={tileStyle(thumbs, t, asset.id, STRIP_SCALE)}
            />
          ))}
        </div>
      ) : null}
      {peaks.length > 0 ? (
        <svg
          className="waveform"
          viewBox={`0 0 ${WAVE_COLUMNS} ${WAVE_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label="波形"
        >
          <title>波形</title>
          <path d={wavePath(peaks, WAVE_HEIGHT)} />
        </svg>
      ) : null}
      {(wantsThumbs && !thumbs) || (wantsWaveform && !waveform) ? (
        <p className="hint-note">
          未生成です。<code>{command}</code>
        </p>
      ) : null}
    </>
  );
}
