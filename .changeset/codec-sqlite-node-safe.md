---
"harnery": patch
---

Codex archive reads now lazy-load `bun:sqlite` so Node importers (the dashboard) can load the module and fail closed instead of crashing at import. The Bun CLI path still opens the database the same way.
