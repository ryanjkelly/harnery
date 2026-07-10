---
"harnery": minor
---

Add a shared YAML-frontmatter parser for lifecycle docs (`src/lib/docs-frontmatter.ts`). `parseFrontmatter` splits a leading `---` block (tolerating BOM/CRLF, never throwing on bad YAML, using `JSON_SCHEMA` so dates stay strings). `readDocStatus`/`readDocStatusFromText` dual-read status — preferring YAML `status:` and falling back to the legacy `**Status:**` bold line — with `normalizeStatus` collapsing token variants (`in_progress`/`WIP` → `in-progress`, done-family → `shipped` for plans or `resolved` for issues/handoffs, `wont-fix` → `wontfix`) and trailing-note stripping. Groundwork for standardizing company docs on frontmatter; not yet wired into `docs sweep`/`docs lint`.
