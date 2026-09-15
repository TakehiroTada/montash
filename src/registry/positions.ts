/**
 * 位置プリセットのレジストリ（docs/07 §5, §6.2、docs/13 D-16）。
 *
 * 「画面のどこに置くか」は **overlay（トラック間合成）と ASS（テキスト・字幕）で同じ概念**なのに、
 * かつては `graph/overlay.ts` の座標式テーブル（9 種）と `ass.ts` の `\an` テーブル（10 種）に
 * 分かれていた。ここでは **1 エントリが両方を持つ**（`overlay` の座標式と ASS の `\an`）形に統合し、
 * overlay とテキストが同じ名前集合を受け付けるようにしてある。
 *
 * どちらか一方でしか意味を持たない位置は無い（3x3 グリッドの 9 セルはどちらでも表せる）ので、
 * `PositionSpec` では `overlay` と `an` を**どちらも必須**にしている。旧テーブルの名前の食い違い
 * （overlay は `center-left` / `center-right`、ASS は `middle-left` / `middle-right` / `middle-center`）は
 * **別名**として残してあり、`aliasOf` で正規名を引ける。
 *
 * - `an`（テンキー配置 7 8 9 / 4 5 6 / 1 2 3）と overlay の座標式は、どちらも `row` / `column` から導く。
 *   手で 2 つの表を書かないので、両者がずれることが構造的に起きない。
 * - `W/H` は base（出力）のサイズ、`w/h` は overlay 素材のサイズ。`{m}` は `--margin`（px 式）。
 *
 * このファイルは純関数だけを持つ（`ffmpeg/graph/` から import されるため）。
 */
import { createRegistry } from "./index.ts";

export type PositionRow = "top" | "middle" | "bottom";
export type PositionColumn = "left" | "center" | "right";

/** overlay の `x` / `y` 式を作る。引数は解決済みのマージン式 */
export type OverlayExpr = (margin: string) => { x: string; y: string };

export interface PositionSpec {
  /** 3x3 グリッドの行 */
  row: PositionRow;
  /** 3x3 グリッドの列 */
  column: PositionColumn;
  /** ASS のテンキー配置（`\an`。7 8 9 / 4 5 6 / 1 2 3） */
  an: number;
  /** overlay=x=…:y=… の座標式（docs/07 §5 の表） */
  overlay: OverlayExpr;
  /** 別名なら正規名。正規エントリでは undefined */
  aliasOf?: string;
}

// ---------------------------------------------------------------------------
// 3x3 グリッド
// ---------------------------------------------------------------------------

const ROW_BASE: Readonly<Record<PositionRow, number>> = { top: 6, middle: 3, bottom: 0 };
const COLUMN_OFFSET: Readonly<Record<PositionColumn, number>> = { left: 1, center: 2, right: 3 };

/** `\an` を行・列から導く（docs/07 §6.2） */
export function anOf(row: PositionRow, column: PositionColumn): number {
  return ROW_BASE[row] + COLUMN_OFFSET[column];
}

function overlayExpr(row: PositionRow, column: PositionColumn): OverlayExpr {
  return (m) => ({
    x: column === "left" ? m : column === "right" ? `W-w-${m}` : "(W-w)/2",
    y: row === "top" ? m : row === "bottom" ? `H-h-${m}` : "(H-h)/2",
  });
}

interface GridCell {
  name: string;
  row: PositionRow;
  column: PositionColumn;
  /** 旧テーブル由来の別名（overlay 側 / ASS 側で綴りが違ったもの） */
  aliases?: readonly string[];
}

/** 正規名 9 種（読む順）。別名は `aliases` に置く */
const GRID: readonly GridCell[] = [
  { name: "top-left", row: "top", column: "left" },
  { name: "top-center", row: "top", column: "center" },
  { name: "top-right", row: "top", column: "right" },
  { name: "middle-left", row: "middle", column: "left", aliases: ["center-left"] },
  { name: "center", row: "middle", column: "center", aliases: ["middle-center"] },
  { name: "middle-right", row: "middle", column: "right", aliases: ["center-right"] },
  { name: "bottom-left", row: "bottom", column: "left" },
  { name: "bottom-center", row: "bottom", column: "center" },
  { name: "bottom-right", row: "bottom", column: "right" },
];

function buildBuiltins(): Record<string, PositionSpec> {
  const out: Record<string, PositionSpec> = {};
  for (const cell of GRID) {
    const spec: PositionSpec = {
      row: cell.row,
      column: cell.column,
      an: anOf(cell.row, cell.column),
      overlay: overlayExpr(cell.row, cell.column),
    };
    out[cell.name] = spec;
    for (const alias of cell.aliases ?? []) out[alias] = { ...spec, aliasOf: cell.name };
  }
  return out;
}

/**
 * 位置プリセットのレジストリ。`names()` は別名も含む全 12 種を返す。
 * 人間向けの一覧（`--help` / hint）には正規名だけを出す `POSITION_NAMES` を使う。
 */
export const positions = createRegistry<PositionSpec>({
  label: "position preset",
  builtin: buildBuiltins(),
});

/** 正規名 9 種（`--help` と hint に出す一覧） */
export const POSITION_NAMES: readonly string[] = GRID.map((c) => c.name);

/** 別名（旧 overlay / ASS のテーブルで綴りが違ったもの） */
export const POSITION_ALIASES: readonly string[] = GRID.flatMap((c) => c.aliases ?? []);

/** 既定の位置（`--position` 省略時） */
export const DEFAULT_POSITION = "center";

/** 名前で引く（完全一致。呼び出し側の大文字小文字の扱いは従来どおり各所に任せる） */
export function positionSpec(name: string): PositionSpec | undefined {
  return positions.get(name);
}

/** 既知の位置プリセット名か（別名を含む） */
export function isPositionName(name: string): boolean {
  return positions.has(name);
}
