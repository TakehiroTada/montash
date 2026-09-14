/**
 * 決定的な JSON シリアライズと内容ハッシュ。
 *
 * object のキーをソートして `JSON.stringify` する。配列は順序を保つ。
 * `undefined` な値は JSON.stringify と同様に object からは省き、配列では null になる。
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** キーをソートした新しい値を作る（JSON.stringify がそのまま決定的になる） */
function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalize(v)));
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    if (v === undefined) continue;
    out[key] = normalize(v);
  }
  return out;
}

/** `"sha1:" + sha1(canonicalJson(value))`（docs/11 §3.1 objects の内容アドレス） */
export function canonicalHash(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(canonicalJson(value));
  return `sha1:${hasher.digest("hex")}`;
}

export type HashFn = (value: unknown) => string;
