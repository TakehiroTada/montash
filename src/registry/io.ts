/**
 * 入出力レジストリ（docs/14、計画 P3-1）。
 *
 * AviUtl2 の入力プラグイン（.aui2）/ 出力プラグイン（.auo2）に相当する拡張点。
 *
 * - **importer**: 拡張子 → アセットの作り方。「この形式をどう読むか」を差し替える
 * - **exporter**: 出力プリセットの供給元。`render_presets` の一般化
 *
 * importer は **`probe()` の結果からアセットのフィールドを組み立てる純関数**として書く。
 * ファイルを自分で読む必要がある場合（字幕やテキストのように中身を解釈するもの）は
 * ホストが渡す `read()` を使う。**プラグインが任意のパスを読むことはできない**
 * （対象は取り込もうとしているファイルに限られる）。
 */
import { MontashError } from "../cli/errors.ts";
import { createRegistry, type Registry } from "./index.ts";

// ---------------------------------------------------------------------------
// importer
// ---------------------------------------------------------------------------

/** importer に渡る文脈。I/O はホストが仲介する */
export interface ImporterContext {
  /** 取り込むファイルの絶対パス（表示・拡張子判定用。直接開かない） */
  readonly path: string;
  /** 拡張子（小文字、ドット無し） */
  readonly extension: string;
  /** 取り込み対象のファイルを読む（**このファイルだけ**。他のパスは読めない） */
  read(encoding?: "utf8"): Promise<string>;
  /** ffprobe をかける（映像・音声・画像用）。失敗時は E_ASSET_UNREADABLE */
  probe(): Promise<{ summary: Record<string, unknown>; raw: unknown }>;
  /** プロジェクトの fps（`duration_f` の算出に使う） */
  readonly fps: { num: number; den: number };
  /** 秒 → フレーム（プロジェクト fps 基準で丸める） */
  toFrames(seconds: number): number;
}

/**
 * importer が返すアセットの中身（`id` / `path` / `owned` などの共通部分はホストが足す）。
 * `type` は `AssetSchema` の判別キー。
 */
export type ImportedAsset = Record<string, unknown> & { type: string };

export interface ImporterSpec {
  name: string;
  summary: string;
  /** 受け持つ拡張子（小文字、ドット無し）。先に登録された方が優先 */
  extensions: readonly string[];
  /** 必要な ffmpeg 機能 */
  requires?: readonly string[];
  /** ファイル → アセットの中身（純関数ではないが、I/O は ctx 経由に限る） */
  build(ctx: ImporterContext): Promise<ImportedAsset>;
}

export function defineImporter(spec: ImporterSpec): ImporterSpec {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new Error(`invalid importer name: "${spec.name}"`);
  if (spec.extensions.length === 0) throw new Error(`importer "${spec.name}" must claim at least one extension`);
  return spec;
}

export const importers: Registry<ImporterSpec> = createRegistry<ImporterSpec>({
  label: "importer",
  sorted: true,
  notFound: (name, known) =>
    new MontashError("E_PLUGIN_MISSING", `unknown importer '${name}'`, {
      hint: known.length > 0 ? `Known importers: ${known.join(", ")}.` : undefined,
      detail: { importer: name },
    }),
});

/** 拡張子 → importer。無ければ null（呼び出し側が既定の probe 経路に落とす） */
export function importerFor(extension: string): ImporterSpec | null {
  const ext = extension.toLowerCase();
  for (const entry of importers.entries()) {
    if (entry.value.extensions.includes(ext)) return entry.value;
  }
  return null;
}

export function registerImporter(spec: ImporterSpec, source: "builtin" | "plugin" = "builtin"): void {
  importers.register(spec.name, spec, source);
}

// ---------------------------------------------------------------------------
// 組み込み importer
//
// 既存の `import` コマンドの分岐をそのまま移したもの。**出力は 1 フィールドも変えない**。
// ---------------------------------------------------------------------------

/** プレーンテキスト（テロップの定型文など） */
export const textImporter: ImporterSpec = defineImporter({
  name: "text",
  summary: "plain text (.txt / .md)",
  extensions: ["txt", "md"],
  async build(ctx) {
    const text = await ctx.read("utf8");
    return {
      type: "text",
      duration_s: null,
      duration_f: null,
      text_preview: text.slice(0, 200),
      line_count: text.split(/\r?\n/).length,
    };
  },
});

/** 字幕ファイル */
export const subtitleImporter: ImporterSpec = defineImporter({
  name: "subtitle",
  summary: "subtitle files (.srt / .ass / .vtt)",
  extensions: ["srt", "ass", "vtt"],
  async build(ctx) {
    return { type: "subtitle", format: ctx.extension };
  },
});

/**
 * 映像・音声・画像（ffprobe に任せる）。
 * 拡張子を列挙しないため `importerFor()` では引けず、**どの importer も名乗り出なかったときの既定**として使う。
 */
export const mediaImporter: ImporterSpec = defineImporter({
  name: "media",
  summary: "video / audio / image (probed with ffprobe)",
  extensions: ["*"],
  async build(ctx) {
    const probe = await ctx.probe();
    const { container, ...summary } = probe.summary as {
      container: { format: string; bit_rate?: number | null };
      duration_s: number | null;
    } & Record<string, unknown>;
    return {
      ...summary,
      type: String(summary.type ?? "video"),
      container: {
        format: container.format,
        ...(container.bit_rate === null || container.bit_rate === undefined ? {} : { bit_rate: container.bit_rate }),
      },
      duration_f: summary.duration_s === null ? null : ctx.toFrames(summary.duration_s),
    };
  },
});

registerImporter(textImporter);
registerImporter(subtitleImporter);
registerImporter(mediaImporter);

/** 既定（拡張子を主張する importer が無いとき）に使う importer */
export const DEFAULT_IMPORTER = mediaImporter.name;
