// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://harnery.com",
  integrations: [
    starlight({
      title: "Harnery",
      logo: { src: "./src/assets/harnery-emblem.svg", alt: "Harnery" },
      favicon: "/favicon.svg",
      description:
        "Multi-agent coordination + harness adapters + portable CLI utilities.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/ryanjkelly/harnery",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/ryanjkelly/harnery/edit/main/docs/",
      },
      sidebar: [
        {
          label: "Getting started",
          items: [{ autogenerate: { directory: "getting-started" } }],
        },
        {
          label: "CLI reference",
          items: [{ autogenerate: { directory: "cli" } }],
        },
        {
          label: "Concepts",
          items: [{ autogenerate: { directory: "concepts" } }],
        },
        {
          label: "Reference",
          items: [{ autogenerate: { directory: "reference" } }],
        },
        { label: "Brand", link: "/brand/" },
        {
          label: "Decisions",
          collapsed: true,
          items: [{ autogenerate: { directory: "decisions" } }],
        },
      ],
      customCss: ["./src/styles/brand.css"],
      lastUpdated: true,
    }),
  ],
});
