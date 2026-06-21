---
"harnery": patch
---

Fix the published CLI failing to boot on Node. `outline` statically imported
`typescript` and the readability lib statically imported `jsdom` at module top
level; since every command is registered eagerly at startup, an end user who
installed harnery without dev deps hit `ERR_MODULE_NOT_FOUND` (typescript) or
`ERR_REQUIRE_ESM` (jsdom's dependency tree) on any command, including
`harn --version`. Both heavy deps now load lazily inside the command that needs
them: `outline` resolves `typescript` only when outlining a TS/JS file (PHP and
Python keep working without it, and a missing `typescript` degrades to a clear
install hint instead of a crash), and `htmlToMarkdown` resolves jsdom,
readability, and turndown on first use. `htmlToMarkdown` is now async as a
result. `harn read` itself still depends on jsdom and remains affected by an
upstream jsdom ESM-resolution bug on Node; that is tracked separately.
