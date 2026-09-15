/**
 * 派生データ（サムネイル・波形）が届いたら再描画するためのフック。
 * キャッシュは zustand の外（lib/derived.ts）にあるので、React 側は届いたことだけを購読する。
 */
import { useEffect, useState } from "react";
import { onDerivedLoaded } from "../lib/derived.ts";

export function useDerivedTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => onDerivedLoaded(() => setTick((n) => n + 1)), []);
  return tick;
}
