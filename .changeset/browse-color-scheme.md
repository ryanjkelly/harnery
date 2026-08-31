---
"harnery": minor
---

Add `--color-scheme <light|dark>` to `browse`: emulates `prefers-color-scheme` for the whole session (threaded to Playwright's context colorScheme), so theme-aware pages render in either scheme without page-specific toggles. Absent flag keeps today's behavior.
