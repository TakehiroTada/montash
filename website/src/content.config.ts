import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";

// docs: ページ本体（src/content/docs/<lang>/**）
// i18n: Starlight の UI 文字列の上書き（src/content/i18n/<lang>.json）。日本語・英語とも
//       Starlight が翻訳を同梱しているので中身は空で構わないが、コレクション自体は定義しておく。
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
