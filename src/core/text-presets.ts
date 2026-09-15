/**
 * 組み込みテキストプリセット（docs/05 §9, docs/04 §9）。
 *
 * 組み込みの 4 種はバイナリ側（ここ）に持ち、`project.json` の `text_presets` は
 * **上書き・追加のみ**を行う（docs/05 §9）。上書きはキー単位の浅いマージで、
 * ユーザーが指定したフィールドだけが組み込み値を置き換える。
 *
 * プリセットの `fade` はフレームで持つため、fps 変更時は §2.1 の再スナップ対象になる。
 */
import { MontashError } from "../cli/errors.ts";
import { createRegistry, type RegistrySource } from "../registry/index.ts";
import type { Project, TextPreset } from "./schema.ts";

/** 組み込みプリセット（docs/05 §9 の表をそのまま写したもの） */
export const BUILTIN_TEXT_PRESETS: Readonly<Record<string, TextPreset>> = Object.freeze({
  "title-center": {
    size: 96,
    position: "center",
    align: "center",
    bg: null,
    fade: { in_f: 15, out_f: 15 },
    outline: { width: 2, color: "#000000" },
  },
  "lower-third": {
    size: 48,
    position: { x: "5%", y: "85%" },
    align: "left",
    bg: "#00000099",
    bg_padding: 12,
  },
  "caption-bottom": {
    size: 40,
    position: "bottom-center",
    align: "center",
    bg: "#00000080",
    wrap: true,
  },
  "corner-tag": {
    size: 32,
    position: "top-right",
    align: "right",
    bg: "#00000080",
  },
});

export interface TextPresetEntry {
  name: string;
  preset: TextPreset;
  /** builtin: 組み込みのみ / project: プロジェクト独自 / overridden: 組み込みを上書き / plugin: Phase 2 */
  source: RegistrySource | "overridden";
}

/**
 * 組み込み + 外部由来のマージは `registry/` の共通基盤に載せてある（docs/13 D-16）。
 * ここでの外部由来は `project.text_presets` の 1 種だけなので `source` は `project`、
 * 組み込みを置き換えたものは表示上 `overridden` にする（従来どおり）。
 */
const registry = createRegistry<TextPreset>({
  label: "text preset",
  builtin: BUILTIN_TEXT_PRESETS,
  sorted: true,
  notFound: (name, known) =>
    new MontashError("E_PRESET_NOT_FOUND", `text preset "${name}" not found`, {
      hint: `Use \`montash text presets\` to list them (${known.join(", ")}).`,
      detail: { preset: name, known_presets: [...known] },
    }),
});

/** 組み込み + `project.text_presets`（上書き・追加）を名前順に解決する */
export function resolveTextPresets(project: Pick<Project, "text_presets">): TextPresetEntry[] {
  return registry
    .resolve(project.text_presets ?? {})
    .entries()
    .map((e) => ({
      name: e.name,
      preset: { ...e.value },
      source: e.overridden ? "overridden" : e.source,
    }));
}

/** 名前でプリセットを引く。無ければ E_PRESET_NOT_FOUND（hint に一覧） */
export function requireTextPreset(project: Pick<Project, "text_presets">, name: string): TextPreset {
  return { ...registry.resolve(project.text_presets ?? {}).require(name) };
}
