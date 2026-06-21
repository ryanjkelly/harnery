import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// Registers the Starlight `docs` collection. Without this, Astro 5 doesn't
// discover the content under src/content/docs/ and only the root page builds.
// Kept as .mjs (no TypeScript syntax needed) so it's loaded by Astro but not
// dragged into a bare `tsc` run, which would otherwise type-check Starlight's
// own raw .ts source. Typecheck Astro projects with `astro check`, not tsc.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
