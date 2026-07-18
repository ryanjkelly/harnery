---
"harnery": patch
---

The injected AGENTS.md coordination block now renders the scratch-journal category list from the canonical `SCRATCH_CATEGORIES` enum instead of a hardcoded prose list, which had silently drifted (it listed 5 of the 7 categories, omitting `question` and `done`). A test now locks the block to the full enum so it can't regress. Re-run `harn init` to pick up the corrected block (its version hash changes).
