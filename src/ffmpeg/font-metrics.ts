/**
 * フォントファイルから「libass の Fontsize 1px あたり何 em 分の字が出るか」を読む
 * （docs/04 §9 `--fit-width`）。
 *
 * ASS の `Fontsize` は **em ボックスの大きさではない**。libass は VSFilter に合わせて
 * 「OS/2 の `usWinAscent + usWinDescent` が Fontsize になる」ように字を縮める。
 * CJK フォントはこの値が em の 1.25〜1.45 倍あるので、`Fontsize: 100` で描いても
 * 全角 1 文字の送りは 100px ではなく **約 80px** にしかならない。実測で確かめた値:
 *
 * | フォント | `upem / (winAscent + winDescent)` | 実測した送り（Fontsize 100） |
 * |---|---|---|
 * | Hiragino Sans | 0.7955 | 全角 1 文字 79.8px |
 * | Helvetica | 0.8509 | `W` 80.4px（AFM 0.944em × 0.851 = 80.3） |
 *
 * この係数を掛けないと、幅フィットは常に 2 割ほど小さい字を選んでしまう。**フォントファイルの
 * 数百バイトを読むだけ**なので外部依存は増えない（docs/14「やらないこと」）。
 *
 * 解釈（`sizeScaleFromTables`）は **バイト列を受け取る純関数**にしてあり、ファイル読みは
 * `fontSizeScale()` 側に閉じている（montash の作法。docs/08）。
 */

/** OS/2 も hhea も読めなかったときに使う係数（等倍 = 安全側に小さめの字を選ぶ） */
export const FALLBACK_SIZE_SCALE = 1;
/** テーブル表を読むために先頭から取る長さ（ディレクトリはヘッダ直後にある） */
const DIRECTORY_BYTES = 64 * 1024;

function u16(b: Uint8Array, at: number): number {
  return ((b[at] as number) << 8) | (b[at + 1] as number);
}

function i16(b: Uint8Array, at: number): number {
  const v = u16(b, at);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function u32(b: Uint8Array, at: number): number {
  return (
    (b[at] as number) * 0x1000000 + ((b[at + 1] as number) << 16) + ((b[at + 2] as number) << 8) + (b[at + 3] as number)
  );
}

function tagAt(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at] as number, b[at + 1] as number, b[at + 2] as number, b[at + 3] as number);
}

/**
 * sfnt（`ttf` / `otf`）または ttc 先頭フェイスのテーブル表を読む（純関数）。
 * ttc は同じ ttc 内のウェイト違いで係数がほぼ変わらないので先頭フェイスだけ見る。
 */
export function parseTableDirectory(header: Uint8Array): Map<string, number> | null {
  if (header.length < 12) return null;
  let base = 0;
  if (tagAt(header, 0) === "ttcf") {
    if (header.length < 16) return null;
    if (u32(header, 8) < 1) return null;
    base = u32(header, 12);
  }
  if (base + 12 > header.length) return null;
  const numTables = u16(header, base + 4);
  if (numTables === 0 || base + 12 + numTables * 16 > header.length) return null;
  const offsets = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    offsets.set(tagAt(header, rec), u32(header, rec + 8));
  }
  return offsets;
}

/** `head` の `unitsPerEm`（純関数） */
export function parseUnitsPerEm(head: Uint8Array): number | null {
  if (head.length < 20) return null;
  const upem = u16(head, 18);
  return upem > 0 ? upem : null;
}

/** `OS/2` の `usWinAscent + usWinDescent`（純関数） */
export function parseWinHeight(os2: Uint8Array): number | null {
  if (os2.length < 78) return null;
  const height = u16(os2, 74) + u16(os2, 76);
  return height > 0 ? height : null;
}

/** `hhea` の `ascender - descender`（純関数） */
export function parseHheaHeight(hhea: Uint8Array): number | null {
  if (hhea.length < 10) return null;
  const height = i16(hhea, 4) - i16(hhea, 6);
  return height > 0 ? height : null;
}

/** バイト列を一部だけ読むための口（テストでは配列を包むだけで足りる） */
export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>;

/**
 * libass の描画スケール（Fontsize 1px あたりの em 数）を求める。
 * `usWinAscent + usWinDescent` を優先し、無ければ hhea の `ascender - descender` を使う。
 */
export async function readSizeScale(read: ByteReader): Promise<number | null> {
  const offsets = parseTableDirectory(await read(0, DIRECTORY_BYTES));
  if (!offsets) return null;
  const headOffset = offsets.get("head");
  if (headOffset === undefined) return null;
  const upem = parseUnitsPerEm(await read(headOffset, 54));
  if (upem === null) return null;

  const os2Offset = offsets.get("OS/2");
  if (os2Offset !== undefined) {
    const height = parseWinHeight(await read(os2Offset, 96));
    if (height !== null) return upem / height;
  }
  const hheaOffset = offsets.get("hhea");
  if (hheaOffset !== undefined) {
    const height = parseHheaHeight(await read(hheaOffset, 36));
    if (height !== null) return upem / height;
  }
  return null;
}

/** 同じフォントファイルを何度も読まないためのキャッシュ（プロセス内） */
const cache = new Map<string, number>();

/** テスト用: キャッシュを捨てる */
export function __clearFontMetricsCache(): void {
  cache.clear();
}

/** フォントファイルを読んで描画スケールを返す。読めないフォントは `FALLBACK_SIZE_SCALE` */
export async function fontSizeScale(path: string): Promise<number> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  let scale = FALLBACK_SIZE_SCALE;
  try {
    const file = Bun.file(path);
    const read: ByteReader = async (offset, length) =>
      new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    scale = (await readSizeScale(read)) ?? FALLBACK_SIZE_SCALE;
  } catch {
    scale = FALLBACK_SIZE_SCALE;
  }
  cache.set(path, scale);
  return scale;
}
