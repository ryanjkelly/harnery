---
"harnery": patch
---

Cache complete V3 ledger reads by storage identity and validate only newly
appended active-ledger frames, while retaining full fallback checks for
rewrites, replacements, catalog changes, and corrupt frames.
