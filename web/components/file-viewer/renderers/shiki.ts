/**
 * Shiki highlighter: `shiki/core` + the JS regex engine + lazy per-language
 * grammars. NEVER imports `shiki/bundle/*` (hundreds of KB → 1 MB);
 * each grammar is its own dynamic import, code-split into its own chunk and
 * loaded on first use.
 *
 * The grammar imports MUST be static specifiers (a loader map), NOT a
 * template-literal `import(\`@shikijs/langs/${lang}\`)`: webpack can't build a
 * context module across a package `exports` map, so the template form fails with
 * "Module not found: Can't resolve '@shikijs/langs'" and every file silently
 * falls back to plain text. Verified against the live dev server 2026-06-11.
 *
 * Dual `github-light`/`github-dark` themes: the app hardcodes `dark` today, so
 * the light vars sit dormant at zero grammar cost and a future light mode is free.
 */

import { type HighlighterCore, createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/** ext → shiki language id. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  php: "php",
  py: "python",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  rb: "ruby",
  go: "go",
  rs: "rust",
  css: "css",
  scss: "scss",
  less: "less",
  toml: "toml",
  ini: "ini",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  lua: "lua",
  pl: "perl",
  r: "r",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  graphql: "graphql",
  proto: "proto",
  yaml: "yaml",
  yml: "yaml",
  json: "json",
  jsonl: "json",
  jsonc: "jsonc",
  html: "html",
  htm: "html",
  xml: "xml",
};

type LangModule = { default: Parameters<HighlighterCore["loadLanguage"]>[0] };

/** lang id → static dynamic-import loader. Each value is a fixed specifier so
 * webpack resolves + code-splits it. Adding a language = one line here + a
 * mapping in EXT_TO_LANG. */
const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import("@shikijs/langs/typescript") as Promise<LangModule>,
  tsx: () => import("@shikijs/langs/tsx") as Promise<LangModule>,
  javascript: () => import("@shikijs/langs/javascript") as Promise<LangModule>,
  jsx: () => import("@shikijs/langs/jsx") as Promise<LangModule>,
  php: () => import("@shikijs/langs/php") as Promise<LangModule>,
  python: () => import("@shikijs/langs/python") as Promise<LangModule>,
  sql: () => import("@shikijs/langs/sql") as Promise<LangModule>,
  bash: () => import("@shikijs/langs/bash") as Promise<LangModule>,
  ruby: () => import("@shikijs/langs/ruby") as Promise<LangModule>,
  go: () => import("@shikijs/langs/go") as Promise<LangModule>,
  rust: () => import("@shikijs/langs/rust") as Promise<LangModule>,
  css: () => import("@shikijs/langs/css") as Promise<LangModule>,
  scss: () => import("@shikijs/langs/scss") as Promise<LangModule>,
  less: () => import("@shikijs/langs/less") as Promise<LangModule>,
  toml: () => import("@shikijs/langs/toml") as Promise<LangModule>,
  ini: () => import("@shikijs/langs/ini") as Promise<LangModule>,
  c: () => import("@shikijs/langs/c") as Promise<LangModule>,
  cpp: () => import("@shikijs/langs/cpp") as Promise<LangModule>,
  java: () => import("@shikijs/langs/java") as Promise<LangModule>,
  kotlin: () => import("@shikijs/langs/kotlin") as Promise<LangModule>,
  swift: () => import("@shikijs/langs/swift") as Promise<LangModule>,
  lua: () => import("@shikijs/langs/lua") as Promise<LangModule>,
  perl: () => import("@shikijs/langs/perl") as Promise<LangModule>,
  r: () => import("@shikijs/langs/r") as Promise<LangModule>,
  vue: () => import("@shikijs/langs/vue") as Promise<LangModule>,
  svelte: () => import("@shikijs/langs/svelte") as Promise<LangModule>,
  astro: () => import("@shikijs/langs/astro") as Promise<LangModule>,
  graphql: () => import("@shikijs/langs/graphql") as Promise<LangModule>,
  proto: () => import("@shikijs/langs/proto") as Promise<LangModule>,
  yaml: () => import("@shikijs/langs/yaml") as Promise<LangModule>,
  json: () => import("@shikijs/langs/json") as Promise<LangModule>,
  jsonc: () => import("@shikijs/langs/jsonc") as Promise<LangModule>,
  html: () => import("@shikijs/langs/html") as Promise<LangModule>,
  xml: () => import("@shikijs/langs/xml") as Promise<LangModule>,
};

/** Resolve an ext (or bare lang id) to a loadable shiki language id, or null
 * when we have no grammar for it (caller falls back to plain text). */
export function langForExt(ext: string): string | null {
  const lang = EXT_TO_LANG[ext.toLowerCase()] ?? ext.toLowerCase();
  return LANG_LOADERS[lang] ? lang : null;
}

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import("@shikijs/themes/github-dark"), import("@shikijs/themes/github-light")],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/** Dynamic-import + register one grammar on demand. Returns the lang id if
 * loaded (or already present), null if there's no loader / the import fails. */
async function ensureLang(hl: HighlighterCore, lang: string): Promise<string | null> {
  if (loadedLangs.has(lang)) return lang;
  const loader = LANG_LOADERS[lang];
  if (!loader) return null;
  try {
    const mod = await loader();
    await hl.loadLanguage(mod.default);
    loadedLangs.add(lang);
    return lang;
  } catch {
    return null;
  }
}

/**
 * Highlight `code` in `lang`, returning a themed HTML string (dual-theme CSS
 * vars). Returns null when no grammar is available; the renderer then shows
 * plain text. The HTML is Shiki-generated (escaped tokens only), not file
 * content interpolated raw, so it's safe to inject.
 */
export async function highlightToHtml(code: string, lang: string): Promise<string | null> {
  const resolvedLang = langForExt(lang);
  if (!resolvedLang) return null;
  const hl = await getHighlighter();
  const ok = await ensureLang(hl, resolvedLang);
  if (!ok) return null;
  return hl.codeToHtml(code, {
    lang: resolvedLang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: "dark",
  });
}
