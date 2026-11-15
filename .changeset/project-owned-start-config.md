---
"harnery": patch
---

Read dashboard start commands only from the project config. User-global and
machine-local files can still tune the startup timeout, but cannot select an
executable. This replaces the broader command layering described in ADR 0253
with the project authority boundary from ADR 0254.

Centralize end-turn sync, status style, dashboard startup, and docket sharing
settings in the cached config reader. Keep their other layer rules and env
overrides unchanged, and document the project-only exceptions.
