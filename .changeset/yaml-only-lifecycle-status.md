---
"harnery": minor
---

Require lifecycle status in leading YAML frontmatter across `docs lint`, `docs sweep`, and `docs index`. Legacy `**Status:**` lines are no longer read by those consumers; `docs frontmatter-migrate` remains available as the explicit one-shot conversion path. Lint now checks plans, issues, handoffs, and archived plans, and reports missing YAML status as an error.
