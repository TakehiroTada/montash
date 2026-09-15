/**
 * `montash-plugin.json` の検証（docs/14）。
 *
 * マニフェストが「正」で、モジュール側の `id` / `apiVersion` と食い違う場合はマニフェストを採る。
 * 読み込む前にここで弾けるものは弾き、**任意コードを評価する前に** ID と API バージョンを確かめる。
 */
import { z } from "zod";
import { MontashError } from "../cli/errors.ts";
import { MIN_PLUGIN_API_VERSION, PLUGIN_API_VERSION, type PluginManifest } from "./types.ts";

const FeatureRequirementsSchema = z.looseObject({
  filters: z.array(z.string()).optional(),
  encoders: z.array(z.string()).optional(),
  recommendedFilters: z.array(z.string()).optional(),
});

/** 逆ドメイン形式。ファイル名やディレクトリ名として安全な文字だけ */
const PLUGIN_ID = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const PluginManifestSchema = z.looseObject({
  id: z.string().regex(PLUGIN_ID, "plugin id must look like com.example.name"),
  name: z.string().optional(),
  version: z.string().optional(),
  apiVersion: z.int().positive(),
  description: z.string().optional(),
  main: z.string().optional(),
  requires: FeatureRequirementsSchema.optional(),
  capabilities: z.array(z.enum(["analyze", "process"])).optional(),
  webAllow: z.array(z.string()).optional(),
});

export function parseManifest(raw: unknown, source: string): PluginManifest {
  const parsed = PluginManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MontashError(
      "E_PLUGIN_INVALID",
      `${source}: ${issue ? `/${issue.path.join("/")} ${issue.message}` : "is not a valid plugin manifest"}`,
      {
        hint: "A plugin manifest needs at least { id, apiVersion }.",
        detail: { source },
      },
    );
  }
  return parsed.data as PluginManifest;
}

/**
 * ホストが受け入れられる API バージョンか（docs/13 C-10）。
 * 新しすぎる（ホストが知らない）／古すぎる（もう支えない）のどちらも導入を拒否する。
 */
export function assertCompatible(manifest: PluginManifest, source: string): void {
  const v = manifest.apiVersion;
  if (v >= MIN_PLUGIN_API_VERSION && v <= PLUGIN_API_VERSION) return;
  const tooNew = v > PLUGIN_API_VERSION;
  throw new MontashError(
    "E_PLUGIN_INCOMPATIBLE",
    `plugin "${manifest.id}" requires plugin API v${v}; this montash supports v${MIN_PLUGIN_API_VERSION}..v${PLUGIN_API_VERSION}`,
    {
      hint: tooNew
        ? "Upgrade montash, or install a build of the plugin for this version."
        : "The plugin is too old for this montash. Ask its author for an update.",
      detail: { plugin: manifest.id, required: v, supported: [MIN_PLUGIN_API_VERSION, PLUGIN_API_VERSION], source },
    },
  );
}
