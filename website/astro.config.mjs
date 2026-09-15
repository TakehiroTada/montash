// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// サイドバーのラベルは translations で日英を出し分ける。
// slug は言語プレフィックス（ja/ en/）を含めずに書くと Starlight が現在の言語に解決する。
export default defineConfig({
  // 公開先が決まったら site（と必要なら base）を設定する。website/README.md を参照。
  // ja / en ともに言語プレフィックスを持つ構成なので、ルートは既定言語へ飛ばす。
  redirects: { "/": "/ja/" },
  integrations: [
    starlight({
      title: "montash",
      description: "AI が CLI だけで動画編集を完結させるための動画編集ソフト",
      defaultLocale: "ja",
      locales: {
        ja: { label: "日本語", lang: "ja" },
        en: { label: "English", lang: "en" },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/TakehiroTada/montash",
        },
      ],
      head: [
        {
          tag: "meta",
          attrs: { property: "og:type", content: "website" },
        },
      ],
      editLink: {
        baseUrl: "https://github.com/TakehiroTada/montash/edit/main/website/",
      },
      lastUpdated: true,
      sidebar: [
        {
          label: "ガイド",
          translations: { en: "Guides" },
          items: [
            { slug: "guides/introduction" },
            { slug: "guides/installation" },
            { slug: "guides/quickstart" },
            { slug: "guides/editing" },
            { slug: "guides/transitions-and-text" },
            { slug: "guides/audio" },
            { slug: "guides/preview-and-web" },
            { slug: "guides/history" },
            { slug: "guides/rendering" },
            { slug: "guides/ai-usage" },
          ],
        },
        {
          label: "リファレンス",
          translations: { en: "Reference" },
          items: [
            { slug: "reference/cli" },
            { slug: "reference/project-file" },
            { slug: "reference/glossary" },
          ],
        },
        {
          label: "開発に参加する",
          translations: { en: "Contributing" },
          slug: "contributing",
        },
        {
          label: "ライセンス",
          translations: { en: "License" },
          slug: "license",
        },
      ],
    }),
  ],
});
