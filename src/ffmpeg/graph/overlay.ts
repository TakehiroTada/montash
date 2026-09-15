/**
 * トラック間合成（docs/07 §5）。
 *
 * トラック配列順（下 → 上）に `overlay` を重ねる。上位トラックのクリップはタイムライン上の絶対位置に
 * 置く必要があるので、`setpts` で位置を合わせ、**base 側の出力フレーム番号 `n`** で `enable` する
 * （整数比較なので分数 fps でもずれない）。
 */
import { MontashError } from "../../cli/errors.ts";
import type { Resolution } from "../../core/schema.ts";
import { DEFAULT_POSITION, POSITION_NAMES, positions } from "../../registry/positions.ts";
import type { GraphContext, Stream } from "./types.ts";
import { sizeExpr } from "./video.ts";

export interface Transform {
  position: string | null;
  x: number | string | null;
  y: number | string | null;
  margin: number | string;
  scale: number;
  rotate: number;
}

export function overlayPosition(transform: Transform | null, res: Resolution): { x: string; y: string } {
  if (!transform) return { x: "(W-w)/2", y: "(H-h)/2" };
  if (transform.rotate) throw new MontashError("E_NOT_IMPLEMENTED", "clip rotation is not implemented yet");
  if (transform.x !== null || transform.y !== null) {
    return {
      x: transform.x === null ? "0" : sizeExpr(transform.x, String(res.width)),
      y: transform.y === null ? "0" : sizeExpr(transform.y, String(res.height)),
    };
  }
  const margin = sizeExpr(transform.margin, String(res.width));
  // 位置プリセットは ASS 側（`\an`）と同じレジストリ（docs/13 D-16）
  const spec = positions.get(transform.position ?? DEFAULT_POSITION);
  if (!spec)
    throw new MontashError("E_USAGE", `unknown position preset ${JSON.stringify(transform.position)}`, {
      hint: `Known presets: ${POSITION_NAMES.join(", ")}, or use x/y coordinates.`,
    });
  return spec.overlay(margin);
}

/**
 * base の `at` フレーム目から `overlay.frames` フレームぶん重ねる。
 * `eof_action=pass` + 出力側の `-frames:v` で最終フレームが残らないようにする（docs/07 §13）。
 */
export function overlayStream(
  ctx: GraphContext,
  base: Stream,
  overlay: Stream,
  at: number,
  position: { x: string; y: string },
): Stream {
  const shifted = at === 0 ? overlay.label : ctx.chain(overlay.label, [`setpts=PTS+${ctx.secs(at)}/TB`]);
  const label = ctx.chain(
    [base.label, shifted],
    [
      `overlay=x=${position.x}:y=${position.y}:enable='between(n,${at},${at + overlay.frames - 1})':eof_action=pass:shortest=0:format=auto`,
      ctx.tb,
    ],
  );
  return { label, frames: base.frames };
}
