---
"harnery": minor
---

Install `harn-decide`, `harn-council`, and the new `harn-end` skill for Claude
Code, Cursor, and Codex during `harn init`. Cursor and Codex use the shared
`.agents/skills/` root; Claude Code uses `.claude/skills/`. Drift checks and
deinit now cover the selected adapter's installed skills, and no unprefixed
aliases are created.
